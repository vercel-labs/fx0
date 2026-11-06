// The design screenshot protocol, shared by the server, the frame and the app.
//
// 1. A screenshot_design call opens a capture in Redis and emits a `capture` event, then
//    blocks on Redis (lib/journal.ts). A tab that receives the event acknowledges it at
//    once; a call nobody acknowledges within CAPTURE_ACK_MS fails fast, and an acknowledged
//    one waits for a photo or a failure.
// 2. The tab answers: the preview on screen when it shows the asked revision, otherwise a
//    hidden copy of the frame (components/design-capture.tsx).
// 3. The app asks the frame's wrapper, the wrapper asks the design, and the capture library
//    photographs the design inside its own frame, where the CSP allows no network
//    (lib/design-capture.ts). The photo travels back as Blobs, or the reason there is none.
// 4. The tab posts the photo, or the failure, to /api/capture, which hands it to the call.

/** The app asks a preview wrapper for a photo. */
export const CAPTURE_REQUEST = 'fx0-capture'
/** A preview wrapper returns the design's photo, or none. */
export const CAPTURE_REPLY = 'fx0-artifact-captured'
/** The tab's part of a capture's trace, sent with the photo as JSON. */
export const CAPTURE_TIMING_HEADER = 'x-fx0-capture-timing'

/** Where the frame's time went, on the frame's own clock. */
export interface FrameTiming {
  fontsMs: number
  libraryMs: number
  encodeMs: number
}

/** Why a tab that acknowledged a capture sends no photo. */
export const CAPTURE_FAILURES = {
  'too-large': 'the page did not fit the screenshot size limit even at low quality',
  'capture-failed': 'the capture library failed on this design',
  'not-painted': 'the design did not finish painting in time',
  'no-reply': 'the design did not answer the capture request in time',
  'refused': 'the photo the tab sent was refused as not a valid image',
} as const
export type CaptureFailure = keyof typeof CAPTURE_FAILURES

export interface CaptureReply {
  type: typeof CAPTURE_REPLY
  cid: string
  // Set when the frame could not photograph the design; blobs is then empty.
  error?: CaptureFailure
  // The viewport, or the whole page cut into viewport-high tiles, top to bottom.
  blobs: Blob[]
  width?: number
  // The photographed height: the viewport, or the page.
  height?: number
  // A full page taller than MAX_CAPTURE_TILES viewports: the tiles stop before its end.
  truncated?: boolean
  timing?: FrameTiming
}

/** What the tab and /api/capture add to a photo for its trace. */
export interface ShotTiming {
  path: 'preview' | 'hidden'
  receivedAt: number // tab clock
  sentAt: number // tab clock
  previewWaitMs: number
  roundTripMs: number
  frame: FrameTiming | null
  arrivedAt: number // server clock
  authMs: number
  readMs: number
  storingAt: number // server clock, as the Redis write starts
}

/** Every image of one capture together, held in Redis as base64 within a single request. */
export const MAX_CAPTURE_BYTES = 600 * 1024
/** A full page is returned as at most this many viewport-high tiles: one tool result's image limit. */
export const MAX_CAPTURE_TILES = 8
/** How long the tool call waits for a tab to acknowledge the request before failing. */
export const CAPTURE_ACK_MS = 5_000
/** The capture library's own limit inside the frame. */
export const CAPTURE_LIBRARY_MS = 20_000
/** How long a tab may take to return a photo once it asks the frame. */
export const CAPTURE_TAB_MS = CAPTURE_LIBRARY_MS + 5_000
/** How long the preview may take to start loading the asked revision before the hidden copy answers. */
export const CAPTURE_PREVIEW_START_MS = 3_000
/** How long a frame loading the asked revision may take to paint it. */
export const CAPTURE_PAINT_MS = 15_000
/** How long an acknowledged call waits: a hand-off to the hidden copy after a slow start still fits. */
export const CAPTURE_WAIT_MS = CAPTURE_PREVIEW_START_MS + CAPTURE_PAINT_MS + CAPTURE_TAB_MS + 5_000
/** The hidden copy's viewport, when no preview is on screen. */
export const CAPTURE_VIEWPORT = { width: 1280, height: 800 }
/** The viewport widths a capture may ask for, in CSS px. */
export const CAPTURE_WIDTH = { min: 320, max: 1920 } as const

/** A requested capture width, rounded into CAPTURE_WIDTH; undefined when none was asked. */
export function captureWidth(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(CAPTURE_WIDTH.max, Math.max(CAPTURE_WIDTH.min, Math.round(value)))
}

/** What the tool call measured itself, on the turn's server clock. */
interface ServerTiming {
  totalMs: number
  setupMs: number
  emitMs: number
  emittedAt: number // server clock, as the request left
  receivedAt: number // server clock, as the photo arrived
}

/**
 * One capture, end to end, in whole milliseconds, as the tool call logs it (capture:trace).
 * Local durations are measured on one clock. Delivery, upload and store-and-wake are
 * estimates comparing machines' clocks. networkMs cancels a fixed browser clock offset,
 * but not differences between the upload and turn servers. It includes transport and
 * delivery queues, not just wire time; negative one-way estimates can indicate clock skew.
 */
export function captureTrace(server: ServerTiming, shot: ShotTiming) {
  const ms = (n: number) => Math.round(n)
  const deliveryMs = shot.receivedAt - server.emittedAt
  const uploadMs = shot.arrivedAt - shot.sentAt
  const frame = shot.frame
  return {
    path: shot.path,
    totalMs: ms(server.totalMs),
    setupMs: ms(server.setupMs),
    emitMs: ms(server.emitMs),
    deliveryMs: ms(deliveryMs),
    previewWaitMs: ms(shot.previewWaitMs),
    messagingMs: ms(frame ? shot.roundTripMs - frame.fontsMs - frame.libraryMs - frame.encodeMs : shot.roundTripMs),
    fontsMs: frame ? ms(frame.fontsMs) : null,
    libraryMs: frame ? ms(frame.libraryMs) : null,
    encodeMs: frame ? ms(frame.encodeMs) : null,
    uploadMs: ms(uploadMs),
    networkMs: ms(deliveryMs + uploadMs),
    authMs: ms(shot.authMs),
    readMs: ms(shot.readMs),
    storeAndWakeMs: ms(server.receivedAt - shot.storingAt),
  }
}
