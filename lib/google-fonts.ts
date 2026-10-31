// @ts-expect-error Node strip-types tests require the source extension.
import { googleFontStylesheets, inlineGoogleFonts } from './design-artifact.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { MAX_EMBEDDED_FONT_CSS_LENGTH } from './preview-update.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { fetchGoogleFontFile, fetchGoogleFontsStylesheet } from './public-fetch.ts'

// A design never touches the network while it runs (lib/remote-image.ts): a script that
// chose font URLs could leak what the viewer types. So, like remote images, the Google
// Fonts stylesheets the stored markup names are fetched by fx0, and their woff2 files are
// embedded as data: URLs before the design runs. The CSP stays font-src data:.

// The raw font bytes one stylesheet may embed. Latin faces are 15-50 KB each.
export const MAX_EMBEDDED_FONT_BYTES = 512 * 1024

const FACE = /(?:\/\*\s*([^*]*?)\s*\*\/\s*)?@font-face\s*\{([^{}]*)\}/g
const FONT_FILE = /url\((https:\/\/fonts\.gstatic\.com\/[A-Za-z0-9/._-]+\.woff2)\)\s*format\(['"]woff2['"]\)/
const DESCRIPTORS = ['font-family', 'font-style', 'font-stretch', 'font-display', 'unicode-range'] as const
// Values are copied only when they cannot leave their declaration.
const SAFE_VALUE = /^[A-Za-z0-9 '",.+%?-]+$/

interface Face {
  subset: string
  url: string
  descriptors: Map<string, string>
  weights: number[]
}

function parseFace(subset: string | undefined, body: string): Face | null {
  const url = FONT_FILE.exec(body)?.[1]
  if (!url) return null
  const descriptors = new Map<string, string>()
  let weights: number[] = []
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':')
    const name = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).trim()
    if (colon < 0 || !SAFE_VALUE.test(value)) continue
    if (name === 'font-weight') weights = value.split(/\s+/).map(Number).filter((weight) => Number.isInteger(weight) && weight >= 1 && weight <= 1000)
    else if ((DESCRIPTORS as readonly string[]).includes(name)) descriptors.set(name, value)
  }
  return descriptors.has('font-family') ? { subset: subset?.trim().toLowerCase() ?? '', url, descriptors, weights } : null
}

/**
 * Google's stylesheet as @font-face rules fx0 wrote itself, each file a data: URL. Only
 * the Latin faces are kept when Google labels one, and a variable font Google lists once
 * per weight becomes one face with a weight range, so each file is embedded once.
 */
export async function compileGoogleFontCss(css: string, loadFont: (url: string) => Promise<Buffer>): Promise<string> {
  const parsed = [...css.matchAll(FACE)].map(([, subset, body]) => parseFace(subset, body)).filter((face) => face != null)
  const latin = parsed.some((face) => face.subset === 'latin')
  const faces = new Map<string, Face>()
  for (const face of latin ? parsed.filter((face) => face.subset === 'latin') : parsed) {
    const key = JSON.stringify([face.url, ...face.descriptors])
    const known = faces.get(key)
    if (known) known.weights.push(...face.weights)
    else faces.set(key, face)
  }
  const urls = [...new Set([...faces.values()].map((face) => face.url))]
  const files = new Map(await Promise.all(urls.map(async (url) => [url, await loadFont(url).catch(() => null)] as const)))
  let bytes = 0
  const embedded = new Map<string, string | null>()
  const data = (url: string) => {
    if (!embedded.has(url)) {
      const file = files.get(url)
      if (file != null && bytes + file.length <= MAX_EMBEDDED_FONT_BYTES) {
        bytes += file.length
        embedded.set(url, `data:font/woff2;base64,${file.toString('base64')}`)
      } else {
        embedded.set(url, null)
      }
    }
    return embedded.get(url)
  }
  let out = ''
  for (const face of faces.values()) {
    const src = data(face.url)
    if (!src) continue
    const declarations = [...face.descriptors].map(([name, value]) => `${name}:${value}`)
    if (face.weights.length) {
      const low = Math.min(...face.weights), high = Math.max(...face.weights)
      declarations.push(`font-weight:${low === high ? low : `${low} ${high}`}`)
    }
    declarations.push(`src:url(${src}) format('woff2')`)
    out += `@font-face{${declarations.join(';')}}`
  }
  return out
}

/** One stylesheet's embedded faces. Throws when Google cannot be reached. */
export async function loadGoogleFontCss(url: string): Promise<string> {
  const css = await fetchGoogleFontsStylesheet(url, AbortSignal.timeout(5_000))
  return compileGoogleFontCss(css, (file) => fetchGoogleFontFile(file, AbortSignal.timeout(5_000)))
}

/**
 * A prepared design with its Google Fonts embedded. A stylesheet that fails, or would
 * take the faces past MAX_EMBEDDED_FONT_CSS_LENGTH, is left out: the design falls back
 * to the next font in its stack.
 */
export async function embedGoogleFonts(html: string, load: (url: string) => Promise<string> = loadGoogleFontCss): Promise<string> {
  const urls = googleFontStylesheets(html)
  if (!urls.length) return html
  let css = ''
  for (const result of await Promise.allSettled(urls.map((url) => load(url)))) {
    if (result.status === 'fulfilled' && css.length + result.value.length <= MAX_EMBEDDED_FONT_CSS_LENGTH) css += result.value
  }
  return inlineGoogleFonts(html, css)
}
