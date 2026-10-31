import { cacheLife } from 'next/cache.js'
import { BLANK_IMAGE, googleFontStylesheets, MAX_DESIGN_ARTIFACT_BYTES, MAX_FONT_STYLESHEETS, remoteImagesEnabled, remoteImageUrl, rewriteRemoteImages } from './design-artifact'
import type { DesignDraftObserver } from './gateway-session'
import { loadGoogleFontCss } from './google-fonts'
import { loadRemoteImage, MAX_REMOTE_IMAGES } from './remote-image'

// Shared by every instance in the region (Runtime Cache), so a design's images are
// fetched once, not on every preview. A failed fetch throws and is never cached.
export async function cachedRemoteImage(url: string): Promise<string> {
  'use cache: remote'
  cacheLife({ revalidate: 86400, expire: 7 * 86400 })
  return loadRemoteImage(url)
}

// A Google Fonts stylesheet with its files embedded (lib/google-fonts.ts), at most
// about 700 KB, so one entry holds it. Google's font URLs are versioned, so a day is safe.
export async function cachedGoogleFontCss(url: string): Promise<string> {
  'use cache: remote'
  cacheLife({ revalidate: 86400, expire: 7 * 86400 })
  return loadGoogleFontCss(url)
}

const SCAN_MS = 250

// Starts fetching a design's remote images and fonts into the cache while the model is still
// writing it, so the published preview need not wait for them. Only tags the model
// has finished are read, and only the model's markup decides what is fetched.
export function prefetchRemoteImages(observer: DesignDraftObserver | undefined, load = cachedRemoteImage, loadFonts = cachedGoogleFontCss): DesignDraftObserver | undefined {
  if (!remoteImagesEnabled()) return observer
  const drafts = new Map<string, { html: string; scannedAt: number }>()
  const started = new Set<string>()
  const fonts = new Set<string>()
  const scan = (html: string) => {
    rewriteRemoteImages(html, (url: string) => {
      if (remoteImageUrl(url) && !started.has(url) && started.size < MAX_REMOTE_IMAGES) {
        started.add(url)
        void load(url).catch(() => {})
      }
      return BLANK_IMAGE
    })
    for (const url of googleFontStylesheets(html)) {
      if (fonts.has(url) || fonts.size >= MAX_FONT_STYLESHEETS) continue
      fonts.add(url)
      void loadFonts(url).catch(() => {})
    }
  }
  return {
    delta(callId, chunk) {
      observer?.delta(callId, chunk)
      const draft = drafts.get(callId) ?? { html: '', scannedAt: 0 }
      if (draft.html.length + chunk.length > MAX_DESIGN_ARTIFACT_BYTES) return
      draft.html += chunk
      drafts.set(callId, draft)
      if (Date.now() - draft.scannedAt < SCAN_MS) return
      draft.scannedAt = Date.now()
      // Off the stream's path: the model's tokens reach libfx before this runs.
      const html = draft.html
      setImmediate(() => scan(html))
    },
    end(callId) {
      const draft = drafts.get(callId)
      drafts.delete(callId)
      if (draft) scan(draft.html)
      return observer?.end?.(callId)
    },
    abort() {
      drafts.clear()
      return observer?.abort?.()
    },
  }
}
