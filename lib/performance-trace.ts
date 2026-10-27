// Shared local trace format. Only fixed event names, identifiers, and numeric
// measurements can leave the recorder; request/model content is never accepted.
export type TraceName =
  | 'request.handle' | 'request.auth' | 'request.revocation' | 'request.owner' | 'prompt.activate'
  | 'net.workflow' | 'net.queue' | 'net.oidc' | 'net.vercel_api' | 'net.redis' | 'net.neon' | 'net.gateway' | 'net.other'
  | 'connect.workflow' | 'connect.queue' | 'connect.oidc' | 'connect.vercel_api' | 'connect.redis' | 'connect.neon'
  | 'connect.gateway' | 'connect.other'
  | 'agent.create' | 'agent.session_id'
  | 'prompt.send' | 'prompt.headers' | 'prompt.journal' | 'prompt.credential'
  | 'prompt.hydrate' | 'prompt.bind' | 'prompt.accepted' | 'prompt.assets'
  | 'model.prepare' | 'model.headers' | 'model.first_chunk' | 'model.stream'
  | 'tool.execute' | 'projector.history' | 'projector.batch' | 'journal.commit'
  | 'sse.poll' | 'sse.deliver' | 'sse.receive' | 'event.apply'
  | 'draft.write' | 'draft.sanitize' | 'draft.patch'
  | 'artifact.prepare' | 'preview.presented' | 'browser.longtask'
  | 'prompt.started' | 'prompt.turn' | 'prompt.e2e' | 'prompt.acknowledged'
  | 'prompt.first_content' | 'prompt.first_draft' | 'prompt.finished'

export interface TraceContext { traceId?: string; sessionId?: string; turnId?: number }
export type TraceNumbers = Partial<Record<
  'count' | 'chars' | 'bytes' | 'status' | 'failed' | 'cancelled' | 'first' |
  'seq' | 'revision' | 'fromPost' | 'duplicate' | 'step' | 'incomplete' | 'uptime' | 'registered' | 'loaded', number | boolean>>

const names = new Set<TraceName>([
  'request.handle', 'request.auth', 'request.revocation', 'request.owner', 'prompt.activate',
  'net.workflow', 'net.queue', 'net.oidc', 'net.vercel_api', 'net.redis', 'net.neon', 'net.gateway', 'net.other',
  'connect.workflow', 'connect.queue', 'connect.oidc', 'connect.vercel_api', 'connect.redis', 'connect.neon',
  'connect.gateway', 'connect.other',
  'agent.create', 'agent.session_id',
  'prompt.send', 'prompt.headers', 'prompt.journal',
  'prompt.credential', 'prompt.hydrate', 'prompt.bind', 'prompt.accepted', 'prompt.assets',
  'model.prepare', 'model.headers', 'model.first_chunk', 'model.stream', 'tool.execute',
  'projector.history', 'projector.batch', 'journal.commit', 'sse.poll', 'sse.deliver',
  'sse.receive', 'event.apply', 'draft.write', 'draft.sanitize', 'draft.patch',
  'artifact.prepare', 'preview.presented', 'browser.longtask',
  'prompt.started', 'prompt.turn', 'prompt.e2e', 'prompt.acknowledged',
  'prompt.first_content', 'prompt.first_draft', 'prompt.finished',
])
const fields = ['count', 'chars', 'bytes', 'status', 'failed', 'cancelled', 'first',
  'seq', 'revision', 'fromPost', 'duplicate', 'step', 'incomplete', 'uptime', 'registered', 'loaded'] as const
const noop = (_attrs?: TraceNumbers) => {}

export function validTraceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

function numbers(attrs?: { [key: string]: unknown }): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {}
  for (const key of fields) {
    const value = attrs?.[key]
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value
  }
  return out
}

function contextFields(context?: { traceId?: unknown; sessionId?: unknown; turnId?: unknown }): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  if (validTraceId(context?.traceId)) out.traceId = context.traceId
  if (typeof context?.sessionId === 'string' && /^[a-f0-9-]{36}$/i.test(context.sessionId)) out.sessionId = context.sessionId
  const turnId = context?.turnId
  if (typeof turnId === 'number' && Number.isSafeInteger(turnId) && turnId > 0) out.turnId = turnId
  return out
}

interface TraceEvent {
  name: TraceName
  cat: 'fx0'
  ph: 'X' | 'i'
  s?: 't'
  ts: number
  dur?: number
  pid: string
  tid: number
  args: Record<string, string | number | boolean>
}

export function createTraceRecorder(options: {
  enabled: boolean
  process: string
  capacity?: number
  now?: () => number
  timeOrigin?: number
}) {
  const capacity = Math.max(1, Math.min(100_000, Math.floor(options.capacity ?? 10_000) || 1))
  const events: TraceEvent[] = []
  const now = options.now ?? (() => performance.now())
  const origin = options.timeOrigin ?? performance.timeOrigin
  let next = 0
  let dropped = 0
  const record = (event: TraceEvent) => {
    if (events.length < capacity) events.push(event)
    else { events[next] = event; next = (next + 1) % capacity; dropped++ }
  }
  const snapshot = () => ({
    traceEvents: (events.length === capacity ? [...events.slice(next), ...events.slice(0, next)] : [...events])
      .map(event => ({ ...event, args: { ...event.args } })),
    displayTimeUnit: 'ms',
    dropped,
  })
  return {
    start(name: TraceName, context?: TraceContext, attrs?: TraceNumbers): (attrs?: TraceNumbers) => void {
      if (!options.enabled || !names.has(name)) return noop
      const started = now()
      const args = { ...contextFields(context), ...numbers(attrs) }
      let ended = false
      return (result) => {
        if (ended) return
        ended = true
        record({ name, cat: 'fx0', ph: 'X', ts: (origin + started) * 1000,
          dur: Math.max(0, now() - started) * 1000, pid: options.process, tid: 1,
          args: { ...args, ...numbers(result) } })
      }
    },
    instant(name: TraceName, context?: TraceContext, attrs?: TraceNumbers): void {
      if (!options.enabled || !names.has(name)) return
      record({ name, cat: 'fx0', ph: 'i', s: 't', ts: (origin + now()) * 1000,
        pid: options.process, tid: 1, args: { ...contextFields(context), ...numbers(attrs) } })
    },
    snapshot,
    drain() {
      const result = snapshot()
      events.length = 0
      next = 0
      dropped = 0
      return result
    },
  }
}

export interface SanitizedTraceEvent {
  name: TraceName
  cat: 'fx0'
  ph: 'X' | 'i'
  s?: 't'
  ts: number
  dur?: number
  pid: string
  tid: 1
  args: Record<string, string | number | boolean>
}

export interface SanitizedTraceSnapshot {
  traceEvents: SanitizedTraceEvent[]
  displayTimeUnit: 'ms'
  dropped: number
  rejected: number
}

const maxSnapshotEvents = 100_000
// The browser lane, or one server process/function lane. Arbitrary strings never name a lane.
const laneId = /^(?:browser|server:(?:\d{1,10}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}))$/

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

// Any raw snapshot that leaves a trace boundary (a parsed file, a browser capture, a server batch)
// passes the recorder's own name, field, and identifier allowlists. Invalid events are counted as
// rejected; a malformed container or drop count throws rather than reporting a clean measurement.
export function sanitizeTraceSnapshot(snapshot: unknown): SanitizedTraceSnapshot {
  const input = snapshot as { traceEvents?: unknown; dropped?: unknown } | null | undefined
  if (!input || typeof input !== 'object' || !Array.isArray(input.traceEvents) || input.traceEvents.length > maxSnapshotEvents) {
    throw new TypeError('Invalid or oversized trace snapshot')
  }
  const dropped = input.dropped
  if (typeof dropped !== 'number' || !Number.isSafeInteger(dropped) || dropped < 0) throw new TypeError('Invalid trace drop count')
  const traceEvents: SanitizedTraceEvent[] = []
  let rejected = 0
  for (const value of input.traceEvents) {
    const event = sanitizeEvent(value)
    if (event) traceEvents.push(event)
    else rejected++
  }
  return { traceEvents, displayTimeUnit: 'ms', dropped, rejected }
}

function sanitizeEvent(value: unknown): SanitizedTraceEvent | undefined {
  if (!value || typeof value !== 'object') return
  const event = value as { name?: unknown; ph?: unknown; ts?: unknown; dur?: unknown; pid?: unknown; args?: unknown }
  const name = event.name
  if (typeof name !== 'string' || !names.has(name as TraceName)) return
  const ph = event.ph
  if (ph !== 'X' && ph !== 'i') return
  const pid = event.pid
  if (typeof pid !== 'string' || !laneId.test(pid)) return
  const ts = event.ts
  if (!nonNegativeFinite(ts)) return
  const dur = event.dur
  if (ph === 'X' && !nonNegativeFinite(dur)) return
  const raw = (event.args && typeof event.args === 'object' ? event.args : {}) as Record<string, unknown>
  // Only fixed identifiers and finite numeric/boolean fields survive; every other argument is discarded.
  const args = { ...contextFields(raw), ...numbers(raw) } as Record<string, string | number | boolean>
  if (ph === 'X') return { name: name as TraceName, cat: 'fx0', ph: 'X', ts, dur: dur as number, pid, tid: 1, args }
  return { name: name as TraceName, cat: 'fx0', ph: 'i', s: 't', ts, pid, tid: 1, args }
}
