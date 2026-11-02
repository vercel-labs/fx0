import assert from 'node:assert/strict'
import test from 'node:test'
import https from 'node:https'
import dns from 'node:dns/promises'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { googleFontStylesheets, inlineGoogleFonts, MAX_FONT_STYLESHEETS, rewriteRemoteImages, validateDesignArtifactHtml } from '../lib/design-artifact.ts'
import { compileGoogleFontCss, embedGoogleFonts, loadGoogleFontCss, MAX_EMBEDDED_FONT_BYTES, MAX_FONT_FILES } from '../lib/google-fonts.ts'
import { MAX_EMBEDDED_FONT_CSS_LENGTH } from '../lib/preview-update.ts'
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

test('font faces never inherit a conditional, disabled, alternate or non-CSS style', () => {
  const faces = '@font-face{font-family:Test}'
  for (const attrs of ['media="print"', 'media="(min-width:99999px)"', 'type="text/plain"', 'disabled', 'title="alternate"']) {
    const restricted = `<style ${attrs}>p{color:red}</style>`
    const normal = '<style>body{color:black}</style>'
    const html = doc('<p>x</p>', `<link rel="stylesheet" href="${INTER}">${restricted}${normal}`)
    const out = inlineGoogleFonts(html, faces)
    assert.ok(out.includes(restricted), attrs)
    assert.ok(out.includes(`<style>${faces}body{color:black}</style>`), attrs)
    assert.deepEqual(tags(out), tags(html), 'reuse an eligible style without changing DOM shape')

    const only = inlineGoogleFonts(doc('<p>x</p>', `<link rel="stylesheet" href="${INTER}">${restricted}`), faces)
    assert.ok(only.includes(`<head><style>${faces}</style>`), 'no eligible style: add an unconditional one')
    assert.ok(only.includes(restricted), attrs)
  }
  const all = inlineGoogleFonts(doc('', `<link rel="stylesheet" href="${INTER}"><style media="all" type="text/css">p{}</style>`), faces)
  assert.ok(all.includes(`<style media="all" type="text/css">${faces}p{}</style>`))
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

// All transport tests are local mocks: no network connection or DNS query is made.
function transport(t, replies) {
  const requests = []
  const lookups = t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }])
  t.mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter()
    request.end = () => queueMicrotask(() => {
      const { body = '', ...reply } = replies.shift()
      callback(Object.assign(Readable.from([Buffer.from(body)]), { statusCode: 200, headers: {}, ...reply }))
    })
    requests.push({ url: url.href, options })
    return request
  })
  return { requests, lookups }
}

test('font requests reject other origins before DNS, including alternate ports and HTTP', async (t) => {
  const { requests, lookups } = transport(t, [])
  const signal = AbortSignal.timeout(1000)
  for (const url of ['https://example.com/css2?family=A', 'http://fonts.googleapis.com/css2?family=A', 'https://fonts.googleapis.com:444/css2?family=A']) {
    await assert.rejects(fetchGoogleFontsStylesheet(url, signal), /Not a Google Fonts URL/)
  }
  await assert.rejects(fetchGoogleFontFile('https://fonts.googleapis.com/a.woff2', signal), /Not a Google Fonts URL/)
  assert.equal(requests.length, 0)
  assert.equal(lookups.mock.callCount(), 0)
})

test('a font redirect is restricted before the next DNS lookup or connection', async (t) => {
  for (const destination of ['https://example.com/font', 'https://fonts.gstatic.com/font', 'http://fonts.googleapis.com/css2?family=A', 'https://fonts.googleapis.com:444/font']) {
    const { requests, lookups } = transport(t, [{ statusCode: 302, headers: { location: destination } }])
    await assert.rejects(fetchGoogleFontsStylesheet(INTER, AbortSignal.timeout(1000)), /Disallowed fetch origin/)
    assert.equal(requests.length, 1)
    assert.equal(lookups.mock.callCount(), 1)
    t.mock.restoreAll()
  }
})

test('same-origin font redirects work and retain DNS pinning and a browser user agent', async (t) => {
  const { requests } = transport(t, [{ statusCode: 302, headers: { location: '/css2?family=Inter' } }, { body: GOOGLE_CSS }])
  assert.equal(await fetchGoogleFontsStylesheet(INTER, AbortSignal.timeout(1000)), GOOGLE_CSS)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].url, 'https://fonts.googleapis.com/css2?family=Inter')
  assert.match(requests[1].options.headers['user-agent'], /Chrome/)
  assert.equal(requests[1].options.agent, false)
  requests[1].options.lookup('fonts.googleapis.com', { all: true }, (error, addresses) => {
    assert.equal(error, null)
    assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }])
  })
})

test('unusable font responses throw instead of producing an empty cached stylesheet', async (t) => {
  transport(t, [{ body: '<html>no CSS</html>' }])
  await assert.rejects(loadGoogleFontCss(INTER), /No usable Latin WOFF2 font faces/)
  t.mock.restoreAll()
  transport(t, [{ body: 'not a font' }])
  await assert.rejects(fetchGoogleFontFile(FILE, AbortSignal.timeout(1000)), /Not a woff2 font/)
  t.mock.restoreAll()
  const italic = GOOGLE_CSS.replaceAll('/latin.woff2', '/italic.woff2').replaceAll('font-style: normal', 'font-style: italic')
  transport(t, [{ body: GOOGLE_CSS + italic }, { body: WOFF2 }, { statusCode: 502 }])
  await assert.rejects(loadGoogleFontCss(INTER), /Google Fonts download incomplete/, 'partial network failures must not be cached either')
})

test('font downloads have a file cap, bounded concurrency and one deadline for CSS and files', async (t) => {
  const css = Array.from({ length: MAX_FONT_FILES + 8 }, (_, i) => `/* latin */ @font-face {font-family:'F${i}';src:url(https://fonts.gstatic.com/s/f${i}.woff2) format('woff2');}`).join('')
  let active = 0, peak = 0, calls = 0
  await compileGoogleFontCss(css, async () => {
    calls++; active++; peak = Math.max(peak, active)
    await new Promise(setImmediate)
    active--
    return WOFF2
  })
  assert.equal(calls, MAX_FONT_FILES)
  assert.ok(peak <= 4)

  const { requests } = transport(t, [{ body: GOOGLE_CSS }, { body: WOFF2 }])
  await loadGoogleFontCss(INTER)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].options.signal, requests[1].options.signal)
})

test('font budgets stop further batches and bound serialized CSS even when a file has aliases', async () => {
  const faces = Array.from({ length: MAX_FONT_FILES }, (_, i) => `/* latin */ @font-face {font-family:'F${i}';src:url(https://fonts.gstatic.com/s/f${i}.woff2) format('woff2');}`)
  let calls = 0
  const css = await compileGoogleFontCss(faces.join(''), async () => { calls++; return Buffer.alloc(MAX_EMBEDDED_FONT_BYTES / 4) })
  assert.equal(calls, 4, 'no more batches start once the byte budget is full')
  assert.ok(css.length <= MAX_EMBEDDED_FONT_CSS_LENGTH)
  const aliases = faces.map(face => face.replace(/f\d+\.woff2/, 'same.woff2')).join('')
  const aliased = await compileGoogleFontCss(aliases, async () => Buffer.alloc(200_000))
  assert.ok(aliased.length <= MAX_EMBEDDED_FONT_CSS_LENGTH, 'reusing bytes in another rule still consumes CSS budget')
})
