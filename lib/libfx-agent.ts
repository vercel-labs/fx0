import { createHash, randomUUID } from 'node:crypto'
import { createFxAgent, createFxEngine, type FxAgent, type FxAgentHostTool, type FxEffort, type FxHostTool, type FxSession, type FxToolContext } from 'libfx'
import { createTools, type ToolHost } from './tools'
import { gatewayFetch, type GatewayError, type DesignDraftObserver } from './gateway-session'
import { readExecutionFunding } from './turn-credential'
// @ts-expect-error Node strip-types tests require the source extension.
import { AuthError } from './accounts.ts'
import type { SessionData } from './secure-session'
import type { TrialCredential } from './trial'
import { TRIAL_MODEL } from './trial-policy'
import { bindLibfxSession, chatOfLibfxSession, getActiveTurn } from './journal'
import { createDraftContext } from './draft-context'
import { closeDraftCall, storedDraftObserver } from './draft-store'
import { turnBudget } from './turn-budget'
import {
  DEFAULT_MODEL,
  MAX_TURN_MODEL_STEPS,
  effectiveEffort,
  effectiveFast,
  effectiveModel,
  log,
  type SessionState,
} from './session'

// What each turn's tool calls receive as libfx `context`: the chat, and the fx0
// message that started the turn, so a tool's transcript items join its turn.
export interface TurnContext {
  chatId: string
  turnId: number
}

export const STEP_LIMIT = `Turn stopped after ${MAX_TURN_MODEL_STEPS} model steps. Send a message to continue.`
export const SIGN_IN_AGAIN = 'Sign in again to continue this chat, then resend.'

// The chat-specific pieces the agent asks for per call. agent.ts provides them;
// they live there because they read and write the chat's journal state.
export interface ChatRuntime {
  toolHost(chatId: string, turnId: number, signal: AbortSignal): Promise<ToolHost>
}

// Which model request of a turn this is: who sent it, and the conversation it
// carries. A retry or a crash's resend of a step carries the same conversation, so
// it has the same name; every new step, even after compaction, has a new one.
export function modelStepName(sender: string, body: unknown): string {
  const prompt = (body as { prompt?: unknown } | null)?.prompt
  // An unreadable conversation counts as a step of its own, never as a resend.
  if (!Array.isArray(prompt)) return `${sender}:unread:${randomUUID()}`
  return `${sender}:${createHash('sha256').update(JSON.stringify(prompt)).digest('base64url').slice(0, 22)}`
}

// libfx sends the body as bytes (a Buffer), not a string.
function requestJson(body: unknown): unknown {
  try {
    if (typeof body === 'string') return JSON.parse(body)
    if (body instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(body))
    if (ArrayBuffer.isView(body)) return JSON.parse(new TextDecoder().decode(body))
  } catch { /* libfx validates its own body */ }
  return null
}

// Model requests of this conversation so far: the assistant messages after the
// last user message, plus this one. It needs no state, so it holds even where the
// turn's shared budget (turn-budget.ts) is unknown or lost.
export function turnModelStep(body: unknown): number {
  const prompt = (body as { prompt?: unknown })?.prompt
  if (!Array.isArray(prompt)) return 1
  let steps = 1
  for (let index = prompt.length - 1; index >= 0; index--) {
    const role = (prompt[index] as { role?: unknown })?.role
    if (role === 'user') break
    if (role === 'assistant') steps++
  }
  return steps
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } })
}

function requestHeader(input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name) ?? (input instanceof Request ? input.headers.get(name) : null)
}

// Per chat and process: the stored credential for the request in flight, and
// gatewayFetch's rate-limit streak and Gateway's last scrubbed error.
interface ChatGateway {
  gatewaySession: SessionData | TrialCredential | null
  rateLimitStreak: number
  lastGatewayError: GatewayError | null
}
const chatGateways = new Map<string, ChatGateway>()

// Every model request uses the executing turn's recorded funding. With no usable
// credential the request fails: fx0 never falls back to the deployment's key.
// Public model metadata, which libfx reads without a session, goes out bare.
// `sender` is the parent turn, or one subagent run: all of them share the turn's
// MAX_TURN_MODEL_STEPS, so subagents cannot multiply what one turn spends.
function chatFetch(
  chatId: () => Promise<string | null>,
  executionTurn: () => number | undefined,
  sender = 'parent',
): typeof fetch {
  return async (input, init) => {
    const turn = executionTurn()
    const id = await chatId()
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const modelRequest = method === 'POST' && url.pathname.endsWith('/language-model')
    const body = modelRequest ? requestJson(init?.body) : null
    const limited = () => {
      log(id ?? 'unknown', 'turn:step-limit', { steps: MAX_TURN_MODEL_STEPS, sender: sender === 'parent' ? 'parent' : 'subagent' })
      return jsonError(400, STEP_LIMIT)
    }
    // A conversation that already shows the limit stops at once, with no stored state;
    // the turn's shared budget below also counts its subagents and survives a crash.
    if (modelRequest && turnModelStep(body) > MAX_TURN_MODEL_STEPS) return limited()
    const gateway: ChatGateway = (id && chatGateways.get(id)) || { gatewaySession: null, rateLimitStreak: 0, lastGatewayError: null }
    let observer: DesignDraftObserver | undefined
    if (id) {
      chatGateways.set(id, gateway)
      // All three use the same executing turn; reserving its preview and its step adds
      // no serial round trip to the funding lookup before the model request starts.
      const [funding, draft, steps] = await Promise.all([
        readExecutionFunding(id, turn),
        turn && modelRequest ? storedDraftObserver(id, turn).catch(() => undefined) : undefined,
        turn && modelRequest ? turnBudget().reserve(id, turn, modelStepName(sender, body)) : 0,
      ])
      if (steps > MAX_TURN_MODEL_STEPS) return limited()
      // The request fails below with "sign in again"; the log says why, with
      // the turn and reason only, never a credential.
      if (!funding.ok && modelRequest) log(id, 'funding:refused', { turn: turn ?? null, reason: funding.refused })
      const credential = funding.ok ? funding.credential : null
      gateway.gatewaySession = !credential ? null : 'kind' in credential ? credential : { ...credential, email: '', loginAt: 0, isLoggedIn: true }
      observer = draft
    }
    try {
      return await gatewayFetch(gateway, fetch, observer)(input, init)
    } catch (error) {
      // No stored credential, or one too close to expiry to start a request.
      if (error instanceof AuthError) return gateway.gatewaySession && 'kind' in gateway.gatewaySession
        ? jsonError(error.status, error.message) : jsonError(401, SIGN_IN_AGAIN)
      throw error
    }
  }
}

const libfxChats = new Map<string, string>()
async function chatOfRequest(sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null
  const cached = libfxChats.get(sessionId)
  if (cached) return cached
  const chatId = await chatOfLibfxSession(sessionId)
  if (chatId) libfxChats.set(sessionId, chatId)
  return chatId
}

// Reads are safe to run twice after a crash; publishing the same document twice
// is too. Edits, questions and subagents are not, so libfx tells the model a
// call cut off by a crash may have run instead of running it again.
const IDEMPOTENT = new Set(['read_design', 'publish_design', 'web_fetch', 'read_tool_result', 'capability_search'])
const WRITES = new Set(['publish_design', 'edit_design'])

function turnContext(ctx: FxToolContext): TurnContext {
  const context = ctx.context as Partial<TurnContext> | undefined
  if (typeof context?.chatId !== 'string' || typeof context.turnId !== 'number') {
    throw new Error('fx0 tool called without its chat context')
  }
  return { chatId: context.chatId, turnId: context.turnId }
}

// One set of tool definitions for every chat. Each call builds its own chat's
// host from the context libfx passes, then runs that chat's tool.
function chatTools(runtime: ChatRuntime, allowSubagent: boolean): FxAgentHostTool[] {
  const definitions = createTools(templateHost, { allowSubagent })
  return definitions.map((definition) => ({
    ...definition,
    idempotent: IDEMPOTENT.has(definition.name),
    writes: WRITES.has(definition.name),
    async execute(input: unknown, ctx: FxToolContext) {
      const { chatId, turnId } = turnContext(ctx)
      const host = await runtime.toolHost(chatId, turnId, ctx.signal)
      const tool = createTools(host, { allowSubagent }).find((candidate) => candidate.name === definition.name)
      if (!tool) throw new Error(`unknown tool ${definition.name}`)
      try { return await tool.execute(input, ctx) } finally {
        if (definition.name === 'publish_design') await closeDraftCall(chatId, ctx.executionId).catch(() => {})
      }
    },
  }))
}

// Definitions only: createTools reads names, descriptions and schemas from it.
const templateHost = new Proxy({} as ToolHost, {
  get() {
    return () => { throw new Error('tool definitions do not run') }
  },
})

// The durable agent this process runs every chat's turns with. Its own model and
// instructions are defaults; each chat's prompt carries the chat's settings.
export function durableAgent(runtime: ChatRuntime, instructions: string): FxAgent {
  const g = globalThis as unknown as { __fx0LibfxAgent?: FxAgent }
  if (g.__fx0LibfxAgent) return g.__fx0LibfxAgent
  const drafts = createDraftContext()
  g.__fx0LibfxAgent = createFxAgent({
    // No durability option: libfx picks its default, Vercel's World and Queues
    // on Vercel and local files elsewhere. On Vercel a prompt runs its turn in
    // the request that sent it, with no queue hop, and Vercel Queues keeps the
    // prompt as a backstop until after that request's time limit.

    // Placeholder: chatFetch sets each request's credential, and fx0 never uses
    // libfx's environment or OIDC fallback.
    apiKey: 'session-authenticated',
    fetch: (input, init) => {
      const id = requestHeader(input, init, 'x-session-id')
      return chatFetch(() => chatOfRequest(id), () => drafts.turn(id))(input, init)
    },
    onEvent: event => drafts.observe(event),
    // Hooks run synchronously before a restored engine starts its next request.
    hooks: { onEvent: event => drafts.observe(event) },
    model: DEFAULT_MODEL,
    instructions,
    tools: [...chatTools(runtime, true), { name: 'web_search', providerExecuted: true }],
  })
  return g.__fx0LibfxAgent
}

function chatModel(host: SessionState, sponsored = false) {
  if (sponsored) return { id: TRIAL_MODEL, effort: 'low' as FxEffort, fast: true }
  return { id: effectiveModel(host), effort: effectiveEffort(host) as FxEffort, fast: effectiveFast(host) }
}

// The chat's settings for the turns its next prompts start.
export function chatSessionOptions(host: SessionState, instructions: string, turnId: number, sponsored = false) {
  return {
    model: chatModel(host, sponsored),
    instructions,
    context: { chatId: host.id, turnId } satisfies TurnContext,
  }
}

// The chat's libfx session, created on its first prompt.
export async function chatSession(
  agent: FxAgent,
  host: SessionState,
  libfxSessionId: string | null,
  instructions: string,
  turnId: number,
  sponsored = false,
): Promise<{ session: FxSession; libfxSessionId: string }> {
  const id = libfxSessionId ?? await bindLibfxSession(host.id, await agent.newSessionId())
  libfxChats.set(id, host.id)
  return { session: agent.session(id, chatSessionOptions(host, instructions, turnId, sponsored)), libfxSessionId: id }
}

// A subagent is an ordinary in-memory engine inside its tool call, billed to the
// same chat and counted in the parent turn's steps. A crash mid-call is the
// parent's to recover: subagent is not idempotent, so libfx tells the model the
// call may have run; a run the model starts again counts as a new one.
export async function runSubagent(
  runtime: ChatRuntime,
  host: SessionState,
  turnId: number,
  instructions: string,
  task: string,
  signal: AbortSignal,
): Promise<string> {
  const chatId = host.id
  const [funding, active] = await Promise.all([readExecutionFunding(chatId, turnId), getActiveTurn(chatId)])
  // The parent turn's settings, even if the chat's were changed since it started.
  const pinned = active?.id === turnId ? active.settings : undefined
  const engine = await createFxEngine({
    apiKey: 'session-authenticated',
    fetch: chatFetch(async () => chatId, () => turnId, `subagent:${crypto.randomUUID()}`),
    model: pinned
      ? { id: pinned.model, effort: pinned.effort as FxEffort, fast: pinned.fast }
      : chatModel(host, funding.ok && 'kind' in funding.credential),
    instructions,
    tools: [
      ...createTools(await runtime.toolHost(chatId, turnId, signal), { allowSubagent: false }).map(tool => ({
        ...tool,
        async execute(input: unknown, ctx: FxToolContext) {
          try { return await tool.execute(input, ctx) } finally {
            if (tool.name === 'publish_design') await closeDraftCall(chatId, ctx.executionId).catch(() => {})
          }
        },
      })),
      { name: 'web_search', providerExecuted: true },
    ],
  })
  try {
    const turn = engine.prompt(task, { signal })
    let text = ''
    for await (const event of turn) {
      if (event.type === 'text_delta') text += event.delta
    }
    const result = await turn.result
    if (result.stopReason === 'refused') throw new Error('the model refused the task')
    return text || '(subagent finished with no text output; check its tool calls above)'
  } finally {
    await engine.close().catch(() => {})
  }
}
