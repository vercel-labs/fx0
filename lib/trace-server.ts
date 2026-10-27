import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import diagnostics from 'node:diagnostics_channel'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
// @ts-expect-error Node strip-types tests require the source extension.
import { createTraceRecorder, validTraceId, type TraceContext, type TraceName, type TraceNumbers } from './performance-trace.ts'

// local: a developer machine (FX0_TRACE=1), batched into .next files.
// preview: an opted-in Vercel preview (FX0_TRACE_PREVIEW=1), exported to the function log.
// Production is never traced.
export type ServerTraceMode = 'local' | 'preview'

export function serverTraceMode(): ServerTraceMode | null {
  if (process.env.VERCEL_ENV === 'production') return null
  if (!process.env.VERCEL) return process.env.FX0_TRACE === '1' ? 'local' : null
  return process.env.FX0_TRACE_PREVIEW === '1' && process.env.VERCEL_ENV === 'preview' ? 'preview' : null
}

export function serverTraceEnabled(): boolean {
  return serverTraceMode() != null
}

type Recorder = ReturnType<typeof createTraceRecorder>
interface TraceState {
  recorder: Recorder
  context: AsyncLocalStorage<TraceContext>
  turns: Map<string, TraceContext>
  flushing?: Promise<void>
  warned?: boolean
  served?: boolean
  marks: { registered?: number; loaded?: number }
}

// Process lifecycle marks, in ms of process uptime: when Next ran instrumentation's
// register() and when the prompt route's module was evaluated. Numbers only; they
// travel on request spans so a cold first request shows what was already loaded.
export function markProcess(kind: 'registered' | 'loaded'): void {
  const current = state()
  if (current) current.marks[kind] ??= Math.round(process.uptime() * 1000)
}
const globalTrace = globalThis as typeof globalThis & { __fx0PerformanceTrace?: TraceState }
const noop = (_attrs?: TraceNumbers) => {}

function state(): TraceState | undefined {
  const mode = serverTraceMode()
  if (!mode) return
  if (!globalTrace.__fx0PerformanceTrace) {
    // PIDs repeat across Vercel function instances, so a preview names its lane with a random per-process id.
    const lane = mode === 'preview' ? `server:${randomUUID()}` : `server:${process.pid}`
    globalTrace.__fx0PerformanceTrace = {
      recorder: createTraceRecorder({ enabled: true, process: lane, capacity: 10_000 }),
      context: new AsyncLocalStorage<TraceContext>(), turns: new Map(), marks: {},
    }
    // Local batches flush on a timer, best-effort, off the prompt's acknowledgement path. A
    // preview has no timer: a Vercel function can freeze right after its response.
    if (mode === 'local') {
      const timer = setInterval(() => { void flushServerTrace() }, 250)
      timer.unref()
    }
    observeNetwork(globalTrace.__fx0PerformanceTrace)
  }
  return globalTrace.__fx0PerformanceTrace
}

// Every undici client in the process, including copies bundled into dependencies such as
// libfx's Vercel World, publishes its requests on these channels. Observing them never
// changes a request. Only a fixed category, the status and the time to response headers
// are recorded: never the URL, path, headers or body.
export function networkCategory(origin: unknown, path: unknown): TraceName {
  let host = ''
  try { host = new URL(String(origin)).hostname } catch { return 'net.other' }
  if (host === 'api.vercel.com') return String(path).startsWith('/v1/workflow') ? 'net.workflow' : 'net.vercel_api'
  if (host === 'vercel-workflow.com' || host.endsWith('.vercel-workflow.com')) return 'net.workflow'
  if (host.includes('vercel-queue')) return 'net.queue'
  if (host === 'oidc.vercel.com') return 'net.oidc'
  if (host.endsWith('.upstash.io')) return 'net.redis'
  if (host.endsWith('.neon.tech')) return 'net.neon'
  if (host === 'ai-gateway.vercel.sh') return 'net.gateway'
  return 'net.other'
}

function observeNetwork(current: TraceState): void {
  const open = new WeakMap<object, (attrs?: TraceNumbers) => void>()
  const finish = (request: object, attrs: TraceNumbers) => {
    const end = open.get(request)
    if (!end) return
    open.delete(request)
    end(attrs)
    if (serverTraceMode() === 'preview') exportPreview(current)
  }
  diagnostics.subscribe('undici:request:create', (message) => {
    const request = (message as { request?: { origin?: unknown; path?: unknown } }).request
    if (!request || typeof request !== 'object') return
    open.set(request, current.recorder.start(networkCategory(request.origin, request.path), current.context.getStore()))
  })
  diagnostics.subscribe('undici:request:headers', (message) => {
    const { request, response } = message as { request?: object; response?: { statusCode?: unknown } }
    if (request) finish(request, { status: typeof response?.statusCode === 'number' ? response.statusCode : 0 })
  })
  diagnostics.subscribe('undici:request:error', (message) => {
    const { request } = message as { request?: object }
    if (request) finish(request, { failed: true })
  })
  // A new connection (DNS, TCP and TLS) gets its own span inside the request that opened
  // it, so connection setup separates from server time. Same rule: only the category.
  // undici passes a copy of connectParams to connected/connectError but the same connector,
  // so attempts pair by connector and destination, first in first out. The destination
  // only pairs events; it is never recorded.
  type ConnectMessage = { connector?: unknown; connectParams?: { protocol?: unknown; hostname?: unknown; port?: unknown } }
  const connecting = new WeakMap<object, { destination: string; end: (attrs?: TraceNumbers) => void }[]>()
  const destination = (params: NonNullable<ConnectMessage['connectParams']>) =>
    `${String(params.protocol ?? '')}//${String(params.hostname ?? '')}:${String(params.port ?? '')}`
  const connected = (message: unknown, attrs: TraceNumbers) => {
    const { connector, connectParams } = message as ConnectMessage
    if (!connector || typeof connector !== 'function' || !connectParams) return
    const pending = connecting.get(connector)
    const index = pending?.findIndex((attempt) => attempt.destination === destination(connectParams)) ?? -1
    if (!pending || index < 0) return
    const [attempt] = pending.splice(index, 1)
    attempt.end(attrs)
    if (serverTraceMode() === 'preview') exportPreview(current)
  }
  diagnostics.subscribe('undici:client:beforeConnect', (message) => {
    const { connector, connectParams } = message as ConnectMessage
    if (!connector || typeof connector !== 'function' || !connectParams) return
    const category = networkCategory(`${String(connectParams.protocol ?? 'https:')}//${String(connectParams.hostname ?? '')}`, '')
    const pending = connecting.get(connector) ?? []
    pending.push({
      destination: destination(connectParams),
      end: current.recorder.start(category.replace('net.', 'connect.') as TraceName, current.context.getStore()),
    })
    connecting.set(connector, pending)
  })
  diagnostics.subscribe('undici:client:connected', (message) => connected(message, {}))
  diagnostics.subscribe('undici:client:connectError', (message) => connected(message, { failed: true }))
}

// A preview's completed records leave as one JSON line tagged 'fx0:trace', at each span end
// or instant event, so a log collector can parse it. The recorder's allowlists decide the
// payload; nothing is written to disk. Logging is best-effort: a failed write must never
// reach the request, and a missing line only leaves the report incomplete.
function exportPreview(current: TraceState): void {
  try {
    const batch = current.recorder.drain()
    if (batch.traceEvents.length || batch.dropped) console.info(JSON.stringify({ event: 'fx0:trace', ...batch }))
  } catch {
    // Deliberately silent: the request outcome does not depend on diagnostics.
  }
}

export function serverTraceContext(sessionId: string, turnId?: number): TraceContext {
  const current = state()
  const bound = turnId == null ? undefined : current?.turns.get(`${sessionId}:${turnId}`)
  return { ...(bound ?? current?.context.getStore()), sessionId, ...(turnId == null ? {} : { turnId }) }
}

// Correlation is process-local. Session and turn IDs still join recovery traces
// after a restart; tracing adds no persistent data to the durable conversation.
export function bindPromptTrace(sessionId: string, turnId: number): void {
  const current = state()
  if (!current) return
  const key = `${sessionId}:${turnId}`
  current.turns.delete(key)
  current.turns.set(key, { ...current.context.getStore(), sessionId, turnId })
  if (current.turns.size > 256) current.turns.delete(current.turns.keys().next().value!)
}

export function traceServer(name: TraceName, context?: TraceContext, attrs?: TraceNumbers): (attrs?: TraceNumbers) => void {
  const current = state()
  if (!current) return noop
  const end = current.recorder.start(name, context ?? current.context.getStore(), attrs)
  if (serverTraceMode() !== 'preview') return end
  return (result) => { end(result); exportPreview(current) }
}

export function traceServerEvent(name: TraceName, context?: TraceContext, attrs?: TraceNumbers): void {
  const current = state()
  if (!current) return
  current.recorder.instant(name, context ?? current.context.getStore(), attrs)
  if (serverTraceMode() === 'preview') exportPreview(current)
}

export function traceAsync<T>(name: TraceName, context: TraceContext | undefined, work: () => Promise<T>, attrs?: TraceNumbers): Promise<T> {
  // Preserve the original promise path when tracing is off.
  if (!serverTraceEnabled()) return work()
  const end = traceServer(name, context, attrs)
  return (async () => {
    try { return await work() } catch (error) { end({ failed: true }); throw error } finally { end() }
  })()
}

export function runRequestTrace<T>(request: Request, work: () => Promise<T>): Promise<T> {
  const current = state()
  if (!current) return work()
  const incoming = request.headers.get('x-fx0-trace')
  const traceId = validTraceId(incoming) ? incoming : randomUUID().replaceAll('-', '')
  // How long this process had lived when the request began, and whether it is the first
  // traced request it serves: a small uptime on a first request marks a cold instance.
  const processAttrs = { uptime: Math.round(process.uptime() * 1000), first: !current.served, ...current.marks }
  current.served = true
  return current.context.run({ traceId }, () => traceAsync('request.handle', undefined, work, processAttrs))
}

export function serverTraceSnapshot() {
  return globalTrace.__fx0PerformanceTrace?.recorder.snapshot() ?? { traceEvents: [], displayTimeUnit: 'ms', dropped: 0 }
}

export async function flushServerTrace(): Promise<void> {
  const current = globalTrace.__fx0PerformanceTrace
  if (!current) return
  const mode = serverTraceMode()
  // A preview exports on every span end; only a local run writes files.
  if (mode === 'preview') {
    exportPreview(current)
    return
  }
  if (mode !== 'local') return
  if (current.flushing) return current.flushing
  // Drain only once per batch; failures lose diagnostic events, never product work.
  const batch = current.recorder.drain()
  if (!batch.traceEvents.length && !batch.dropped) return
  current.flushing = (async () => {
    try {
      const directory = path.join(process.cwd(), '.next', 'fx0-traces')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await appendFile(path.join(directory, `server-${process.pid}.jsonl`), `${JSON.stringify(batch)}\n`, { mode: 0o600 })
    } catch {
      if (!current.warned) {
        current.warned = true
        console.warn('[fx0] local performance trace could not be written')
      }
    }
  })().finally(() => { current.flushing = undefined })
  return current.flushing
}
