import { ARTIFACT_IMAGE_PATH, artifactImageSrc } from '../../../lib/artifact-image'
import { DESIGN_ARTIFACT_EMBEDDED_CSP, designFrameCsp, designFrameHtml, normalizeDesignArtifactHtml, prepareDesignArtifactHtml, remoteImagesEnabled } from '../../../lib/design-artifact'
import { DESIGN_CAPTURE_RELAY, designCaptureScript } from '../../../lib/design-capture'
import { embedGoogleFonts } from '../../../lib/google-fonts'
import { PREVIEW_PROTOCOL, type PreviewPayload } from '../../../lib/preview-update'
import { cachedGoogleFontCss } from '../../../lib/remote-image-cache'
import { markRemoteImages } from '../../../lib/remote-image'
import { readDesignArtifactAt } from '../../../lib/journal'
import { readGeneration } from '../../../lib/history'
import { withSessionRoute } from '../../../lib/route-auth'
import { log } from '../../../lib/session'

export const maxDuration = 30

const serveFrame = withSessionRoute(async (request, { id: sessionId, user }) => {
  // Without a revision this is the live design in Redis; with one, a past version from Neon.
  const params = new URL(request.url).searchParams
  const format = params.get('format')
  if (format != null && format !== 'json') return Response.json({ error: 'Unknown preview format.' }, { status: 400 })
  const json = format === 'json'
  const revision = Number(params.get('revision'))
  const past = Number.isSafeInteger(revision) && revision > 0
  const live = past ? null : await readDesignArtifactAt(sessionId)
  const stored = past ? await readGeneration(user.id, sessionId, revision) : live!.html
  const artifact = stored == null ? null : normalizeDesignArtifactHtml(stored)
  const actualRevision = past ? revision : live!.revision
  // ?v= names the revision the page expects. When it is the one live, the browser may
  // keep this response but must revalidate it: this route checks the session first,
  // so a reload costs a 304 and a signed-out browser gets nothing from its cache.
  const version = Number(params.get('v'))
  // A frame that asks for a newer revision than the live one is a raced or stale load. It
  // fails here, before any design is prepared, so the parent retries instead of booting
  // the old design (components/preview-pane.tsx). Current or newer revisions are served.
  if (!json && !past && request.headers.get('sec-fetch-dest') === 'iframe' && Number.isSafeInteger(version) && version > 0 && actualRevision < version) {
    return Response.json({ error: 'The requested design version is not available yet. Try again.' }, {
      status: 404, headers: { 'cache-control': 'private, no-store' },
    })
  }
  const cacheable = live?.html != null && Number.isSafeInteger(version) && version > 0 && version === live.revision
  const etag = cacheable ? `"${sessionId}:${live.revision}"` : null
  if (!json && etag && request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { 'cache-control': 'private, no-cache', etag } })
  }
  const readyToken = crypto.randomUUID()
  // Remote images become markers here; the wrapper loads each from /api/artifact-image
  // and embeds it before the design runs, so the design has no network and the
  // browser keeps the images across revisions (lib/remote-image.ts).
  const marked = artifact != null
    ? markRemoteImages(artifact, crypto.randomUUID().replaceAll('-', ''), { remote: remoteImagesEnabled() })
    : { html: artifact, images: [] }
  // Google Fonts are embedded here, from the shared cache (lib/google-fonts.ts).
  if (marked.html != null && remoteImagesEnabled()) {
    marked.html = await embedGoogleFonts(marked.html, (url) => cachedGoogleFontCss(url).catch((error: Error) => {
      log(sessionId, 'artifact-font:failed', { reason: error.message.slice(0, 80) })
      throw error
    }))
  }
  const images = marked.images.map(({ marker, url }) => ({ marker, src: artifactImageSrc(sessionId, url) }))
  const prepared = marked.html == null ? null : prepareDesignArtifactHtml(marked.html, DESIGN_ARTIFACT_EMBEDDED_CSP, readyToken)
  // Every stored design passed validation, so this only guards against one that
  // somehow lacks a doctype: it is never shown without its CSP.
  if (artifact != null && prepared == null) log(sessionId, 'artifact:unrenderable', { revision: past ? revision : live!.revision })
  const payload: PreviewPayload | null = artifact != null && prepared != null ? {
    protocol: PREVIEW_PROTOCOL, sessionId, revision: actualRevision,
    sourceHtml: artifact, renderHtml: marked.html!, images,
  } : null
  if (json) {
    return Response.json(payload ?? { error: artifact == null ? 'No design artifact.' : 'The design could not be prepared.' }, {
      status: payload ? 200 : artifact == null ? 404 : 422,
      headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
    })
  }
  const preparedArtifact = prepared ??
    `<!doctype html><html><head><meta charset="utf-8"><title>No design artifact</title></head><body><p>${
      artifact != null ? 'This design could not be prepared for preview.'
        : past ? 'This version is not in the history.' : 'No design artifact has been published for this session.'
    }</p></body></html>`
  // Every preview is photographed where it is (lib/design-capture.ts): the wrapper gives each child document its own capture runtime.
  const html = designFrameHtml(preparedArtifact, readyToken, images, payload ?? undefined, { relay: DESIGN_CAPTURE_RELAY, script: designCaptureScript })
  return new Response(html, {
    status: artifact == null ? 404 : prepared == null ? 422 : 200,
    headers: {
      'cache-control': etag ? 'private, no-cache' : 'private, no-store',
      ...(etag ? { etag } : {}),
      'content-security-policy': designFrameCsp(`${new URL(request.url).origin}${ARTIFACT_IMAGE_PATH}`),
      'content-type': 'text/html; charset=utf-8',
      'permissions-policy':
        'accelerometer=(), camera=(), clipboard-read=(), clipboard-write=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
})

export async function GET(request: Request): Promise<Response> {
  return reportFrameError(request, await serveFrame(request))
}

// A frame cannot read a JSON error, so a failed document reports its status to the
// preview that loaded it (components/preview-pane.tsx). Programmatic callers keep JSON.
function reportFrameError(request: Request, response: Response): Response {
  if (response.status < 400 || request.headers.get('sec-fetch-dest') !== 'iframe'
    || new URL(request.url).searchParams.get('format') === 'json') return response
  // The status is the only value in the script; the body never carries session or user data.
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('cache-control', 'private, no-store')
  headers.set('content-type', 'text/html; charset=utf-8')
  headers.set('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'self'`)
  headers.set('referrer-policy', 'no-referrer')
  headers.set('x-content-type-options', 'nosniff')
  // The parent asks for the status on mount. A frame can finish loading before that listener exists, so it also posts once on its own.
  const script = `const report=()=>parent.postMessage({type:'fx0-preview-error',protocol:${PREVIEW_PROTOCOL},status:${response.status}},location.origin);`
    + `addEventListener('message',event=>{if(event.source===parent&&event.origin===location.origin&&event.data&&event.data.type==='fx0-preview-status'&&event.data.protocol===${PREVIEW_PROTOCOL})report()});report()`
  return new Response(`<!doctype html><meta charset="utf-8"><title>Design preview unavailable</title><script nonce="${nonce}">${script}</script>`, {
    status: response.status, statusText: response.statusText, headers,
  })
}
