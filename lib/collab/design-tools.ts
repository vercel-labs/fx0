// @ts-expect-error Node strip-types tests require the source extension.
import { validateDesignArtifactHtml } from '../design-artifact.ts'
import type { MessageMetadata, ToolResult } from './ampersand'
// @ts-expect-error Node strip-types tests require the source extension.
import { approvedNotice, MAX_REVIEW_SUMMARY_LENGTH, MAX_ROOM_REPLY_LENGTH, MAX_TEAM_MESSAGE_LENGTH, publishedNotice, seatTools, type ToolName } from './prompts.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { isBoundedText, teammateOf, type AgentActivity, type AgentSeat, type Message } from './types.ts'

type DesignActivity = Omit<AgentActivity, 'id' | 'createdAt'>
type TeammateChannel = Extract<MessageMetadata['channel'], 'team' | 'notice'>

// Awaited before tool state moves on, so it never runs ahead of a half-finished write.
export interface DesignHooks {
  onText(text: string): void | Promise<void>
  onPublish(html: string): void | Promise<void>
  onActivity(activity: DesignActivity): void | Promise<void>
}

interface DesignToolsOptions {
  html: string
  revision: number
  /** Off, the Builder works alone: no teammate, and no approval before it replies. */
  review: boolean
  /** The durable human inputs this run must answer, incorporate, or ask to clarify. */
  pending?: Message[]
  hooks: DesignHooks
  /** Resolves once the other seat's session holds the message. */
  tellTeammate(from: AgentSeat, channel: TeammateChannel, text: string): Promise<void>
}

interface DesignTools {
  /** Runs one model tool call; mistakes the agent can correct come back as failed results. */
  run(seat: AgentSeat, name: string, toolArguments: unknown): Promise<ToolResult>
  /** Why the run can't end yet, or undefined once the review gate holds. */
  completionError(): Error | undefined
}

type Tool = (seat: AgentSeat, toolArguments: Record<string, unknown>) => ToolResult | Promise<ToolResult>

const succeeded = (output: string): ToolResult => ({ success: true, output })
const failed = (error: string): ToolResult => ({ success: false, error })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** One run's shared page, the review gate on it, and the model tools that reach them. */
export function createDesignTools({ html, revision, review, pending = [], hooks, tellTeammate }: DesignToolsOptions): DesignTools {
  let artifact = { html, revision }
  let toolTail: Promise<void> = Promise.resolve()
  let approvedRevision: number | null = null
  let repliedRevision: number | null = null
  let builderPassed = false
  const readRevisions: Partial<Record<AgentSeat, number>> = {}
  const requests = pending.map(({ id, authorId, author, text, createdAt }) => ({ id, authorId, author, text, createdAt }))
  const requestIds = new Set(requests.map(({ id }) => id))

  // Inclusion in a model's input isn't an answer. Both seats must explicitly account for the whole open batch.
  function coverageError(value: unknown): string | undefined {
    if (!requests.length) return undefined
    if (!Array.isArray(value) || value.length !== requestIds.size || new Set(value).size !== value.length
      || value.some((id) => !Number.isSafeInteger(id) || !requestIds.has(id))) {
      return `Address every open request before finishing. addressed_message_ids must contain each of ${JSON.stringify([...requestIds])} exactly once, with no other IDs. Call read_design for the full requests; incorporate or answer each, ask the people involved to settle a conflict, or leave a conversation between people to them.`
    }
    return undefined
  }

  const readDesign: Tool = (seat) => {
    readRevisions[seat] = artifact.revision
    return succeeded(JSON.stringify({ html: artifact.html, revision: artifact.revision, pending_requests: requests }))
  }
  const publishDesign: Tool = async (seat, toolArguments) => {
    if (toolArguments.base_revision !== artifact.revision) return failed(`Stale design revision. The current revision is ${artifact.revision}; call read_design and merge your change into it before publishing.`)
    if (typeof toolArguments.html !== 'string') return failed('publish_design needs the complete HTML document as text')
    const validation = validateDesignArtifactHtml(toolArguments.html, { remoteImages: false })
    if (!validation.ok) return failed(validation.error)
    await hooks.onPublish(validation.html)
    artifact = { html: validation.html, revision: artifact.revision + 1 }
    const published = artifact.revision
    await hooks.onActivity({ agent: seat, kind: 'publish', text: 'Published the shared design', revision: published })
    if (review) await tellTeammate(seat, 'notice', publishedNotice(seat, published))
    return succeeded(JSON.stringify({ published: true, revision: published, bytes: validation.bytes }))
  }
  const sendMessage: Tool = async (seat, toolArguments) => {
    if (!isBoundedText(toolArguments.content, MAX_TEAM_MESSAGE_LENGTH)) return failed(`send_message needs 1–${MAX_TEAM_MESSAGE_LENGTH} characters of content`)
    await tellTeammate(seat, 'team', toolArguments.content)
    await hooks.onActivity({ agent: seat, kind: 'message', text: toolArguments.content })
    return succeeded(`Sent to ${teammateOf(seat)}.`)
  }
  const roomReply: Tool = async (_seat, toolArguments) => {
    if (!isBoundedText(toolArguments.content, MAX_ROOM_REPLY_LENGTH)) return failed(`room_reply needs 1–${MAX_ROOM_REPLY_LENGTH} characters of content`)
    const uncovered = coverageError(toolArguments.addressed_message_ids)
    if (uncovered) return failed(uncovered)
    if (requests.length && readRevisions.Builder === undefined) return failed('Read the design and every pending_request with read_design before replying.')
    if (review && artifact.html && approvedRevision !== artifact.revision) return failed(`Wait for the Reviewer to approve revision ${artifact.revision} first.`)
    if (repliedRevision === artifact.revision) return succeeded('Already posted the reply for this revision and open requests.')
    repliedRevision = artifact.revision
    await hooks.onText(toolArguments.content)
    return succeeded('Posted to the room.')
  }
  const finishReview: Tool = async (seat, toolArguments) => {
    if (!artifact.html) return failed('Nothing has been published yet; wait for the Builder.')
    const current = artifact.revision
    if (toolArguments.revision !== current) return failed(`Revision ${current} is current. Read it and review that revision.`)
    if (readRevisions[seat] !== current) return failed(`Read revision ${current} with read_design before approving it.`)
    if (!isBoundedText(toolArguments.summary, MAX_REVIEW_SUMMARY_LENGTH)) return failed(`finish_review needs a summary of 1–${MAX_REVIEW_SUMMARY_LENGTH} characters`)
    const uncovered = coverageError(toolArguments.addressed_message_ids)
    if (uncovered) return failed(uncovered)
    // A repeated approval of the same revision is accepted without a second notice or a second Builder reply.
    if (approvedRevision !== current) {
      approvedRevision = current
      await hooks.onActivity({ agent: seat, kind: 'review', text: toolArguments.summary, revision: current })
      await tellTeammate(seat, 'notice', approvedNotice(current, toolArguments.summary.trim()))
    }
    return succeeded(JSON.stringify({ approved: true, revision: current, addressed_message_ids: [...requestIds] }))
  }
  const pass: Tool = (seat, toolArguments) => {
    if (seat === 'Reviewer') return succeeded('Nothing posted.')
    if (artifact.revision !== revision) return failed(`You changed the page this run. ${review ? `Once the Reviewer approves revision ${artifact.revision}, tell` : 'Tell'} the room with room_reply.`)
    const uncovered = coverageError(toolArguments.addressed_message_ids)
    if (uncovered) return failed(uncovered)
    builderPassed = true
    return succeeded('Nothing posted.')
  }
  const handlers: Record<ToolName, Tool> = { read_design: readDesign, publish_design: publishDesign, send_message: sendMessage, room_reply: roomReply, finish_review: finishReview, pass }

  return {
    async run(seat, name, toolArguments) {
      const tool = seatTools(seat, review).find((definition) => definition.name === name)
      if (!tool) return failed(`${name} is not one of your tools`)
      if (!isRecord(toolArguments)) return failed('Tool arguments must be a JSON object')
      // Both seats share this tail. Teammate delivery awaits transport, not the recipient's tools.
      const result = toolTail.then(() => handlers[tool.name](seat, toolArguments))
      // Keep the caller's rejection, but don't let a failed operation strand later calls.
      toolTail = result.then(() => {}, () => {})
      return result
    },
    // A batch that leaves the page alone settles with a reply or the Builder's pass; a change must also be approved and announced.
    completionError() {
      if (artifact.revision === revision) return repliedRevision === revision || builderPassed ? undefined : new Error('The Builder neither replied to the room nor passed on its open requests')
      if (review && approvedRevision !== artifact.revision) return new Error(`The Reviewer did not approve revision ${artifact.revision}`)
      if (repliedRevision !== artifact.revision) return new Error(`The Builder did not reply to the room about revision ${artifact.revision}`)
      return undefined
    },
  }
}
