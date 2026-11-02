'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { designLinkUrl } from '../lib/design-link'
import { EMPTY_DRAFT_DOCUMENT, patchDraftDocument } from '../lib/draft-preview'
import { CAPTURE_PAINT_MS, CAPTURE_PREVIEW_START_MS, type CaptureFailure } from '../lib/capture-protocol'
import { captureFrame, reportCaptureFailure, sendCapture, type CaptureRequest } from './design-capture'
import { isPreviewErrorStatus, MAX_RENDER_HTML_LENGTH, PREVIEW_PREPARE_MS, PREVIEW_PROTOCOL, type PreviewPayload } from '../lib/preview-update'
import { AuthRouteError, fetchUi, signalAuthRequired, uiAuthError } from './auth-ui'
import DesignLinkDialog from './design-link-dialog'
import { HowItWorksPanel } from './how-it-works'

// After the link dialog closes, a design's asks are ignored this long: the click
// that closed it is a fresh gesture the design could otherwise spend at once.
const LINK_PAUSE_MS = 2000

export type PreviewSource = { kind: 'design'; sessionId: string; revision: number }

type PreviewSlot = {
  mountUrl: string
  requestedRevision: number
  appliedRevision: number | null
  documentId: string | null
  updateReady: boolean
}

type PreviewDisplay = {
  scope: string
  slots: [PreviewSlot | null, PreviewSlot | null]
  front: number | null
  error: string | null
}

type PreviewAttempt = {
  revision: number
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | null
  requestId: string
  posted: { index: number; documentId: string; revision: number } | null
}

function isPreviewPayload(value: unknown): value is PreviewPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<PreviewPayload>
  return payload.protocol === PREVIEW_PROTOCOL && typeof payload.sessionId === 'string'
    && Number.isSafeInteger(payload.revision) && payload.revision! > 0
    && typeof payload.sourceHtml === 'string' && new TextEncoder().encode(payload.sourceHtml).length <= 512 * 1024
    && typeof payload.renderHtml === 'string' && payload.renderHtml.length <= MAX_RENDER_HTML_LENGTH
    && Array.isArray(payload.images) && payload.images.length <= 12 && payload.images.every((image) => {
      if (image == null || typeof image.marker !== 'string' || !image.marker || image.marker.length > 256 || typeof image.src !== 'string') return false
      try {
        const url = new URL(image.src, window.location.href)
        return url.origin === window.location.origin && url.pathname === '/api/artifact-image' && !url.username && !url.password
      } catch { return false }
    })
}

export default function PreviewPane({
  source,
  viewing,
  draft = null,
  accessAllowed = true,
  intro,
  onClose,
  capture = null,
  onCaptureDone,
}: {
  source: PreviewSource
  // A past revision opened from the transcript's "View" link, never the latest; null is the latest.
  viewing: number | null
  // The design as the model writes it; shown until the first real publish paints.
  draft?: string | null
  // Explicit revocation hides every private layer, including retained drafts and links.
  accessAllowed?: boolean
  // Only an empty chat explains fx0; a chat waiting on its first design stays blank.
  intro: boolean
  onClose: () => void
  // A screenshot_design request; the preview answers from the frame on screen.
  capture?: CaptureRequest | null
  // Whether this preview answered (a photo or a failure); when not, the hidden copy should.
  onCaptureDone?: (cid: string, answered: boolean) => void
}) {
  const scope = JSON.stringify([source.sessionId, viewing, accessAllowed])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const frames = useRef<(HTMLIFrameElement | null)[]>([null, null])
  const demand = useRef<(revision: number, retry?: boolean) => void>(() => {})
  const retry = useRef(() => {})
  // Capture and hot application share a document: never mutate it mid-photo.
  const capturingScope = useRef<string | null>(null)
  const canCapture = useRef<() => boolean>(() => false)
  const resumeUpdates = useRef(() => {})
  const [display, setDisplay] = useState<PreviewDisplay>(() => {
    const revision = accessAllowed && source.revision > 0 ? (viewing ?? source.revision) : 0
    const slot: PreviewSlot | null = revision > 0 ? {
      mountUrl: `/api/artifact-frame?session=${encodeURIComponent(source.sessionId)}&${viewing == null ? 'v' : 'revision'}=${revision}`,
      requestedRevision: revision, appliedRevision: null, documentId: null, updateReady: false,
    } : null
    return { scope, slots: [slot, null], front: slot ? 0 : null, error: null }
  })
  // Hydration adopts this exact HTML load. Keep it through Strict Mode's effect
  // replay, but never reuse it after navigation to a different document scope.
  const initialDisplay = useRef<PreviewDisplay | null>(display)
  const [linkRequest, setLinkRequest] = useState<{ scope: string; url: string } | null>(null)
  const linksPausedUntil = useRef(0)
  const closeLinkRequest = useCallback(() => {
    linksPausedUntil.current = Date.now() + LINK_PAUSE_MS
    setLinkRequest(null)
  }, [])

  useEffect(() => {
    if (!accessAllowed) {
      initialDisplay.current = null
      setDisplay({ scope, slots: [null, null], front: null, error: null })
      setLinkRequest(null)
      demand.current = () => {}
      retry.current = () => {}
      canCapture.current = () => false
      resumeUpdates.current = () => {}
      return
    }
    const sessionId = source.sessionId
    const session = encodeURIComponent(sessionId)
    const initial = initialDisplay.current?.scope === scope ? initialDisplay.current : null
    if (!initial) initialDisplay.current = null
    const slots: [PreviewSlot | null, PreviewSlot | null] = [initial?.slots[0] ? { ...initial.slots[0] } : null, null]
    let front = initial?.front ?? null
    let desired = slots[0]?.requestedRevision ?? 0
    let error: string | null = null
    let disposed = false
    let attempt: PreviewAttempt | null = null
    let loading: number | null = slots[0] ? 0 : null
    let loadTimer: ReturnType<typeof setTimeout> | null = null
    let loadClock: { remaining: number; checkedAt: number; visible: boolean } | null = null
    const active = () => !disposed && currentScope.current === scope
    const urlFor = (revision: number) => `/api/artifact-frame?session=${session}&${viewing == null ? 'v' : 'revision'}=${revision}`
    const publish = () => {
      if (active()) setDisplay({ scope, slots: [slots[0] && { ...slots[0] }, slots[1] && { ...slots[1] }], front, error })
    }
    const cancelPosted = () => {
      if (!attempt?.posted) return
      const { index, documentId } = attempt.posted
      frames.current[index]?.contentWindow?.postMessage({
        type: 'fx0-preview-cancel', protocol: PREVIEW_PROTOCOL, requestId: attempt.requestId, documentId,
      }, window.location.origin)
    }
    const clearAttempt = () => {
      if (attempt?.timer) clearTimeout(attempt.timer)
      attempt?.controller.abort()
      attempt = null
    }
    const clearLoading = () => {
      if (loadTimer) clearTimeout(loadTimer)
      loadTimer = null
      loadClock = null
      if (loading != null) {
        slots[loading] = null
        if (front === loading) front = null
      }
      loading = null
    }
    const fail = (message: string) => {
      error = message
      publish()
    }
    const watchLoad = (index: number) => {
      const clock = { remaining: PREVIEW_PREPARE_MS * 2, checkedAt: Date.now(), visible: document.visibilityState === 'visible' }
      loadClock = clock
      const check = () => {
        if (!active() || loading !== index || loadClock !== clock) return
        const now = Date.now(), elapsed = now - clock.checkedAt, visible = document.visibilityState === 'visible'
        // Painting waits on animation frames. Hidden or suspended time cannot prove
        // that a loaded document failed; acquisition/preparation keep their own bounds.
        if (clock.visible && visible && elapsed <= 3000) clock.remaining -= Math.max(0, elapsed)
        clock.checkedAt = now
        clock.visible = visible
        if (visible && elapsed > 3000) frames.current[index]?.contentWindow?.postMessage({ type: 'fx0-preview-status', protocol: PREVIEW_PROTOCOL }, window.location.origin)
        if (clock.remaining <= 0) {
          clearLoading()
          fail('The design preview did not finish loading. Try again.')
          return
        }
        loadTimer = setTimeout(check, 500)
      }
      loadTimer = setTimeout(check, 500)
    }
    const onVisibilityChange = () => {
      if (!active() || !loadClock) return
      loadClock.checkedAt = Date.now()
      loadClock.visible = document.visibilityState === 'visible'
      if (loadClock.visible && loading != null) frames.current[loading]?.contentWindow?.postMessage({ type: 'fx0-preview-status', protocol: PREVIEW_PROTOCOL }, window.location.origin)
    }
    if (loading != null) watchLoad(loading)
    const loadFull = (revision: number) => {
      // A document load does not pass through fetchUi, so it honors the same closed gate here.
      const blocked = uiAuthError()
      if (blocked) {
        fail(blocked.message)
        return
      }
      const index = front == null ? 0 : 1 - front
      // Never reuse a URL as evidence of document identity, including after a hot
      // patch. A distinct mount URL also rejects queued messages from the old page
      // in this slot's (stable) WindowProxy.
      slots[index] = {
        mountUrl: `${urlFor(revision)}&mount=${crypto.randomUUID()}`,
        requestedRevision: revision, appliedRevision: null, documentId: null, updateReady: false,
      }
      loading = index
      watchLoad(index)
      publish()
    }

    const pump = async () => {
      if (!active() || !desired || error || attempt || loading != null || capturingScope.current === scope) return
      const shown = front == null ? null : slots[front]
      // Nothing is on screen yet, so the document itself is the first paint: no JSON round trip.
      if (!shown) {
        loadFull(desired)
        return
      }
      // A legacy wrapper can confirm a full load, but cannot advertise hot updates.
      if (shown && (shown.appliedRevision ?? shown.requestedRevision) >= desired) return
      const next: PreviewAttempt = {
        revision: desired, controller: new AbortController(), timer: null,
        requestId: crypto.randomUUID(), posted: null,
      }
      attempt = next
      const deadline = Date.now() + PREVIEW_PREPARE_MS
      next.timer = setTimeout(() => next.controller.abort(), PREVIEW_PREPARE_MS)
      const isCurrent = () => active() && attempt === next
      try {
        // Updates read the entire body under the same deadline, not just headers.
        // The initial server-rendered artifact loads HTML directly instead.
        const response = await fetchUi(`${urlFor(next.revision)}&format=json`, {
          signal: next.controller.signal, cache: 'no-store',
        })
        if (!isCurrent()) return
        if (response.status === 404) throw new Error('This design is not available. Try again.')
        const unsupported = [400, 406, 415, 501].includes(response.status)
        if (!response.ok && !unsupported) throw new Error('The design could not be loaded. Try again.')
        const body = await response.text()
        if (!isCurrent()) return
        if (Date.now() >= deadline || next.controller.signal.aborted) throw new Error('Preview request timed out. Try again.')
        let payload: unknown = null
        if (!unsupported && response.headers.get('content-type')?.includes('application/json')) {
          try { payload = JSON.parse(body) } catch { /* An older or unknown representation uses HTML once. */ }
        }
        if (Date.now() >= deadline) throw new Error('Preview request timed out. Try again.')
        if (next.timer) clearTimeout(next.timer)
        next.timer = null
        if (!isPreviewPayload(payload)) {
          clearAttempt()
          loadFull(desired)
          return
        }
        if (payload.sessionId !== sessionId || (viewing == null ? payload.revision < desired : payload.revision !== viewing)) {
          throw new Error('The requested design version is not available yet. Try again.')
        }
        // A response may already be ahead of its journal event. Never send an
        // older revision back into the confirmed document.
        if (shown?.appliedRevision != null && payload.revision <= shown.appliedRevision) {
          clearAttempt()
          return
        }
        // Acquisition can finish after a photo started; leave desired queued until it ends.
        if (capturingScope.current === scope) {
          clearAttempt()
          return
        }
        if (viewing != null || !shown?.updateReady || !shown.documentId || front == null) {
          clearAttempt()
          loadFull(payload.revision)
          return
        }
        const targetWindow = frames.current[front]?.contentWindow
        if (!targetWindow) throw new Error('The design preview is unavailable. Try again.')
        next.posted = { index: front, documentId: shown.documentId, revision: payload.revision }
        targetWindow.postMessage({
          type: 'fx0-preview-update', protocol: PREVIEW_PROTOCOL, requestId: next.requestId,
          documentId: shown.documentId, baseRevision: shown.appliedRevision, payload,
        }, window.location.origin)
        // The wrapper owns image preparation and its visible-time ACK deadline.
        // Keep this attempt occupied until its result, even if desired moves on.
      } catch (cause) {
        if (!isCurrent()) return
        const timedOut = Date.now() >= deadline || next.controller.signal.aborted
        clearAttempt()
        fail(cause instanceof AuthRouteError ? cause.message
          : timedOut ? 'Preview request timed out. Try again.'
            : cause instanceof Error && cause.message ? cause.message : 'The design could not be loaded. Try again.')
      }
    }

    demand.current = (revision, again = false) => {
      const target = revision > 0 ? (viewing ?? revision) : 0
      // Zero also represents revoked access. It must clear the private document,
      // rather than be treated as an older journal event to ignore.
      if (!target) {
        cancelPosted()
        clearAttempt()
        clearLoading()
        slots[0] = slots[1] = null
        front = null
        desired = 0
        error = null
        initialDisplay.current = null
        publish()
        return
      }
      const newest = viewing == null ? Math.max(desired, target) : target
      if (newest === desired && !again) return
      desired = newest
      error = null
      if (attempt?.posted) {
        // Cancel delegated preparation, but do not assume cancellation undid a
        // mutation. Its result (or a new document) must release the apply lane.
        cancelPosted()
      } else {
        clearAttempt()
      }
      clearLoading()
      publish()
      void pump()
    }
    retry.current = () => demand.current(desired, true)
    canCapture.current = () => active() && !attempt?.posted && capturingScope.current !== scope
    resumeUpdates.current = () => { void pump() }
    setLinkRequest(null)
    publish()

    const onMessage = (event: MessageEvent) => {
      if (!active() || event.origin !== window.location.origin) return
      const index = frames.current.findIndex((frame) => frame?.contentWindow === event.source)
      const slot = slots[index]
      if (!slot || (index !== front && index !== loading)) return
      // Source equality alone survives iframe navigation. Check the actual wrapper
      // URL as well before accepting the first document ID for this mount.
      try {
        if (frames.current[index]?.contentDocument?.URL !== new URL(slot.mountUrl, window.location.origin).href) return
      } catch { return }
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'fx0-artifact-open') {
        const url = designLinkUrl(data.url)
        if (index !== front || !url || Date.now() < linksPausedUntil.current) return
        setLinkRequest((current) => current ?? { scope, url })
        return
      }
      if (data.type === 'fx0-preview-error') {
        // Only the frame being loaded can fail the preview; a shown design keeps its place.
        if (index !== loading || data.protocol !== PREVIEW_PROTOCOL || !isPreviewErrorStatus(data.status)) return
        clearLoading()
        fail(data.status === 401 || data.status === 403 ? signalAuthRequired(data.status).message
          : data.status === 404 ? 'This design is not available. Try again.'
            : 'The design could not be loaded. Try again.')
        return
      }
      if (data.type === 'fx0-preview-result') {
        const posted = attempt?.posted
        if (!posted || index !== front || posted.index !== index || data.protocol !== PREVIEW_PROTOCOL
          || data.requestId !== attempt?.requestId || data.documentId !== posted.documentId
          || data.documentId !== slot.documentId || data.sessionId !== sessionId || data.revision !== posted.revision
          || !['applied', 'reload', 'error'].includes(data.status)) return
        const superseded = attempt!.revision < desired
        clearAttempt()
        if (data.status === 'applied') {
          slot.appliedRevision = Math.max(slot.appliedRevision ?? 0, data.revision)
          error = null
          publish()
          void pump()
        } else if (data.status === 'reload') {
          // Read latest again: a newer publish can have arrived during preparation.
          loadFull(Math.max(desired, data.revision))
        } else if (superseded) {
          void pump()
        } else {
          fail('The design update could not be applied. Your previous preview is still shown. Try again.')
        }
        return
      }
      if (data.type !== 'fx0-artifact-painted') return
      const legacy = data.protocol === undefined && data.sessionId === undefined && data.revision === undefined
        && data.documentId === undefined && data.updateReady === undefined
      if (!legacy && (data.protocol !== PREVIEW_PROTOCOL || data.sessionId !== sessionId
        || !Number.isSafeInteger(data.revision) || data.revision < slot.requestedRevision
        || typeof data.documentId !== 'string' || !data.documentId || typeof data.updateReady !== 'boolean')) return
      const revision = legacy ? slot.requestedRevision : data.revision as number
      const confirmed = front == null ? null : slots[front]?.appliedRevision
      if ((viewing != null && revision !== viewing) || (index !== front && revision < desired)
        || (viewing == null && confirmed != null && revision < confirmed)) return
      if (index === front && loading !== index && slot.documentId === (legacy ? null : data.documentId)
        && (slot.appliedRevision ?? slot.requestedRevision) === revision
        && slot.updateReady === (!legacy && data.updateReady)) return
      // Recovery keeps the wrapper WindowProxy but installs a new child document.
      // Invalidate work tied to the previous document before accepting that paint.
      if (slot.documentId !== (legacy ? null : data.documentId)) {
        cancelPosted()
        clearAttempt()
        setLinkRequest(null)
      }
      slot.appliedRevision = legacy ? null : revision
      slot.documentId = legacy ? null : data.documentId
      slot.updateReady = !legacy && data.updateReady
      if (loading === index) {
        if (loadTimer) clearTimeout(loadTimer)
        loadTimer = null
        loadClock = null
        loading = null
        // Old documents are deliberately not cached after cross-document navigation.
        slots[1 - index] = null
        front = index
        setLinkRequest(null)
      }
      error = null
      publish()
      void pump()
    }
    window.addEventListener('message', onMessage)
    document.addEventListener('visibilitychange', onVisibilityChange)
    // The SSR iframe can paint before hydration installs this listener.
    for (const frame of frames.current) frame?.contentWindow?.postMessage({ type: 'fx0-preview-status', protocol: PREVIEW_PROTOCOL }, window.location.origin)
    return () => {
      disposed = true
      cancelPosted()
      clearAttempt()
      clearLoading()
      window.removeEventListener('message', onMessage)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      demand.current = () => {}
      retry.current = () => {}
      canCapture.current = () => false
      resumeUpdates.current = () => {}
    }
  }, [source.sessionId, viewing, scope, accessAllowed])

  useEffect(() => {
    demand.current(source.revision)
  }, [source.sessionId, source.revision, viewing])

  const current = display.scope === scope
  const slots: PreviewDisplay['slots'] = current ? display.slots : [null, null]
  const front = current ? display.front : null
  // Hot patches keep the mount URL: only the confirmed applied revision identifies
  // the design on screen. Never capture a frame retained from another scope.
  const captureDone = useRef(onCaptureDone)
  captureDone.current = onCaptureDone
  const waitingCapture = useRef<{ request: CaptureRequest; timer: ReturnType<typeof setTimeout>; loading: boolean } | null>(null)
  const settleCapture = (request: CaptureRequest): boolean => {
    if (waitingCapture.current?.request !== request) return false
    clearTimeout(waitingCapture.current.timer)
    waitingCapture.current = null
    return true
  }
  const handOffCapture = (request: CaptureRequest) => {
    if (settleCapture(request)) captureDone.current?.(request.cid, false)
  }
  const failCapture = (request: CaptureRequest, reason: CaptureFailure = 'not-painted') => {
    if (settleCapture(request)) void reportCaptureFailure(request, reason).finally(() => captureDone.current?.(request.cid, true))
  }
  useEffect(() => {
    if (!capture) return
    const request = capture
    waitingCapture.current = { request, timer: setTimeout(() => handOffCapture(request), CAPTURE_PREVIEW_START_MS), loading: false }
    return () => handOffCapture(request)
  }, [capture?.cid, scope]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const waiting = waitingCapture.current
    if (!waiting) return
    const { request } = waiting
    if (!accessAllowed || !current || request.sessionId !== source.sessionId || viewing != null) return handOffCapture(request)
    const index = slots.findIndex((slot) => slot?.appliedRevision === request.revision)
    const frame = index < 0 ? null : frames.current[index]
    if (!frame && source.revision !== request.revision) return
    if (frame && frame.getBoundingClientRect().width < 1) return handOffCapture(request)
    if (!frame || front !== index || !frame.contentWindow) {
      if (!waiting.loading) {
        clearTimeout(waiting.timer)
        waiting.loading = true
        waiting.timer = setTimeout(() => failCapture(request), CAPTURE_PAINT_MS)
      }
      return
    }
    if (!canCapture.current()) return failCapture(request, 'capture-failed')
    settleCapture(request)
    capturingScope.current = scope
    const askedAt = Date.now()
    let released = false
    const releaseCapture = () => {
      if (released) return
      released = true
      if (capturingScope.current === scope) capturingScope.current = null
      resumeUpdates.current()
    }
    void captureFrame(frame.contentWindow, request.cid, request.full)
      .then((reply) => {
        // Bytes are fixed now; a slow upload must not hold later preview updates.
        releaseCapture()
        if (currentScope.current !== scope) return reportCaptureFailure(request, 'capture-failed')
        return sendCapture(request, reply, { path: 'preview', askedAt })
      })
      .finally(() => {
        releaseCapture()
        captureDone.current?.(request.cid, true)
      })
  }, [capture?.cid, current, slots, front, source.sessionId, source.revision, viewing, accessAllowed]) // eslint-disable-line react-hooks/exhaustive-deps
  const published = front != null
  const [heldDraft, setHeldDraft] = useState<{ scope: string; html: string } | null>(null)
  const liveDraft = accessAllowed && draft && renderable(draft) ? draft : null
  useEffect(() => {
    if (!accessAllowed || published) setHeldDraft(null)
    else if (liveDraft) setHeldDraft({ scope, html: liveDraft })
    else if (!draft && source.revision === 0) setHeldDraft(null)
  }, [liveDraft, draft, published, scope, source.revision, accessAllowed])
  // Once published, never cover the live program with a scriptless draft photo.
  const draftLayer = published ? null : liveDraft ?? (heldDraft?.scope === scope ? heldDraft.html : null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !window.matchMedia('(max-width: 1023px)').matches) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <section
      id="preview-pane"
      aria-label="preview"
      className="order-1 flex min-h-0 min-w-0 flex-1 flex-col bg-background overscroll-contain lg:order-none lg:border-l lg:border-border"
    >
      {current && display.error && (
        <div role="status" aria-live="polite" className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 text-sm">
          <p>{display.error}</p>
          <button type="button" onClick={() => retry.current()} className="shrink-0 rounded px-3 py-2 underline focus-visible:outline-2 focus-visible:outline-offset-2">
            Retry preview
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {/* These two slots never move or change keys. A hot update never changes src. */}
        {slots.map((slot, index) => slot && (
          <iframe
            key={index}
            ref={(element) => { frames.current[index] = element }}
            src={slot.mountUrl}
            referrerPolicy="no-referrer"
            onLoad={() => frames.current[index]?.contentWindow?.postMessage({ type: 'fx0-preview-status', protocol: PREVIEW_PROTOCOL }, window.location.origin)}
            title={index === front ? 'Design artifact preview' : 'Loading design artifact preview'}
            aria-hidden={index !== front || undefined}
            tabIndex={index === front ? undefined : -1}
            className={`absolute inset-0 h-full w-full bg-background ${frameLayer(index === front, front != null)}`}
          />
        ))}
        {draftLayer ? (
          <div className="absolute inset-0 z-20 flex">
            <DraftPreview html={draftLayer} />
          </div>
        ) : !published && !slots[0] && !slots[1] && intro ? (
          // A chat loading from its URL (html.chat-url) is not empty, so it stays blank too.
          <div className="h-full min-h-0 overflow-y-auto [html.chat-url_&]:hidden">
            <div className="flex min-h-full items-center justify-center px-6 py-10">
              <div className="w-full max-w-sm">
                <HowItWorksPanel />
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <DesignLinkDialog url={linkRequest?.scope === scope ? linkRequest.url : null} onClose={closeLinkRequest} />
    </section>
  )
}

// The partial document renders with no scripts and a CSP that blocks every external
// load. It is a picture of the design in progress; the published version, with its
// scripts, replaces it. Same origin keeps it in this process: an opaque-origin frame
// paints in another process after its load event, so the swap showed white.

// A cut that ends before any body content renders as a blank white page, so the
// draft only takes over the screen once the body has started.
function renderable(html: string): boolean {
  const body = /<body[^>]*>/i.exec(html)
  return body != null && /<[a-z]/i.test(html.slice(body.index + body[0].length))
}

// The front frame is on top. A loading frame sits underneath it, still painted; with
// nothing in front yet it is transparent, so the layer below shows instead of white.
function frameLayer(isFront: boolean, hasFront: boolean): string {
  return isFront ? 'z-10' : hasFront ? 'pointer-events-none z-0' : 'pointer-events-none z-0 opacity-0'
}

// The provisional picture keeps one scriptless document. Published interactive
// artifacts still use the isolated, double-buffered slots above.
function DraftPreview({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const ready = useRef(false)
  const [painted, setPainted] = useState(false)
  const latest = useRef(html)
  latest.current = html
  const lastPush = useRef(0)
  const pushed = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const schedule = useCallback(() => {
    if (!ready.current || timer.current || latest.current === pushed.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      const doc = frame.current?.contentDocument
      if (!doc || !ready.current) return
      patchDraftDocument(doc, latest.current)
      pushed.current = latest.current
      lastPush.current = Date.now()
      setPainted(true)
    }, Math.max(0, 150 - (Date.now() - lastPush.current)))
  }, [])
  useEffect(() => {
    schedule()
    return () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [html, schedule])

  return (
    <div className="relative min-h-0 flex-1">
      <iframe
        ref={frame}
        srcDoc={EMPTY_DRAFT_DOCUMENT}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        title="Design preview while generating"
        onLoad={() => {
          ready.current = true
          schedule()
        }}
        className={`absolute inset-0 h-full w-full bg-background ${painted ? '' : 'opacity-0'}`}
      />
    </div>
  )
}
