import assert from 'node:assert/strict'
import test from 'node:test'
import { googleFontStylesheets, inlineGoogleFonts, MAX_FONT_STYLESHEETS, rewriteRemoteImages, validateDesignArtifactHtml } from '../lib/design-artifact.ts'
import { compileGoogleFontCss, embedGoogleFonts, MAX_EMBEDDED_FONT_BYTES } from '../lib/google-fonts.ts'
import { markRemoteImages } from '../lib/remote-image.ts'
import { fetchGoogleFontFile, fetchGoogleFontsStylesheet } from '../lib/public-fetch.ts'

const doc = (body, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const INTER = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap'
const MONO = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono&display=swap'
const FILE = 'https://fonts.gstatic.com/s/inter/v20/latin.woff2'
const WOFF2 = Buffer.from('wOF2fakefontbytes')
const tags = (html) => html.match(/<[a-z][^>]*>/gi).map((tag) => tag.match(/^<([a-z]+)/i)[1].toLowerCase())

// What Google serves a browser for INTER: a variable font listed once per weight and subset.
const GOOGLE_CSS = ['cyrillic', 'latin'].flatMap((subset) => [400, 700].map((weight) => `/* ${subset} */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v20/${subset}.woff2) format('woff2');
  unicode-range: ${subset === 'latin' ? 'U+0000-00FF, U+0131, U+2000-206F' : 'U+0400-045F'};
}`)).join('\n')

test('a design may link Google Fonts stylesheets and preconnect to their hosts, and nothing else', () => {
  const head = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    `<link href="${INTER.replace('&', '&amp;')}" rel="stylesheet">`
  assert.equal(validateDesignArtifactHtml(doc('<p>x</p>', head)).ok, true)
  for (const link of [
    '<link rel="stylesheet" href="https://example.com/fonts.css">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/icon">',
    '<link rel="preconnect" href="https://example.com">',
    `<link rel="icon" href="${INTER}">`,
    `<link rel="stylesheet" href=${INTER}>`,
  ]) assert.equal(validateDesignArtifactHtml(doc('<p>x</p>', link)).ok, false, link)
  assert.equal(validateDesignArtifactHtml(doc('<p>x</p>', `<link rel="stylesheet" href="${INTER}">`), { remoteImages: false }).ok, false)
})

test('the stylesheets a design names are found once each, from links and @import, and are never images', () => {
  const html = doc('<p>x</p>', `<link rel="stylesheet" href="${INTER}"><style>@import url("${MONO}"); @import '${INTER}'; @import url(https://example.com/a.css); body{background:url(https://example.com/bg.png)}</style>`)
  assert.deepEqual(googleFontStylesheets(html), [INTER, MONO])
  const images = []
  rewriteRemoteImages(html, (url) => { images.push(url); return null })
  assert.deepEqual(images, ['https://example.com/a.css', 'https://example.com/bg.png'])
  assert.deepEqual(markRemoteImages(doc('', `<style>@import url(${INTER});</style>`), '0'.repeat(32)).images, [])
  const many = doc('', `<style>${Array.from({ length: 6 }, (_, index) => `@import url(${INTER}${index});`).join('')}</style>`)
  assert.equal(googleFontStylesheets(many).length, MAX_FONT_STYLESHEETS)
})

test('embedding takes every reference out without moving an element, and puts the faces first in the first style', () => {
  const html = doc('<p>x</p>', `<link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="${INTER}"><style>@import url("${MONO}");body{color:red}</style><style>p{}</style>`)
  const out = inlineGoogleFonts(html, '@font-face{font-family:A}')
  assert.deepEqual(tags(out), tags(html))
  assert.ok(!out.includes('fonts.g'), out)
  assert.match(out, /<link rel="preconnect" href=""><link rel="stylesheet" href=""><style>@font-face\{font-family:A\}body\{color:red\}<\/style><style>p\{\}<\/style>/)
  // Without a style element the faces get their own, at the top of <head>.
  assert.equal(inlineGoogleFonts(doc('', `<title>t</title><link rel="stylesheet" href="${INTER}">`), '@font-face{}'),
    doc('', '<style>@font-face{}</style><title>t</title><link rel="stylesheet" href="">'))
  // Faces that could close the element are never written.
  assert.ok(!inlineGoogleFonts(html, '</style><script>x</script>').includes('<script>'))
  // A failed stylesheet still loses its reference; a design without one is untouched.
  assert.ok(!inlineGoogleFonts(html, '').includes('fonts.g'))
  const plain = doc('<p>x</p>', '<style>p{}</style>')
  assert.equal(inlineGoogleFonts(plain, '@font-face{}'), plain)
})

test("Google's stylesheet becomes Latin faces fx0 wrote, each file embedded once", async () => {
  const loaded = []
  const css = await compileGoogleFontCss(GOOGLE_CSS, async (url) => { loaded.push(url); return WOFF2 })
  assert.deepEqual(loaded, [FILE])
  assert.equal(css, `@font-face{font-family:'Inter';font-style:normal;font-display:swap;unicode-range:U+0000-00FF, U+0131, U+2000-206F;font-weight:400 700;src:url(data:font/woff2;base64,${WOFF2.toString('base64')}) format('woff2')}`)
  // Without subset labels (a &text= request) every face is kept.
  const unlabeled = await compileGoogleFontCss(GOOGLE_CSS.replace(/\/\*.*?\*\//g, ''), async () => WOFF2)
  assert.equal(unlabeled.match(/@font-face/g).length, 2)
})

test('only gstatic woff2 files and safe descriptor values are copied, within the byte budget', async () => {
  const face = (body) => `/* latin */ @font-face { font-family: 'A'; ${body} }`
  const load = async () => WOFF2
  assert.equal(await compileGoogleFontCss(face("src: url(https://example.com/a.woff2) format('woff2');"), load), '')
  assert.equal(await compileGoogleFontCss(face(`src: url(${FILE}) format('truetype');`), load), '')
  const injected = await compileGoogleFontCss(`/* latin */ @font-face { font-family: 'A'; font-style: normal</style>; src: url(${FILE}) format('woff2'); }`, load)
  assert.ok(!injected.includes('<') && !injected.includes('font-style'), injected)
  assert.equal(await compileGoogleFontCss(face(`src: url(${FILE}) format('woff2');`), async () => { throw new Error('down') }), '')
  assert.equal(await compileGoogleFontCss(face(`src: url(${FILE}) format('woff2');`), async () => Buffer.alloc(MAX_EMBEDDED_FONT_BYTES + 1)), '')
})

test('a stylesheet that fails is left out and the rest still embed', async () => {
  const html = doc('<p>x</p>', `<link rel="stylesheet" href="${INTER}"><link rel="stylesheet" href="${MONO}"><style>p{}</style>`)
  const out = await embedGoogleFonts(html, async (url) => { if (url === MONO) throw new Error('down'); return '@font-face{font-family:Inter}' })
  assert.match(out, /<style>@font-face\{font-family:Inter\}p\{\}<\/style>/)
  assert.ok(!out.includes('fonts.g'))
})

test('font requests never leave Google font hosts', async () => {
  const signal = AbortSignal.timeout(1000)
  await assert.rejects(fetchGoogleFontsStylesheet('https://example.com/css2?family=A', signal), /Not a Google Fonts URL/)
  await assert.rejects(fetchGoogleFontFile('https://fonts.googleapis.com/a.woff2', signal), /Not a Google Fonts URL/)
})
