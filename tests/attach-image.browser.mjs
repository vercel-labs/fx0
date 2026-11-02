import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

// Opt-in: runs real Chrome headless on this machine. Set CHROME_PATH for another browser binary.
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// The composer's attachment code, types stripped and imports inlined, run on images the
// page draws: what reaches the prompt must be at most 2048 px, usually WebP, and small.
async function attachCode() {
  const read = async (name) => stripTypeScriptTypes(await readFile(new URL(`../components/${name}`, import.meta.url), 'utf8'))
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')
  return `${await read('image-thumbnail.ts')}\n${await read('attach-image.ts')}`
}

const PAGE = (code) => `<!doctype html><html><head><title>attach</title></head><body><pre id="out">{}</pre><script>${code}
const canvasFile = async (width, height, { type = 'image/png', transparent = false, quality, name = 'image' } = {}) => {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d')
  if (!transparent) { const gradient = context.createLinearGradient(0, 0, width, height); gradient.addColorStop(0, '#2a6'); gradient.addColorStop(1, '#a26'); context.fillStyle = gradient; context.fillRect(0, 0, width, height) }
  for (let i = 0; i < 400; i++) { context.fillStyle = 'hsl(' + (i * 37 % 360) + ' 70% 50%)'; context.beginPath(); context.arc((i * 97) % width, (i * 53) % height, 20 + i % 60, 0, 7); context.fill() }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality))
  return new File([blob], name, { type })
}
const describe = async (result) => {
  const image = new Image(); image.src = result.preview; await image.decode()
  return { type: result.mimeType, width: image.naturalWidth, height: image.naturalHeight, bytes: atob(result.data).length, thumbnail: !!result.thumbnail && result.thumbnail.startsWith('data:image/jpeg'), source: result.source }
}
;(async () => {
  const out = {}
  const run = async (name, make, options) => {
    try { out[name] = await describe(await normalizeImage(await make(), options)) } catch (error) { out[name] = { error: error.message } }
  }
  await run('photo', () => canvasFile(4000, 3000))
  await run('retina', () => canvasFile(2880, 1800, { name: 'CleanShot 2026-10-31 at 4.31.10 PM@2x.png' }))
  await run('transparentNoWebp', () => canvasFile(3000, 2000, { transparent: true }), { webp: false })
  await run('opaqueNoWebp', () => canvasFile(3000, 2000), { webp: false })
  const small = await canvasFile(800, 600, { type: 'image/jpeg', quality: 0.8 })
  const keptSmall = await normalizeImage(small)
  out.smallJpeg = { ...(await describe(keptSmall)), unchanged: atob(keptSmall.data).length === small.size }
  await run('gif', async () => new File([Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0))], 'a.gif', { type: 'image/gif' }))
  await run('notAnImage', async () => new File(['<svg onload=alert(1)>'], 'x.heic', { type: 'image/heic' }))
  document.getElementById('out').textContent = JSON.stringify(out)
  await fetch('/done')
})()
</script><img alt="" src="/hold"></body></html>`

test('in Chrome, attached images are resized, re-encoded and kept small, and unreadable files are refused', async () => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const dir = await mkdtemp(join(tmpdir(), 'fx0-attach-'))
  const page = PAGE(await attachCode())
  // The page's load waits on /hold, which answers once the script reports /done, so
  // Chrome dumps the page only after the asynchronous encoding has finished.
  let release
  const done = new Promise((resolve) => { release = resolve })
  const server = http.createServer((request, response) => {
    if (request.url === '/done') { release(); return response.end() }
    if (request.url === '/hold') return void Promise.race([done, new Promise((resolve) => setTimeout(resolve, 30_000))]).then(() => response.writeHead(404).end())
    response.writeHead(200, { 'content-type': 'text/html' }).end(page)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { stdout } = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `http://127.0.0.1:${server.address().port}/`,
    ], { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 })
    const out = JSON.parse(stdout.match(/<pre id="out">([^<]*)<\/pre>/)[1])
    assert.equal(out.photo.type, 'image/webp')
    assert.deepEqual([out.photo.width, out.photo.height], [2048, 1536])
    assert.ok(out.photo.bytes <= 700 * 1024, `photo is ${out.photo.bytes} bytes`)
    assert.equal(out.photo.thumbnail, true)
    assert.deepEqual(out.photo.source, { width: 4000, height: 3000 }, 'the original size survives the downscale')
    assert.deepEqual([out.retina.width, out.retina.height], [2048, 1280])
    assert.deepEqual(out.retina.source, { width: 2880, height: 1800, density: 2 }, 'a @2x name gives the density')
    assert.deepEqual(out.smallJpeg.source, { width: 800, height: 600 })
    assert.equal(out.transparentNoWebp.type, 'image/png', 'without WebP, transparency keeps PNG')
    assert.ok(Math.max(out.transparentNoWebp.width, out.transparentNoWebp.height) <= 2048)
    assert.equal(out.opaqueNoWebp.type, 'image/jpeg', 'without WebP, an opaque image becomes JPEG')
    assert.ok(out.opaqueNoWebp.bytes <= 700 * 1024)
    assert.deepEqual({ type: out.smallJpeg.type, width: out.smallJpeg.width, unchanged: out.smallJpeg.unchanged }, { type: 'image/jpeg', width: 800, unchanged: true })
    assert.equal(out.gif.type, 'image/gif', 'a small GIF is sent as is, animation intact')
    assert.match(out.notAnImage.error, /not supported here/)
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
