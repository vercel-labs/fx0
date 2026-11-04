import timers from 'node:timers/promises'
import OpenAI, { APIConnectionError, APIError, APIUserAbortError, NotFoundError, RateLimitError } from 'openai'
import type { Stream } from 'openai/streaming'
import type { AgentSession, AgentSessionEvent, AgentSessionInputMessageParam, AgentSessionInputParam, AgentToolParam } from 'openai/resources/beta/agents/agents'
import type { SessionCreateParams } from 'openai/resources/beta/agents/sessions/sessions'
import type { Turn } from 'openai/resources/beta/agents/sessions/turns/turns'
// @ts-expect-error Node strip-types tests require the source extension.
import { redactSecrets } from '../auth-crypto.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { MAX_ERROR_LENGTH, type AgentSeat } from './types.ts'

export type { AgentSessionEvent, AgentSessionInputParam, Turn }
export type SessionEvents = Stream<AgentSessionEvent>
export type FunctionTool = AgentToolParam.AgentToolConfigParamFunction
export type RequiredAction = AgentSession['required_actions'][number]
export type ToolResult = { success: true; output: string } | { success: false; error: string }

/** Names the failed request in error messages, which the room shows. */
type ApiStage = 'create' | 'stream' | 'events' | 'retrieve' | 'turns'

interface AmpersandConfig {
  baseUrl: string
  apiKey: string
  fetch?: typeof fetch
}

// Ampersand extensions to the OpenAI request shapes; the client sends them unchanged.
export interface MessageMetadata {
  id: string
  source: string
  sender: string
  sender_name: string
  channel: 'setup' | 'room' | 'team' | 'notice'
  timestamp: number
}
export type InputMessage = AgentSessionInputMessageParam & { metadata: MessageMetadata }
export type AmpersandAgent = SessionCreateParams.Agent & { ampersand: { allow_silent_completion: boolean } }

interface SessionStart {
  agent: AmpersandAgent
  input: InputMessage[]
  metadata: Record<string, string>
}

// Reads and event posts are safe to repeat (posts carry idempotency keys), and two busy agents can meet the account's rate limit.
const MAX_RETRIES = 5
const BASE_RATE_LIMIT_WAIT_MS = 2_000
// A wait past the run deadline would be aborted anyway, and Node timers overflow beyond ~24 days.
const MAX_RATE_LIMIT_WAIT_MS = 300_000
const CLEANUP_TIMEOUT_MS = 3_000
const DEFAULT_ERROR_MESSAGE = 'Ampersand could not finish this turn.'

/** An Ampersand request failure; the message names only the HTTP status and stage, never the response body. */
export class AmpersandError extends Error {
  status: number | null

  constructor(status: number | null, stage: ApiStage) {
    super(status === null ? `Ampersand API request failed (no response) [${stage}]` : `Ampersand API request failed (HTTP ${status}) [${stage}]`)
    this.name = 'AmpersandError'
    this.status = status
  }
}

export function createAmpersandClient(config: AmpersandConfig): OpenAI {
  const base = new URL(config.baseUrl)
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) || base.username || base.password || base.search || base.hash) {
    throw new Error('Ampersand API URL must use HTTPS, or HTTP on localhost, without credentials or a query')
  }
  if (!config.apiKey) throw new Error('Ampersand API key is required')
  // redirect: 'error' keeps the key on the configured origin.
  return new OpenAI({ baseURL: base.href, apiKey: config.apiKey, maxRetries: MAX_RETRIES, fetch: config.fetch, fetchOptions: { redirect: 'error' } })
}

// Aborts pass through so the run can report its deadline; any other failure, a malformed body included, keeps only its status.
function requestError(error: unknown, stage: ApiStage): Error {
  if (error instanceof APIUserAbortError) return error
  return new AmpersandError(error instanceof APIError && !(error instanceof APIConnectionError) ? error.status ?? null : null, stage)
}

/** The client raises a stream's `error` event as an APIError, which fails the run; null means the connection dropped and can be reopened. */
export function streamFailure(error: unknown, seat: AgentSeat): Error | null {
  if (error instanceof APIError && !(error instanceof APIConnectionError) && !(error instanceof APIUserAbortError)) return new Error(`Ampersand reported an error for the ${seat} [stream]`)
  return null
}

async function request<T>(stage: ApiStage, send: () => PromiseLike<T>): Promise<T> {
  try {
    return await send()
  } catch (error) {
    throw requestError(error, stage)
  }
}

// The API's two forms: milliseconds, or whole seconds.
function rateLimitWaitMs(headers: Headers, retry: number): number {
  const wait = Number(headers.get('retry-after-ms') ?? Number(headers.get('retry-after') ?? NaN) * 1000)
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(0, Number.isFinite(wait) ? wait : BASE_RATE_LIMIT_WAIT_MS * 2 ** retry))
}

// Creation takes no idempotency key, so only a definite 429 (rejected before any session existed) is retried.
export async function createSession(client: OpenAI, start: SessionStart, signal: AbortSignal): Promise<SessionEvents> {
  for (let retry = 0; ; retry++) {
    try {
      return await client.beta.agents.sessions.create({ ...start, environment: { type: 'none' }, stream: true }, { maxRetries: 0, signal })
    } catch (error) {
      if (!(error instanceof RateLimitError) || retry >= MAX_RETRIES) throw requestError(error, 'create')
      await timers.setTimeout(rateLimitWaitMs(error.headers, retry), undefined, { signal })
    }
  }
}

export function openSessionEvents(client: OpenAI, sessionId: string, signal: AbortSignal): Promise<SessionEvents> {
  return request('stream', () => client.beta.agents.sessions.events.stream(sessionId, { signal }))
}

export function retrieveSession(client: OpenAI, sessionId: string, signal: AbortSignal): Promise<AgentSession> {
  return request('retrieve', () => client.beta.agents.sessions.retrieve(sessionId, { signal }))
}

export async function latestTurn(client: OpenAI, sessionId: string, signal: AbortSignal): Promise<Turn | undefined> {
  const page = await request('turns', () => client.beta.agents.sessions.turns.list(sessionId, { limit: 1, order: 'desc' }, { signal }))
  return page.data[0]
}

// The key goes in the params: the OpenAI client sends only that one as the Idempotency-Key header.
export function postEvents(client: OpenAI, sessionId: string, events: AgentSessionInputParam[], idempotencyKey: string, signal: AbortSignal): Promise<void> {
  return request('events', () => client.beta.agents.sessions.events.create(sessionId, { events, 'Idempotency-Key': idempotencyKey }, { signal }))
}

// Best effort and one bounded attempt: the run is already failing or the session is being replaced, and a retry could outlive either.
// Resolves whether the request succeeded, so a caller that must not lose track of a session can try again later.
async function cleanup(label: string, send: (options: { maxRetries: 0; signal: AbortSignal }) => PromiseLike<unknown>): Promise<boolean> {
  try {
    await send({ maxRetries: 0, signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) })
    return true
  } catch (error) {
    // The class name only (the SDK's errors all report name 'Error'); messages can carry provider text.
    console.warn(`[fx0] collab ${label} skipped`, { name: error instanceof Error ? error.constructor.name : 'UnknownError' })
    return false
  }
}

export function cancelSession(client: OpenAI, sessionId: string): Promise<boolean> {
  return cleanup('cancel', (options) => client.beta.agents.sessions.events.create(sessionId, { events: [{ type: 'agent.session.input.cancel' }] }, options))
}

/** Resolves true once the session is gone, including when it already was. */
export function deleteSession(client: OpenAI, sessionId: string): Promise<boolean> {
  return cleanup('session delete', async (options) => {
    try {
      await client.beta.agents.sessions.delete(sessionId, options)
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error
    }
  })
}

/** The one place a run error becomes room-visible text: the key and token-shaped strings are removed before the cap. */
export function redactedErrorMessage(error: unknown, apiKey: string | undefined): string {
  const message = error instanceof Error ? error.message : DEFAULT_ERROR_MESSAGE
  const redacted = redactSecrets(apiKey ? message.split(apiKey).join('[redacted]') : message).replaceAll('\0', '').trim()
  return (redacted || DEFAULT_ERROR_MESSAGE).slice(0, MAX_ERROR_LENGTH)
}
