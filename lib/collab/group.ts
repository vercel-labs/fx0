import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import timers from 'node:timers/promises'
import type OpenAI from 'openai'
// @ts-expect-error Node strip-types tests require the source extension.
import { hashHandle } from '../auth-crypto.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { AmpersandError, cancelSession, createSession, deleteSession, latestTurn, openSessionEvents, postEvents, retrieveSession, streamFailure, type AgentSessionEvent, type AgentSessionInputParam, type AmpersandAgent, type InputMessage, type MessageMetadata, type RequiredAction, type SessionEvents, type ToolResult, type Turn } from './ampersand.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { createDesignTools, type DesignHooks } from './design-tools.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { InputsChangedError, SessionCleanupError } from './input-batch.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { joinedNotice, seatInstructions, seatTools, setupText } from './prompts.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { AGENT_SEATS, teammateOf, type AgentSeat, type Member, type Message, type SeatSession } from './types.ts'

// Also the bound on a runaway exchange between the two agents.
const DEFAULT_TIMEOUT_MS = 300_000
// A stream that keeps closing before any event arrives is an outage, not a dropped connection.
const MAX_QUIET_REOPENS = 3
// How long a failing run waits for a just-created session to report its ID, so the cancel can reach it.
const CREATE_SETTLE_MS = 3_000
const MESSAGE_SOURCE = 'fx0-collab'
// Session settings are fixed at creation, so a session whose stored hash of them differs is replaced, not continued.
const CONFIG_METADATA_KEY = 'fx0_config'

export interface DesignGroupRoom {
  title: string
  /** Off, only the Builder runs. */
  review: boolean
  members: Member[]
  /** The whole saved transcript, oldest first; a new session starts from it. */
  messages: Message[]
  /** People's messages this run must settle, oldest first. */
  pending: Message[]
  html: string
  revision: number
  sessions: Partial<Record<AgentSeat, SeatSession>>
}

export interface DesignGroupHooks extends DesignHooks {
  onSession(seat: AgentSeat, session: SeatSession): void | Promise<void>
  /** Checks the durable input watermark before an external message or visible effect. */
  assertCurrent?(): void | Promise<void>
}

export interface DesignGroupRun {
  client: OpenAI
  model: string
  room: DesignGroupRoom
  hooks: DesignGroupHooks
  timeoutMs?: number
  /** New durable input supersedes this batch; cleanup must finish before its replacement starts. */
  signal?: AbortSignal
}

interface Seat {
  name: AgentSeat
  sessionId: string
  /** Resolves once the session holds this run's room messages, so teammate posts arrive after them. */
  ready: PromiseWithResolvers<void>
  /** Unfinished work in this run; only a verified idle clears it. */
  busy: boolean
  /** Input posts in flight; an idle seen meanwhile may predate them. */
  posts: Set<Promise<void>>
  /** Counts input posts, so a check that overlapped one doesn't settle the seat. */
  postCount: number
  /** Its create returned a stream whose session ID hasn't arrived yet. */
  creating: boolean
}

const idempotencyKey = (parts: string[]) => 'fx0-' + hashHandle(JSON.stringify(parts))
const nowSeconds = () => Math.floor(Date.now() / 1000)

function inputMessage(text: string, metadata: Omit<MessageMetadata, 'source'>): InputMessage {
  return { role: 'user', content: [{ type: 'input_text', text }], metadata: { source: MESSAGE_SOURCE, ...metadata } }
}

// Room replies were posted by the Builder, so a session sees them under its name.
function roomInput(message: Message): InputMessage {
  const fromBuilder = message.role === 'assistant'
  return inputMessage(message.text, {
    id: `message-${message.id}`, sender: fromBuilder ? 'builder' : message.authorId, sender_name: fromBuilder ? 'Builder' : message.author,
    channel: 'room', timestamp: Math.floor(message.createdAt / 1000),
  })
}

// A stable ID per member, so a notice the session already holds is ignored if it is sent again.
function joinInput(member: Member): InputMessage {
  return inputMessage(joinedNotice(member.name), { id: `join-${member.id}`, sender: 'fx0', sender_name: 'fx0', channel: 'notice', timestamp: Math.floor(member.joinedAt / 1000) })
}

function noticeInput(text: string): InputMessage {
  return inputMessage(text, { id: `notice-${randomUUID()}`, sender: 'fx0', sender_name: 'fx0', channel: 'notice', timestamp: nowSeconds() })
}

// Random suffixes: a counter would restart each run and repeat an ID the persistent session already holds.
function teamInput(from: AgentSeat, text: string): InputMessage {
  return inputMessage(text, { id: `team-${from.toLowerCase()}-${randomUUID()}`, sender: from.toLowerCase(), sender_name: from, channel: 'team', timestamp: nowSeconds() })
}

function seatAgent(seat: AgentSeat, model: string, review: boolean): AmpersandAgent {
  return { model, instructions: seatInstructions(seat, review), tools: seatTools(seat, review), ampersand: { allow_silent_completion: true } }
}

function turnError(seat: AgentSeat, turn: Turn): Error {
  return new Error(`The ${seat}'s Ampersand turn ${turn.status}${turn.error ? ` (${turn.error.code})` : ''}`)
}

// Waits for every promise to settle, or for the timeout, whichever comes first.
async function settleWithin(promises: Promise<unknown>[], milliseconds: number): Promise<void> {
  const timer = new AbortController()
  await Promise.race([Promise.allSettled(promises), timers.setTimeout(milliseconds, undefined, { signal: timer.signal }).catch(() => {})])
  timer.abort()
}

function newSeat(name: AgentSeat): Seat {
  const ready = Promise.withResolvers<void>()
  // Only teammates await it; a run that ends first rejects it to release them.
  ready.promise.catch(() => {})
  return { name, sessionId: '', ready, busy: true, posts: new Set(), postCount: 0, creating: false }
}

/** Runs the Builder and Reviewer on their persistent sessions until both are idle and the review gate holds. */
export async function runDesignGroup({ client, model, room, hooks, timeoutMs = DEFAULT_TIMEOUT_MS, signal: inputSignal }: DesignGroupRun): Promise<void> {
  if (!room.pending.length) throw new Error('A design group run needs at least one pending room message')
  const controller = new AbortController()
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([controller.signal, deadline, ...(inputSignal ? [inputSignal] : [])])
  // Let an in-flight create report its ID during bounded cleanup, so superseding input doesn't orphan it.
  const createSignal = AbortSignal.any([controller.signal, deadline])
  const seats: Record<AgentSeat, Seat> = { Builder: newSeat('Builder'), Reviewer: newSeat('Reviewer') }
  const active: readonly AgentSeat[] = room.review ? AGENT_SEATS : ['Builder']
  const receipts = new Map<string, Promise<ToolResult>>()
  const calls = new Map<string, { name: string; arguments: unknown }>()
  const resultPosts = new Map<string, Promise<void>>()
  const tasks: Promise<void>[] = []
  const outcome = Promise.withResolvers<void>()
  let decided = false
  // Asserted so the type stays wide: closures set it, which control-flow narrowing doesn't see.
  let failure = null as { error: unknown } | null

  // The first outcome wins; anything after it is the fallout of stopping.
  const decide = (result: { error: unknown } | null) => {
    if (decided) return
    decided = true
    failure = result
    outcome.resolve()
  }
  const fail = (error: unknown) => decide({ error })
  const track = (task: Promise<void>) => { tasks.push(task.catch(fail)) }
  const post = (seat: Seat, events: AgentSessionInputParam[], keyParts: string[]) => postEvents(client, seat.sessionId, events, idempotencyKey(keyParts), signal)

  // Marks the seat busy before the post, so neither an idle check nor the end of the run can slip in between.
  // The input check is awaited inside the tracked post, so an idle check that starts meanwhile still waits for it.
  const send = async (seat: Seat, input: InputMessage[]) => {
    seat.busy = true
    seat.postCount++
    const sent = (async () => {
      await hooks.assertCurrent?.()
      signal.throwIfAborted()
      await post(seat, [{ type: 'agent.session.input.message', input }], [seat.sessionId, ...input.map((message) => message.metadata.id)])
    })()
    seat.posts.add(sent)
    try {
      await sent
    } finally {
      seat.posts.delete(sent)
    }
  }

  const design = createDesignTools({
    html: room.html,
    revision: room.revision,
    review: room.review,
    pending: room.pending,
    hooks,
    tellTeammate: async (from, channel, text) => {
      const target = seats[teammateOf(from)]
      await target.ready.promise
      await send(target, [channel === 'team' ? teamInput(from, text) : noticeInput(text)])
    },
  })

  const settle = (seat: Seat) => {
    if (!seat.busy) return
    seat.busy = false
    if (active.some((name) => seats[name].busy)) return
    const error = design.completionError()
    decide(error ? { error } : null)
  }

  // Receipts keyed by session, turn and call run each tool once and post its result once, however often Ampersand asks.
  const answerActions = async (seat: Seat, actions: RequiredAction[]) => {
    for (const action of actions) {
      if (action.type !== 'function_call') throw new Error(`Ampersand asked the ${seat.name} for an unsupported ${action.type} action`)
      const key = JSON.stringify([seat.sessionId, action.turn_id, action.call_id])
      const prior = calls.get(key)
      if (prior && (prior.name !== action.name || !isDeepStrictEqual(prior.arguments, action.arguments))) {
        throw new Error('Ampersand reused a tool-call ID with different arguments')
      }
      let receipt = receipts.get(key)
      if (!receipt) {
        await hooks.assertCurrent?.()
        signal.throwIfAborted()
        // The same request may have arrived by event and by a state read during the check.
        receipt = receipts.get(key)
        if (!receipt) {
          calls.set(key, { name: action.name, arguments: structuredClone(action.arguments) })
          receipt = design.run(seat.name, action.name, action.arguments)
          receipts.set(key, receipt)
        }
      }
      let resultPost = resultPosts.get(key)
      if (!resultPost) {
        const answer = { type: 'agent.session.input.tool_result' as const, turn_id: action.turn_id, call_id: action.call_id }
        resultPost = receipt.then((result) => post(seat, [{ ...answer, ...result }], ['tool-result', key]))
        resultPosts.set(key, resultPost)
      }
      await resultPost
    }
  }

  // Saved state decides, as an idle event can predate queued input; new input to an idle session starts a turn, and postCount catches a post during the read.
  const checkSession = async (seat: Seat) => {
    await Promise.allSettled(seat.posts)
    const postCount = seat.postCount
    const session = await retrieveSession(client, seat.sessionId, signal)
    if (session.status === 'failed') throw new Error(`The ${seat.name}'s Ampersand session failed`)
    if (session.required_actions.length) return answerActions(seat, session.required_actions)
    if (session.status !== 'idle') return
    const turn = await latestTurn(client, seat.sessionId, signal)
    if (!turn) return
    if (turn.status === 'failed' || turn.status === 'cancelled') throw turnError(seat.name, turn)
    if (turn.status === 'completed' && seat.postCount === postCount) settle(seat)
  }

  const handleEvent = async (seat: Seat, event: AgentSessionEvent) => {
    // After the outcome only a new session's ID still matters: it lets the failure path cancel that session.
    if (decided && event.type !== 'agent.session.created') return
    switch (event.type) {
      case 'agent.session.created':
        if (seat.sessionId) return
        seat.sessionId = event.session.id
        seat.creating = false
        await hooks.onSession(seat.name, { sessionId: seat.sessionId, deliveredThrough: room.messages.at(-1)?.id ?? 0 })
        seat.ready.resolve()
        return
      case 'agent.session.requires_action':
        return answerActions(seat, event.session.required_actions)
      case 'agent.session.idle':
        return checkSession(seat)
      case 'agent.session.turn.failed':
      case 'agent.session.turn.cancelled':
        throw turnError(seat.name, event.turn)
      case 'agent.session.failed':
        throw new Error(`The ${seat.name}'s Ampersand session failed`)
    }
  }

  // Returns whether any event arrived; a dropped connection returns so the caller reopens.
  const readEvents = async (seat: Seat, events: SessionEvents): Promise<boolean> => {
    const iterator = events[Symbol.asyncIterator]()
    let received = false
    try {
      while (true) {
        let next: IteratorResult<AgentSessionEvent>
        try {
          next = await iterator.next()
        } catch (error) {
          const streamError = streamFailure(error, seat.name)
          if (streamError) throw streamError
          return received
        }
        if (next.done) return received
        received = true
        await handleEvent(seat, next.value)
      }
    } finally {
      events.controller.abort()
    }
  }

  // Closing a stream never stops the session, so a closed stream is reopened and saved state read again.
  const follow = async (seat: Seat, first: SessionEvents) => {
    let events = first
    let quietReopens = 0
    while (true) {
      const received = await readEvents(seat, events)
      if (signal.aborted) return
      if (!seat.sessionId) throw new Error(`Ampersand closed the ${seat.name}'s stream before creating its session [create]`)
      quietReopens = received ? 0 : quietReopens + 1
      if (quietReopens > MAX_QUIET_REOPENS) throw new Error(`The ${seat.name}'s Ampersand event stream kept closing [stream]`)
      events = await openSessionEvents(client, seat.sessionId, signal)
      await checkSession(seat)
    }
  }

  // A missing, failed or busy session, one made with other settings, or one already holding some of this batch (it stopped mid-batch) is replaced from the transcript.
  const reusableSession = async (stored: SeatSession, fingerprint: string): Promise<boolean> => {
    let session
    try {
      session = await retrieveSession(client, stored.sessionId, signal)
    } catch (error) {
      if (error instanceof AmpersandError && error.status === 404) return false
      throw error
    }
    if (session.status === 'idle' && session.metadata[CONFIG_METADATA_KEY] === fingerprint && stored.deliveredThrough < room.pending[0].id) return true
    if (!await deleteSession(client, stored.sessionId)) throw new SessionCleanupError('Could not retire a saved Ampersand session; its ID is retained for retry')
    return false
  }

  // The stream opens before the post so no event is lost.
  const continueSession = async (seat: Seat, stored: SeatSession) => {
    seat.sessionId = stored.sessionId
    const events = await openSessionEvents(client, seat.sessionId, signal)
    // The Builder's session holds its own replies; the Reviewer gets every message since its last batch, including ones settled while review was off.
    const shared = seat.name === 'Builder' ? room.pending : room.messages
    const fresh = shared.filter((message) => message.id > stored.deliveredThrough)
    // People who joined since the last message this session got, each in its place among the new messages.
    const since = room.messages.find((message) => message.id === stored.deliveredThrough)?.createdAt ?? 0
    const input = [
      ...room.members.filter((member) => member.joinedAt > since).map((member) => ({ at: member.joinedAt, input: joinInput(member) })),
      ...fresh.map((message) => ({ at: message.createdAt, input: roomInput(message) })),
    ].sort((left, right) => left.at - right.at).map((item) => item.input)
    // Saved before the post, so a post whose outcome is unknown makes the next run start this seat over.
    await hooks.onSession(seat.name, { sessionId: seat.sessionId, deliveredThrough: fresh[fresh.length - 1].id })
    await send(seat, [...input, pendingNotice()])
    seat.ready.resolve()
    track(follow(seat, events))
    // A post that started no turn brings no idle event, so saved state is read once.
    await checkSession(seat)
  }

  const startSession = async (seat: Seat, agent: AmpersandAgent, fingerprint: string) => {
    await hooks.assertCurrent?.()
    signal.throwIfAborted()
    const setup = inputMessage(setupText(seat.name, room.title, room.members, room.review), { id: 'setup', sender: 'fx0', sender_name: 'fx0', channel: 'setup', timestamp: nowSeconds() })
    const input = [setup, ...room.messages.map(roomInput), pendingNotice()]
    seat.creating = true
    let events: SessionEvents
    try {
      events = await createSession(client, { agent, input, metadata: { [CONFIG_METADATA_KEY]: fingerprint } }, createSignal)
    } catch (error) {
      // A definite admission refusal created nothing; a lost response has an unknown outcome.
      if (error instanceof AmpersandError && error.status !== null && error.status >= 400 && error.status < 500) seat.creating = false
      throw error
    }
    track(follow(seat, events))
  }

  const startSeat = async (seat: Seat) => {
    const agent = seatAgent(seat.name, model, room.review)
    const fingerprint = hashHandle(JSON.stringify(agent))
    const stored = room.sessions[seat.name]
    if (stored && await reusableSession(stored, fingerprint)) return continueSession(seat, stored)
    return startSession(seat, agent, fingerprint)
  }

  function pendingNotice(): InputMessage {
    return noticeInput(`Open requests for this run, oldest first: ${JSON.stringify(room.pending.map(({ id, authorId, author }) => ({ id, authorId, author })))}. Read ALL pending_requests with read_design, preserving earlier requests and existing agreed changes; a later person's message does not replace an earlier request. The review, and the Builder's reply or pass, must list every ID, including those left to the people.`)
  }

  const abortRun = () => fail(signal.reason instanceof InputsChangedError ? signal.reason : new Error('Design generation timed out'))
  signal.addEventListener('abort', abortRun, { once: true })
  const starts: Promise<void>[] = []
  try {
    if (signal.aborted) abortRun()
    // With review on, both seats start at once and work concurrently.
    for (const name of active) {
      if (decided) break
      const start = startSeat(seats[name])
      starts.push(start)
      track(start)
    }
    await outcome.promise
  } finally {
    signal.removeEventListener('abort', abortRun)
    // One seat can fail while the other's create is in flight; that new session must report its ID before the streams close.
    if (failure) {
      await settleWithin(starts, CREATE_SETTLE_MS)
      await settleWithin(active.map((name) => seats[name]).filter((seat) => seat.creating).map((seat) => seat.ready.promise), CREATE_SETTLE_MS)
    }
    controller.abort()
    for (const name of AGENT_SEATS) seats[name].ready.reject(new Error('The design group run ended'))
    await Promise.all(tasks)
  }
  if (failure) {
    // Closing the streams doesn't stop the agents; each busy session gets one cancel.
    const cancelled = await Promise.all(active.map((name) => seats[name]).filter((seat) => seat.busy && seat.sessionId).map((seat) => cancelSession(client, seat.sessionId)))
    if (cancelled.some((success) => !success)) throw new SessionCleanupError('Could not stop a previous Ampersand run; its saved sessions are retained for retry')
    if (active.some((name) => seats[name].creating && !seats[name].sessionId)) {
      const refused = failure.error instanceof AmpersandError ? `${failure.error.message}. ` : ''
      throw new SessionCleanupError(`${refused}Could not confirm an Ampersand session creation; automatic catch-up stopped. Check account sessions before retrying`)
    }
    throw failure.error
  }
}
