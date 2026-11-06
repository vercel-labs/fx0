import { CAPTURE_FAILURES, CAPTURE_TIMING_HEADER, MAX_CAPTURE_BYTES, MAX_CAPTURE_TILES, type CaptureFailure, type FrameTiming, type ShotTiming } from '../../../lib/capture-protocol'
import { imageDimensions, sniffImageType } from '../../../lib/image-sniff'
import { acknowledgeCapture, answerCapture } from '../../../lib/journal'
import { withSessionRoute } from '../../../lib/route-auth'
import { INSTANCE, log } from '../../../lib/session'

// Match /api/prompt so this route can share its function's warm instances.
// The platform still decides which instance handles each request.
export const maxDuration = 800

const CAPTURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CAPTURE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_SIDE = 16384

type TabTiming = Pick<ShotTiming, 'path' | 'receivedAt' | 'sentAt' | 'previewWaitMs' | 'roundTripMs' | 'frame'>

// The tab's part of the trace. It only labels the photo, so anything malformed is dropped.
function tabTiming(header: string | null): TabTiming | null {
  try {
    const value = JSON.parse(header ?? 'null')
    const number = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null)
    const [receivedAt, sentAt, previewWaitMs, roundTripMs] = [value?.receivedAt, value?.sentAt, value?.previewWaitMs, value?.roundTripMs].map(number)
    if (receivedAt === null || sentAt === null || previewWaitMs === null || roundTripMs === null) return null
    const frameParts = [value.frame?.fontsMs, value.frame?.libraryMs, value.frame?.encodeMs].map(number)
    const frame: FrameTiming | null = frameParts.every((n) => n !== null)
      ? { fontsMs: frameParts[0]!, libraryMs: frameParts[1]!, encodeMs: frameParts[2]! }
      : null
    return { path: value.path === 'hidden' ? 'hidden' : 'preview', receivedAt, sentAt, previewWaitMs, roundTripMs, frame }
  } catch {
    return null
  }
}

// A tab's reply for screenshot_design (lib/capture-protocol.ts): `?ack=1` as it takes the
// request, then either `?failed=<reason>` or the photo itself, one image or a full page's
// tiles, as multipart form data. Every reply counts only for the capture the tool call is
// waiting on; `ok: false` tells the tab it is no longer open.
type CaptureRouteTiming = { authMs?: number; readMs?: number; storeMs?: number }

const handle = (arrivedAt: number, arrived: number, metrics: CaptureRouteTiming) => withSessionRoute(async (request, { id: sessionId }) => {
  const authMs = metrics.authMs = performance.now() - arrived
  const params = new URL(request.url).searchParams
  const cid = params.get('cid') ?? ''
  if (!CAPTURE_ID.test(cid)) return Response.json({ error: 'invalid capture' }, { status: 400 })
  if (params.get('ack') === '1') {
    const storing = performance.now()
    const ok = await acknowledgeCapture(sessionId, cid)
    metrics.storeMs = performance.now() - storing
    return Response.json({ ok })
  }
  const failed = params.get('failed')
  if (failed !== null) {
    if (!Object.hasOwn(CAPTURE_FAILURES, failed)) return Response.json({ error: 'invalid capture' }, { status: 400 })
    const accepted = await answerCapture(sessionId, cid, { kind: 'failed', reason: failed as CaptureFailure })
    log(sessionId, 'capture:failed', { reason: failed, accepted })
    return Response.json({ ok: accepted })
  }
  // A refused photo still answers the capture, so the call stops waiting and says why.
  const refuse = async (status: number, error: string, reason: CaptureFailure) => {
    const accepted = await answerCapture(sessionId, cid, { kind: 'failed', reason })
    log(sessionId, 'capture:refused', { status, reason, accepted })
    return Response.json({ error }, { status })
  }
  // A multipart body adds a few hundred bytes per image around the images themselves. A
  // browser always sends its length; one without it is refused before it is read.
  const length = Number(request.headers.get('content-length'))
  if (!(length > 0)) return refuse(411, 'length required', 'refused')
  if (length > MAX_CAPTURE_BYTES + 4096) return refuse(413, 'capture too large', 'too-large')
  const reading = performance.now()
  let files: File[]
  try {
    files = (await request.formData()).getAll('image').filter((entry): entry is File => entry instanceof File)
  } catch {
    return refuse(400, 'invalid capture', 'refused')
  }
  if (!files.length || files.length > MAX_CAPTURE_TILES) return refuse(400, 'invalid capture', 'refused')
  const bytes = files.reduce((sum, file) => sum + file.size, 0)
  if (bytes > MAX_CAPTURE_BYTES) return refuse(413, 'capture too large', 'too-large')
  const images: { mimeType: string; data: string }[] = []
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    // A header that names an image is not enough: one the model's provider cannot size would
    // fail the whole model request.
    const mimeType = sniffImageType(bytes)
    const dimensions = mimeType && CAPTURE_TYPES.has(mimeType) ? imageDimensions(bytes, mimeType) : null
    if (!mimeType || !dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_SIDE || dimensions.height > MAX_SIDE) {
      return refuse(415, 'capture is not an image', 'refused')
    }
    images.push({ mimeType, data: Buffer.from(bytes).toString('base64') })
  }
  const readMs = metrics.readMs = performance.now() - reading
  // The viewport the tab photographed only labels the photo for the model.
  const size = (name: string) => { const n = Number(params.get(name)); return Number.isInteger(n) && n > 0 && n <= MAX_SIDE ? n : undefined }
  const tab = tabTiming(request.headers.get(CAPTURE_TIMING_HEADER))
  // The timing travels with the photo, so the waiting tool call can log the whole trace.
  const submitting = performance.now()
  const timing: ShotTiming | undefined = tab ? { ...tab, arrivedAt, authMs, readMs, storingAt: Date.now() } : undefined
  const accepted = await answerCapture(sessionId, cid, {
    kind: 'shot', shot: { images, width: size('w'), height: size('h'), truncated: params.get('truncated') === '1', timing },
  })
  metrics.storeMs = performance.now() - submitting
  // Not accepted: the call stopped waiting (closed by a timeout, a cancel or an earlier answer).
  log(sessionId, accepted ? 'capture:accepted' : 'capture:closed', { images: images.length, bytes, submitMs: Math.round(metrics.storeMs) })
  return Response.json({ ok: accepted })
})

export async function POST(request: Request): Promise<Response> {
  const started = performance.now()
  const metrics: CaptureRouteTiming = {}
  const response = await handle(Date.now(), started, metrics)(request)
  const timings = { route: performance.now() - started, ...metrics }
  response.headers.set('server-timing', Object.entries(timings)
    .filter(([, value]) => Number.isFinite(value))
    .map(([name, value]) => `${name};dur=${value!.toFixed(2)}`).join(', '))
  response.headers.set('x-fx0-instance', INSTANCE)
  return response
}
