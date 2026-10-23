import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { markRemoteImages } from '../lib/remote-image.ts'
import { BLANK_IMAGE, DESIGN_ARTIFACT_EMBEDDED_CSP, MAX_EMBEDDED_IMAGE_BYTES, designFrameCsp, designFrameHtml, prepareDesignArtifactHtml, validateDesignArtifactHtml } from '../lib/design-artifact.ts'

// Opt-in, like design-artifact.browser.mjs. Node 24 supplies WebSocket and TS stripping.
// One Chrome and sequential cases keep this suite from spawning a browser per assertion.
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const SESSION = 'preview-browser-session'
const TOKEN = 'preview-browser-ready'

function design({ color = 'rgb(10, 20, 30)', title = 'Original title', padding = 4, image = '', photo = false, program = 'original', structure = '', beforeLoad = '', sheetId = true } = {}) {
  return `<!doctype html><html><head><title>Interactive presentation</title>
<style${sheetId ? ' id="theme"' : ''}>body{margin:0;min-height:2600px}#title{color:${color}}#swatch{width:80px;height:80px;background-image:${image ? `url(https://fixture.invalid/${image})` : 'none'}}</style>
</head><body class="slide-1"><h1 id="title">${title}</h1>
<p id="inline" style="padding:${padding}px">Inline target</p><p id="runtime-label">Authored label</p>
<input id="input" value="authored"><button id="next">Next slide</button><div id="swatch"></div>
${photo ? '<img id="photo" alt="Local fixture" src="https://fixture.invalid/pixel.png">' : ''}${structure}
<script>
const instance = crypto.randomUUID(), program = ${JSON.stringify(program)}
const find = id => id === 'theme' ? document.querySelector('style') : document.getElementById(id)
const refs = Object.fromEntries(['title', 'inline', 'input', 'next', 'theme'].map(id => [id, find(id)]))
let clicks = 0
refs.next.addEventListener('click', () => { clicks++; document.body.className = 'slide-' + (4 + clicks) })
document.body.className = 'slide-4'
refs.input.value = 'typed at runtime'
document.getElementById('runtime-label').textContent = 'Runtime label'
const generated = document.createElement('p'); generated.id = 'generated'; generated.textContent = 'Generated at runtime'; document.body.append(generated)
${beforeLoad}
const send = data => top.postMessage({ fixture: 'preview-update', instance, program, ...data }, '*')
send({ kind: 'boot' })
addEventListener('error', event => send({ kind: 'error', error: event.message }))
addEventListener('unhandledrejection', event => send({ kind: 'error', error: String(event.reason) }))
const report = () => {
  const title = document.getElementById('title'), input = document.getElementById('input'), sheet = find('theme').sheet
  send({ kind: 'state', title: title.textContent, color: getComputedStyle(title).color,
    padding: getComputedStyle(document.getElementById('inline')).paddingTop, background: getComputedStyle(document.getElementById('swatch')).backgroundImage,
    className: document.body.className, input: input.value, focused: document.activeElement === input,
    selection: [input.selectionStart, input.selectionEnd], scroll: Math.round(scrollY), clicks,
    sameNodes: Object.entries(refs).every(([id, node]) => find(id) === node),
    runtimeLabel: document.getElementById('runtime-label').textContent, generated: !!document.getElementById('generated'),
    cssText: find('theme').textContent, rules: sheet.cssRules.length, disabled: sheet.disabled,
    photo: document.getElementById('photo')?.getAttribute('src') ?? null,
    photoDecoded: !!document.getElementById('photo')?.naturalWidth, added: !!document.getElementById('added'),
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content })
}
addEventListener('load', report, { once: true })
setInterval(report, 60)
</script></body></html>`
}

function payload(revision, html, imageName) {
  const validated = validateDesignArtifactHtml(` \n${html}\n `, { remoteImages: true })
  assert.equal(validated.ok, true, validated.error)
  const marked = markRemoteImages(validated.html, randomBytes(16).toString('hex'), { remote: true })
  return {
    protocol: 1, sessionId: SESSION, revision, sourceHtml: validated.html, renderHtml: marked.html,
    images: marked.images.map(({ marker, url }) => ({ marker, src: `/api/artifact-image?name=${encodeURIComponent(imageName ?? new URL(url).pathname.slice(1))}&nonce=${randomBytes(8).toString('hex')}` })),
  }
}

// Observe real window messages without intercepting any production listener or send.
const OBSERVER = `
window.observed = { paints: [], results: [], boots: [], reports: [], errors: [] }
addEventListener('message', event => {
  const frames = [...document.querySelectorAll('#active, #preview-pane iframe')], data = event.data
  if (!data || typeof data !== 'object') return
  const wrapper = frames.find(frame => event.source === frame.contentWindow)
  if (wrapper && event.origin === location.origin) {
    const entry = { ...data, mountUrl: wrapper.getAttribute('src') }
    if (data.type === 'fx0-artifact-painted') observed.paints.push(entry)
    if (data.type === 'fx0-preview-result') observed.results.push(entry)
  }
  const frame = frames.find(frame => event.source === frame.contentWindow.frames[0])
  if (frame && data.fixture === 'preview-update') {
    const entry = { ...data, mountUrl: frame.getAttribute('src') }
    if (data.kind === 'boot') observed.boots.push(entry)
    if (data.kind === 'state') { observed.reports.push(entry); if (observed.reports.length > 30) observed.reports.shift() }
    if (data.kind === 'error') observed.errors.push(data.error)
  }
})`

const PARENT = `<!doctype html><html><head><title>Preview update browser test</title>
<style>html,body{margin:0}iframe{width:1000px;height:720px;border:0}</style></head><body><script>${OBSERVER}
window.mount = url => {
  document.getElementById('active')?.remove()
  observed.reports = []
  const frame = document.createElement('iframe'); frame.id = 'active'; frame.src = url; document.body.append(frame)
}
</script></body></html>`

async function buildPaneFixture(directory) {
  const output = await realpath(directory), root = fileURLToPath(new URL('../', import.meta.url))
  // Same narrow compile as html-ui.test.mjs, using this test's Node 24 executable.
  await promisify(execFile)(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--ignoreConfig', '--outDir', join(output, 'compiled'), '--strict', '--types', 'node',
    '--jsx', 'react-jsx', '--target', 'esnext', '--module', 'esnext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop', 'components/preview-pane.tsx',
  ], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
  await writeFile(join(output, 'package.json'), '{"type":"module"}')
  // These controls change only the real component's props. No replacement hooks,
  // updater, transport or slot coordinator is bundled into the fixture.
  await writeFile(join(output, 'pane-fixture.js'), `
import { createElement, useEffect, useState } from 'react'
import PreviewPane from './compiled/components/preview-pane.js'
export function Fixture() {
  const [revision, setRevision] = useState(101), [viewing, setViewing] = useState(null)
  const [sessionId, setSession] = useState(${JSON.stringify(SESSION)}), [draft, setDraft] = useState(null)
  const [accessAllowed, setAccessAllowed] = useState(true)
  useEffect(() => {
    Object.assign(window, { setRevision, setViewing, setSession, setDraft, setAccessAllowed, fixtureReady: true })
    const revoke = () => { setAccessAllowed(false); setRevision(0) }
    window.addEventListener('fx0:auth-required', revoke)
    return () => window.removeEventListener('fx0:auth-required', revoke)
  }, [])
  return createElement(PreviewPane, { source: { kind: 'design', sessionId, revision }, viewing, draft, accessAllowed, intro: false, onClose: () => setRevision(0) })
}`)
  await writeFile(join(output, 'pane-entry.js'), `
import { createElement } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { Fixture } from './pane-fixture.js'
hydrateRoot(document.getElementById('app'), createElement(Fixture), { onRecoverableError: error => observed.errors.push(error.message) })
`)
  const { default: bundledWebpack } = await import('../node_modules/next/dist/compiled/webpack/webpack.js')
  const compiler = bundledWebpack.webpack({
    // Next's packaged webpack references a terser entry absent in this install.
    // Production React is still selected; minification is not under test here.
    mode: 'production', optimization: { minimize: false }, target: 'web', entry: join(output, 'pane-entry.js'),
    output: { path: join(output, 'browser'), filename: 'bundle.js' },
    module: { rules: [{ test: /\.js$/, resolve: { fullySpecified: false } }] },
    resolve: { modules: [join(root, 'node_modules')], extensions: ['.js'], extensionAlias: { '.ts': ['.js'] } },
  })
  try {
    const stats = await promisify(compiler.run.bind(compiler))()
    assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }))
  } finally { await promisify(compiler.close.bind(compiler))() }

  const outputUrl = pathToFileURL(`${output}/`).href, projectUrl = new URL('../package.json', import.meta.url).href
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.startsWith(outputUrl)) return nextResolve(specifier, context)
    if (specifier.startsWith('.')) return nextResolve(/\.js$/.test(specifier) ? specifier : `${specifier.replace(/\.ts$/, '')}.js`, context)
    return nextResolve(specifier, { ...context, parentURL: projectUrl })
  } })
  let markup
  try {
    const [{ Fixture }, { createElement }, { renderToString }] = await Promise.all([
      import(pathToFileURL(join(output, 'pane-fixture.js')).href), import('react'), import('react-dom/server'),
    ])
    markup = renderToString(createElement(Fixture))
  } finally { hooks.deregister() }
  return {
    bundle: await readFile(join(output, 'browser/bundle.js')),
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Real PreviewPane</title><style>
html,body,#app{margin:0;height:100%}#preview-pane{height:100%;display:flex;flex-direction:column}
#preview-pane>div:last-of-type{position:relative;flex:1;min-height:720px}
#preview-pane iframe{position:absolute;inset:0;width:1000px;height:720px;border:0}
#preview-pane iframe[aria-hidden=true]{z-index:0;pointer-events:none}#preview-pane iframe:not([aria-hidden=true]){z-index:1}
</style></head><body><script>${OBSERVER}</script><div id="app">${markup}</div><script defer src="/bundle.js"></script></body></html>`,
  }
}

async function until(read, label, milliseconds = 8000) {
  const deadline = Date.now() + milliseconds
  let last
  do {
    last = await read()
    if (last) return last
    await sleep(40)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}; last observation: ${JSON.stringify(last)}`)
}

// Only the CDP primitives this file needs; no automation package or copied updater.
async function connectCdp(url, errors) {
  const socket = new WebSocket(url), pending = new Map(), contexts = new Map()
  let sequence = 0, iframeSession
  const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }))
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id); clearTimeout(request.timer)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    }
    if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'iframe') {
      iframeSession = message.params.sessionId
      call('Runtime.enable', {}, iframeSession).catch(error => errors.push(error.message))
    }
    if (message.method === 'Target.detachedFromTarget' && iframeSession === message.params.sessionId) iframeSession = undefined
    if (message.method === 'Runtime.executionContextCreated') {
      const context = message.params.context
      if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, { id: context.id, sessionId: message.sessionId })
    }
    if (message.method === 'Runtime.executionContextDestroyed' || message.method === 'Runtime.executionContextsCleared' || message.method === 'Target.detachedFromTarget') {
      for (const [frame, context] of contexts) {
        if (context.sessionId === (message.params?.sessionId ?? message.sessionId) &&
          (message.method !== 'Runtime.executionContextDestroyed' || context.id === message.params.executionContextId)) contexts.delete(frame)
      }
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Chrome CDP closed')) }
    pending.clear()
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Chrome CDP connection timeout')) }, 8000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); socket.close(); reject(new Error('Chrome CDP connection failed')) }, { once: true })
  })
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 12_000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const evaluate = async (expression, depth = 0) => {
    let context
    if (depth === 2 && iframeSession) {
      context = await until(() => [...contexts.values()].find(c => c.sessionId === iframeSession), 'opaque iframe execution context')
    } else if (depth) {
      let { frameTree } = await call('Page.getFrameTree')
      for (let index = 0; index < depth; index++) frameTree = frameTree?.childFrames?.[0]
      assert.ok(frameTree, `Missing frame at depth ${depth}`)
      context = contexts.get(frameTree.frame.id)
      assert.ok(context, `Missing default execution context at depth ${depth}`)
    }
    const result = await call('Runtime.evaluate', { expression, ...(context ? { contextId: context.id } : {}), returnByValue: true, awaitPromise: true }, context?.sessionId)
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await call('Runtime.enable'); await call('Page.enable')
  await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  return { call, evaluate, close: async () => { socket.close(); await Promise.race([closed, sleep(1000, undefined, { ref: false })]) } }
}

test('in Chrome, the production preview wrapper and React PreviewPane preserve state, reload safely and recover', { timeout: 180_000 }, async t => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const dir = await mkdtemp(join(tmpdir(), 'fx0-preview-update-'))
  const frames = new Map(), hits = new Map(), held = [], errors = []
  // Chrome decodes the valid PNG prefix; trailing bytes exercise embedding size,
  // not expensive pixel allocation. Three occurrences stay below the real budget.
  const largeImage = Buffer.alloc(Math.floor(1.1 * 1024 * 1024), 0x41)
  PIXEL.copy(largeImage)
  const paneArtifacts = new Map(), paneLatest = new Map(), paneModes = new Map(), paneRequests = [], paneHeld = [], bundleHeld = []
  let paneFixture, holdBundle = true
  let origin, chrome, cdp, chromeError = '', frameNumber = 0, requestNumber = 0, offRouteHits = 0
  const sendFrame = (response, preview) => {
    const prepared = prepareDesignArtifactHtml(preview.renderHtml, DESIGN_ARTIFACT_EMBEDDED_CSP, TOKEN)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': designFrameCsp(`${origin}/api/artifact-image`) })
    response.end(designFrameHtml(prepared, TOKEN, preview.images, preview))
  }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture')
    if (url.pathname === '/pane' && paneFixture) return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(paneFixture.html)
    if (url.pathname === '/bundle.js' && paneFixture) {
      if (holdBundle) return void bundleHeld.push(response)
      return response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(paneFixture.bundle)
    }
    if (url.pathname === '/api/artifact-frame') {
      const session = url.searchParams.get('session'), wanted = Number(url.searchParams.get('revision') ?? url.searchParams.get('v'))
      const revision = url.searchParams.has('revision') ? wanted : paneLatest.get(session)
      const preview = paneArtifacts.get(`${session}:${revision}`), json = url.searchParams.get('format') === 'json'
      paneRequests.push({ session, wanted, revision, json })
      if (!preview) return response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"No local design"}')
      if (!json) return sendFrame(response, preview)
      const mode = paneModes.get(`${session}:${wanted}`)
      if (mode === 'error') return response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"Local failure"}')
      // Only the external snapshot/data source is simulated. JSON never mounts or
      // executes a candidate; the real React effect decides what to do with it.
      const text = JSON.stringify(preview)
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'private, no-store' })
      if (mode === 'hang') {
        response.flushHeaders(); response.write(text.slice(0, 32))
        const entry = { response, rest: text.slice(32), closed: false }; paneHeld.push(entry)
        response.on('close', () => { entry.closed = !response.writableEnded })
        return
      }
      return response.end(text)
    }
    if (url.pathname === '/api/artifact-image') {
      const name = url.searchParams.get('name')
      hits.set(name, (hits.get(name) ?? 0) + 1)
      if (name === 'missing.png') return response.writeHead(404).end()
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      if (name?.startsWith('large-')) return response.end(largeImage)
      if (name === 'hang.png') {
        response.flushHeaders(); response.write(PIXEL.subarray(0, 8))
        const entry = { response, closed: false }; held.push(entry)
        response.on('close', () => { entry.closed = true })
        return
      }
      return response.end(PIXEL)
    }
    if (frames.has(url.pathname)) return sendFrame(response, frames.get(url.pathname))
    if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end(PARENT)
    if (url.pathname === '/not-an-image') { offRouteHits++; return response.end('must not be fetched') }
    response.writeHead(204).end()
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    origin = `http://127.0.0.1:${server.address().port}`
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let spawnError
    chrome.on('error', error => { spawnError = error })
    chrome.stderr.on('data', data => { chromeError = (chromeError + data).slice(-16_384) })
    const port = await until(async () => {
      if (spawnError) throw spawnError
      assert.equal(chrome.exitCode, null, chromeError)
      try { return (await readFile(join(dir, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0] }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }, 'Chrome debugging port')
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })).json()
    cdp = await connectCdp(targets.find(target => target.type === 'page').webSocketDebuggerUrl, errors)
    await cdp.call('Page.bringToFront')
    await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp.call('Page.navigate', { url: origin })
    await until(() => cdp.evaluate('typeof mount === "function"'), 'fixture parent')
    const evaluate = cdp.evaluate
    const observed = () => evaluate('observed')
    const state = () => evaluate('observed.reports.at(-1) ?? null')
    const waitState = predicate => until(async () => { const current = await state(); return current && predicate(current) && current }, 'design state report')
    const post = message => evaluate(`document.getElementById('active').contentWindow.postMessage(${JSON.stringify(message)}, location.origin)`)
    const interact = () => evaluate("{ const input = document.getElementById('input'); input.focus({ preventScroll: true }); input.setSelectionRange(2, 7); scrollTo(0, 900) }", 2)
    const mounted = async preview => {
      const path = `/frame-${++frameNumber}`; frames.set(path, preview)
      const count = (await observed()).paints.length
      await evaluate(`mount(${JSON.stringify(path)})`)
      await waitState(s => s.sameNodes && s.input === 'typed at runtime')
      await interact()
      await waitState(s => s.scroll === 900 && s.focused)
      assert.equal(await evaluate("document.querySelector('iframe').contentDocument.querySelector('iframe').contentDocument === null"), true, 'design keeps its opaque sandbox')
      return until(async () => (await observed()).paints.slice(count).find(p => p.protocol === 1 && p.sessionId === SESSION && p.revision === preview.revision && typeof p.documentId === 'string' && p.updateReady === true), `production paint + updater ready for revision ${preview.revision}`)
    }
    const start = async (paint, baseRevision, candidate) => {
      const requestId = `browser-request-${++requestNumber}`
      await post({ type: 'fx0-preview-update', protocol: 1, requestId, documentId: paint.documentId, baseRevision, payload: candidate })
      return requestId
    }
    const terminal = (requestId, milliseconds = 8000) => until(async () => (await observed()).results.find(result => result.requestId === requestId), `terminal result for ${requestId}`, milliseconds)
    const update = async (paint, baseRevision, candidate, expected = 'applied') => {
      const requestId = await start(paint, baseRevision, candidate), result = await terminal(requestId)
      assert.deepEqual({ type: result.type, protocol: result.protocol, requestId: result.requestId, documentId: result.documentId, sessionId: result.sessionId, revision: result.revision, status: result.status }, {
        type: 'fx0-preview-result', protocol: 1, requestId, documentId: paint.documentId, sessionId: SESSION, revision: candidate.revision, status: expected,
      }, JSON.stringify(result))
      if (expected !== 'applied') assert.equal(typeof result.reason, 'string')
      return result
    }
    const preserved = (before, after) => {
      for (const key of ['instance', 'program', 'input', 'focused', 'selection', 'scroll', 'className', 'clicks', 'runtimeLabel', 'generated', 'sameNodes']) assert.deepEqual(after[key], before[key], key)
      assert.equal(after.sameNodes, true)
    }
    const noErrors = async () => { assert.deepEqual(errors, []); assert.deepEqual((await observed()).errors, []) }

    // Fail once, rather than running every case against a legacy three-argument wrapper.
    let paint = await mounted(payload(1, design({ photo: true })))

    await t.test('first patch uses the real initial baseline; CSS, inline style and text preserve interactive state', async () => {
      const before = await state(), boots = (await observed()).boots.length
      assert.equal(before.photo, `data:image/png;base64,${PIXEL.toString('base64')}`)
      assert.equal(before.photoDecoded, true)
      await update(paint, 1, payload(2, design({ photo: true, color: 'rgb(90, 80, 70)' })))
      preserved(before, await waitState(s => s.color === 'rgb(90, 80, 70)'))
      await update(paint, 2, payload(3, design({ photo: true, color: 'rgb(90, 80, 70)', title: 'Edited title', padding: 12 })))
      preserved(before, await waitState(s => s.title === 'Edited title' && s.padding === '12px'))
      // Fresh marker/descriptor nonces must not turn unchanged embedded images into a conflict.
      await update(paint, 3, payload(4, design({ photo: true, color: 'rgb(90, 80, 70)', title: 'Edited title', padding: 12 })))
      preserved(before, await state())
      await evaluate("document.getElementById('next').click()", 2)
      assert.equal((await waitState(s => s.clicks === 1)).className, 'slide-5', 'the original listener still fires exactly once')
      assert.equal((await observed()).boots.length, boots, 'no speculative candidate or script restart')
      await noErrors()
    })

    await t.test('script and structure edits request reload without executing a candidate; a real remount accepts its first patch', async () => {
      const boots = (await observed()).boots.length
      const candidate = payload(5, design({ photo: true, color: 'rgb(90, 80, 70)', title: 'Edited title', padding: 12, program: 'replacement' }))
      await update(paint, 4, candidate, 'reload')
      await sleep(150)
      assert.equal((await observed()).boots.length, boots)
      assert.equal((await state()).program, 'original')
      paint = await mounted(candidate)
      assert.equal((await state()).program, 'replacement')
      assert.equal((await observed()).boots.length, boots + 1)
      await update(paint, 5, payload(6, design({ photo: true, color: 'rgb(1, 2, 3)', title: 'After real reload', padding: 12, program: 'replacement' })))
      await waitState(s => s.title === 'After real reload' && s.color === 'rgb(1, 2, 3)')
      await update(paint, 6, payload(7, design({ photo: true, color: 'rgb(1, 2, 3)', title: 'After real reload', padding: 12, program: 'replacement', structure: '<aside id="added">New structure</aside>' })), 'reload')
      assert.equal((await state()).added, false)
      assert.equal((await observed()).boots.length, boots + 1)
      await noErrors()
    })

    await t.test('CSS updates preserve cached stylesheet references and unchanged neighboring rules, including id-less styles', async () => {
      for (const sheetId of [true, false]) {
        const options = { sheetId, beforeLoad: 'window.cachedSheet = refs.theme.sheet; window.cachedFirstRule = cachedSheet.cssRules[0]' }
        const current = await mounted(payload(200, design(options))), before = await state(), boots = (await observed()).boots.length
        await update(current, 200, payload(201, design({ ...options, color: 'rgb(90, 80, 70)' })))
        preserved(before, await waitState(s => s.color === 'rgb(90, 80, 70)'))
        assert.equal(await evaluate('cachedSheet === refs.theme.sheet', 2), true, 'authored code keeps its CSSStyleSheet reference')
        assert.equal(await evaluate('cachedFirstRule === cachedSheet.cssRules[0]', 2), true, 'an unchanged neighboring rule is not replaced')
        await update(current, 201, payload(202, design({ ...options, color: 'rgb(21, 32, 43)' })))
        preserved(before, await waitState(s => s.color === 'rgb(21, 32, 43)'))
        assert.equal(await evaluate('cachedSheet === refs.theme.sheet', 2), true, 'a second update keeps the same stylesheet')
        await evaluate('window.currentRules = [...cachedSheet.cssRules]', 2)
        const formatted = design({ ...options, color: 'rgb(21, 32, 43)' }).replace('body{margin:0;', '/* formatting only */body{margin:0;')
        await update(current, 202, payload(203, formatted))
        assert.equal(await evaluate('currentRules.every((rule, index) => cachedSheet.cssRules[index] === rule)', 2), true, 'canonical no-ops do not replace rule objects')
        await evaluate("cachedSheet.insertRule('#title { color: rgb(4, 5, 6) }', cachedSheet.cssRules.length)", 2)
        preserved(before, await waitState(s => s.color === 'rgb(4, 5, 6)'))
        const result = await update(current, 203, payload(204, design({ ...options, color: 'rgb(99, 88, 77)', title: 'Must not overwrite runtime CSS' })), 'reload')
        assert.match(result.reason, /stylesheet.*conflict/)
        assert.equal((await state()).title, before.title, 'a CSSOM conflict prevents unrelated text writes')
        assert.equal((await observed()).boots.length, boots)
      }
      await noErrors()
    })

    await t.test('id-less stylesheet lookup distinguishes logical duplicates from stale physical text after an update', async () => {
      for (const duplicate of ['logical', 'physical']) {
        const options = { sheetId: false }, original = design(options), changed = design({ ...options, color: 'rgb(90, 80, 70)' })
        const current = await mounted(payload(210, original)), before = await state()
        await update(current, 210, payload(211, changed))
        await waitState(s => s.color === 'rgb(90, 80, 70)')
        const css = (duplicate === 'logical' ? changed : original).match(/<style>([\s\S]*?)<\/style>/)[1]
        await evaluate(`{ const extra = document.createElement('style'); extra.textContent = ${JSON.stringify(css)}; document.head.append(extra) }`, 2)
        const result = await update(current, 211, payload(212, design({ ...options, color: 'rgb(21, 32, 43)', title: 'Unambiguous update' })), duplicate === 'logical' ? 'reload' : 'applied')
        if (duplicate === 'logical') {
          assert.match(result.reason, /target/)
          assert.equal((await state()).title, before.title)
        } else {
          preserved(before, await waitState(s => s.title === 'Unambiguous update'))
          assert.equal(await evaluate("[...refs.theme.sheet.cssRules].some(rule => rule.cssText.includes('rgb(21, 32, 43)'))", 2), true)
        }
      }
      await noErrors()
    })

    await t.test('CSS preflight rejects imports and invalid namespace splices before any stylesheet or text write', async () => {
      const cases = [
        { before: '#other { color: red }', after: '@import "data:text/css,body{}"; #other { color: red }' },
        { before: '@namespace test "urn:old"; test|p { color: red }', after: '@namespace test "urn:new"; test|p { color: red }' },
      ]
      for (const { before: first, after: next } of cases) {
        const original = design({ structure: `<style id="secondary">${first}</style>` })
        const current = await mounted(payload(220, original)), before = await state()
        const candidate = design({ color: 'rgb(99, 88, 77)', title: 'Must not write', structure: `<style id="secondary">${next}</style>` })
        await update(current, 220, payload(221, candidate), 'reload')
        const after = await state()
        assert.equal(after.title, before.title)
        assert.equal(after.color, before.color)
        assert.equal(after.cssText, before.cssText)
        preserved(before, after)
      }
      await noErrors()
    })

    await t.test('runtime stylesheet changes before load and after a hot update remain conflicts', async () => {
      for (const mutation of ["refs.theme.sheet.insertRule('body { outline: 3px solid red }', refs.theme.sheet.cssRules.length)", "refs.theme.textContent += '\\n'"]) {
        const options = { beforeLoad: mutation }, current = await mounted(payload(230, design(options))), before = await state()
        await update(current, 230, payload(231, design({ ...options, color: 'rgb(99, 88, 77)', title: 'Must not write' })), 'reload')
        assert.equal((await state()).title, before.title)
        assert.equal((await state()).cssText, before.cssText)
      }
      const current = await mounted(payload(240, design()))
      await update(current, 240, payload(241, design({ color: 'rgb(90, 80, 70)' })))
      const before = await waitState(s => s.color === 'rgb(90, 80, 70)')
      await evaluate("refs.theme.textContent += '\\n'", 2)
      await update(current, 241, payload(242, design({ color: 'rgb(99, 88, 77)', title: 'Must not write' })), 'reload')
      assert.equal((await state()).title, before.title)
      await noErrors()
    })

    await t.test('a real hot update retains a fully embedded render past 2 MiB within the image budget', async largeTest => {
      const names = ['large-a.png', 'large-b.png', 'large-c.png']
      const options = {
        structure: names.map((name, index) => `<img id="large-${index}" alt="Large local image ${index}" src="https://fixture.invalid/${name}">`).join(''),
        beforeLoad: 'for (const image of document.images) refs[image.id] = image',
      }
      const initial = payload(8, design(options))
      assert.equal(initial.images.length, 3)
      assert.ok(Buffer.byteLength(initial.sourceHtml) < 16 * 1024, 'canonical HTML stays small; the wrapper must embed the large render')
      assert.ok(Buffer.byteLength(initial.renderHtml) < 16 * 1024)
      const expectedBytes = names.length * largeImage.length
      assert.ok(expectedBytes > 3 * 1024 * 1024 && expectedBytes <= MAX_EMBEDDED_IMAGE_BYTES)
      const expectedHash = createHash('sha256').update(`data:image/png;base64,${largeImage.toString('base64')}`).digest('hex')
      // Return only lengths, digests and decode state. Even failures must never dump
      // the multi-megabyte data URLs into TAP or the continuously polled reports.
      const resources = () => evaluate(`(async () => ({
        documentUrl: document.URL,
        bodyBytes: new TextEncoder().encode(document.body.outerHTML).length,
        images: await Promise.all([...document.images].map(async image => {
          const source = image.getAttribute('src'), data = source.slice(source.indexOf(',') + 1)
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))
          return { id: image.id, png: source.startsWith('data:image/png;base64,'),
            bytes: data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0),
            hash: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''),
            decoded: image.complete && image.naturalWidth === 1 && image.naturalHeight === 1 }
        }))
      }))()`, 2)
      const boots = (await observed()).boots.length
      const current = await mounted(initial)
      const before = await state(), embedded = await resources()
      assert.match(embedded.documentUrl, /^blob:/)
      assert.ok(embedded.bodyBytes > 2 * 1024 * 1024, 'the live embedded body, not just its bootstrap or raw source, exceeds 2 MiB')
      assert.deepEqual(embedded.images, names.map((_, index) => ({ id: `large-${index}`, png: true, bytes: largeImage.length, hash: expectedHash, decoded: true })))
      const embeddedBytes = embedded.images.reduce((total, image) => total + image.bytes, 0)
      assert.equal(embeddedBytes, expectedBytes)
      assert.ok(embeddedBytes <= MAX_EMBEDDED_IMAGE_BYTES)
      assert.equal((await observed()).boots.length, boots + 1)
      const mountUrl = await evaluate("document.getElementById('active').src")
      const candidate = payload(9, design({ ...options, color: 'rgb(71, 82, 93)', title: 'Large render hot update' }))
      assert.equal(candidate.images.length, 3)
      await update(current, 8, candidate)
      preserved(before, await waitState(s => s.title === 'Large render hot update' && s.color === 'rgb(71, 82, 93)'))
      const after = await resources()
      assert.equal(after.documentUrl, embedded.documentUrl)
      assert.ok(after.bodyBytes > 2 * 1024 * 1024)
      assert.deepEqual(after.images, embedded.images, 'all three decoded images and their complete embedded bytes are retained')
      assert.equal((await observed()).boots.length, boots + 1, 'the large candidate does not execute another iframe program')
      assert.equal(await evaluate("document.getElementById('active').src"), mountUrl)
      assert.equal(await evaluate("document.querySelectorAll('iframe').length"), 1)
      for (const name of names) assert.equal(hits.get(name), 2, `${name}: initial preparation and hot preparation both use the real image route`)
      largeTest.diagnostic(`embedded image bytes=${embeddedBytes}/${MAX_EMBEDDED_IMAGE_BYTES}; live body bytes=${after.bodyBytes}`)
      await noErrors()
    })

    await t.test('CSSOM rules and disabled sheets conflict before any patch writes', async () => {
      for (const mutation of ["sheet.insertRule('body { outline: 3px solid red }', sheet.cssRules.length)", 'sheet.disabled = true']) {
        const current = await mounted(payload(10, design()))
        await evaluate(`{ const sheet = document.getElementById('theme').sheet; ${mutation} }`, 2)
        const before = await waitState(s => mutation.includes('disabled') ? s.disabled : s.rules === 4)
        const result = await update(current, 10, payload(11, design({ color: 'rgb(99, 88, 77)', title: 'Must not write' })), 'reload')
        assert.match(result.reason, /stylesheet.*conflict/)
        await sleep(100)
        const after = await state()
        assert.equal(after.title, before.title, 'all operations are preflighted before writing')
        assert.equal(after.cssText, before.cssText)
        assert.equal(after.rules, before.rules)
        assert.equal(after.disabled, before.disabled, 'hot update must not re-enable a disabled sheet')
        preserved(before, after)
      }
      await noErrors()
    })

    await t.test('a target changed before load is not adopted as the authored baseline', async () => {
      const options = { beforeLoad: "refs.title.textContent = 'Changed before load'" }
      const current = await mounted(payload(20, design(options))), before = await state()
      assert.equal(before.title, 'Changed before load')
      const result = await update(current, 20, payload(21, design({ ...options, title: 'Candidate title', color: 'rgb(99, 88, 77)' })), 'reload')
      assert.match(result.reason, /text.*conflict/)
      await sleep(100)
      const after = await state()
      assert.equal(after.title, before.title)
      assert.equal(after.cssText, before.cssText, 'a later text conflict prevents even an earlier CSS operation')
      preserved(before, after)
      await noErrors()
    })

    await t.test('incidental embedded image differences require reload even when authored images are unchanged', async () => {
      const current = await mounted(payload(30, design({ photo: true }))), before = await state()
      await update(current, 30, payload(31, design({ photo: true, color: 'rgb(99, 88, 77)' }), 'missing.png'), 'reload')
      await sleep(100)
      const after = await state()
      assert.equal(after.photo, before.photo)
      assert.equal(after.cssText, before.cssText)
      preserved(before, after)
      await noErrors()
    })

    await t.test('an initially image-free wrapper embeds a later CSS image using only its permitted endpoint', async () => {
      const current = await mounted(payload(40, design())), before = await state(), requests = hits.get('pixel.png') ?? 0
      await update(current, 40, payload(41, design({ image: 'pixel.png' })))
      const after = await waitState(s => s.background.includes('data:image/png;base64,'))
      preserved(before, after)
      assert.equal(hits.get('pixel.png'), requests + 1)
      assert.match(after.csp, /connect-src 'none'/)
      assert.match(after.csp, /img-src data:/)
      assert.equal(await evaluate("fetch('/not-an-image').then(() => false, () => true)", 1), true, 'wrapper connect-src is path-only, not the whole origin')
      assert.equal(offRouteHits, 0)
      assert.equal(await evaluate(`fetch(${JSON.stringify(`${origin}/api/artifact-image?name=forbidden.png`)}).then(() => false, () => true)`, 2), true, 'opaque child cannot fetch even the allowed wrapper endpoint')
      assert.equal(hits.get('forbidden.png') ?? 0, 0)
      await noErrors()
    })

    await t.test('wrong source, protocol, session and document messages are ignored, not used to fetch or mutate', async () => {
      const current = await mounted(payload(50, design())), before = await state(), results = (await observed()).results.length
      const candidate = payload(51, design({ image: 'forbidden.png' }))
      const message = { type: 'fx0-preview-update', protocol: 1, requestId: 'untrusted-source', documentId: current.documentId, baseRevision: 50, payload: candidate }
      await evaluate(`postMessage(${JSON.stringify(message)}, location.origin)`, 1)
      await evaluate(`parent.postMessage(${JSON.stringify(message)}, '*')`, 2)
      await post({ ...message, requestId: 'wrong-protocol', protocol: 2 })
      await post({ ...message, requestId: 'wrong-document', documentId: 'not-the-live-document' })
      await post({ ...message, requestId: 'wrong-session', payload: { ...candidate, sessionId: 'other-session' } })
      await post({ type: 'fx0-preview-result', protocol: 1, requestId: 'forged-ack', documentId: current.documentId, sessionId: SESSION, revision: 51, status: 'applied' })
      await sleep(350)
      assert.equal((await observed()).results.length, results)
      assert.equal(hits.get('forbidden.png') ?? 0, 0)
      preserved(before, await state())
      await update(current, 50, payload(52, design({ title: 'Authenticated patch' })))
      await waitState(s => s.title === 'Authenticated patch')
      await noErrors()
    })

    await t.test('a hung image body hits the ten-second preparation deadline; late completion cannot replace the newest patch', async () => {
      const current = await mounted(payload(60, design())), before = await state(), count = held.length
      const began = Date.now(), requestId = await start(current, 60, payload(61, design({ image: 'hang.png' })))
      await until(() => held.length === count + 1, 'hung body request received')
      const result = await terminal(requestId, 15_000)
      assert.equal(result.status, 'applied', JSON.stringify(result))
      assert.equal(result.revision, 61); assert.equal(result.protocol, 1)
      assert.equal(result.documentId, current.documentId); assert.equal(result.sessionId, SESSION)
      assert.ok(Date.now() - began >= 9000, 'deadline includes reading the response body, not just headers')
      const placeholder = await waitState(s => s.background.includes(BLANK_IMAGE))
      preserved(before, placeholder)
      await until(() => held[count].closed, 'timed-out image reader/request aborted')
      await update(current, 61, payload(62, design({ image: 'pixel.png', title: 'Newest after timeout' })))
      const newest = await waitState(s => s.title === 'Newest after timeout' && s.background.includes('data:image/png;base64,'))
      held[count].response.end(PIXEL.subarray(8))
      await sleep(250)
      const after = await state()
      assert.equal(after.title, newest.title); assert.equal(after.background, newest.background)
      preserved(before, after)
      assert.equal((await observed()).results.filter(r => r.requestId === requestId).length, 1)
      await noErrors()
    })

    await t.test('canceling preparation returns one terminal error; a newer revision wins over late image data', async () => {
      const current = await mounted(payload(70, design())), before = await state(), count = held.length
      const requestId = await start(current, 70, payload(71, design({ image: 'hang.png', title: 'Canceled candidate' })))
      await until(() => held.length === count + 1, 'cancelable hung image request')
      await post({ type: 'fx0-preview-cancel', protocol: 1, requestId, documentId: current.documentId })
      const result = await terminal(requestId)
      assert.equal(result.status, 'error', JSON.stringify(result)); assert.equal(result.revision, 71)
      assert.equal(result.protocol, 1); assert.equal(result.documentId, current.documentId); assert.equal(result.sessionId, SESSION)
      assert.match(result.reason, /cancel/i)
      await until(() => held[count].closed, 'canceled image reader/request aborted')
      await update(current, 70, payload(72, design({ title: 'Newest after cancel', color: 'rgb(3, 4, 5)' })))
      await waitState(s => s.title === 'Newest after cancel')
      held[count].response.end(PIXEL.subarray(8))
      await sleep(250)
      const after = await state()
      assert.equal(after.title, 'Newest after cancel'); assert.equal(after.background, 'none')
      preserved(before, after)
      assert.equal((await observed()).results.filter(r => r.requestId === requestId).length, 1)
      await noErrors()
    })

    await t.test('watchdog recovery uses the last confirmed snapshot and new document identity, then accepts its first patch', async () => {
      const current = await mounted(payload(80, design()))
      await update(current, 80, payload(81, design({ title: 'Confirmed recovery snapshot', color: 'rgb(8, 9, 10)' })))
      await waitState(s => s.title === 'Confirmed recovery snapshot')
      const before = await observed(), oldInstance = (await state()).instance
      // Real self-navigation loses the bootstrap/heartbeat. The wrapper, not the test,
      // must recreate the confirmed document and install its fresh seed internally.
      await evaluate("location.replace('about:blank')", 2)
      const recovered = await until(async () => (await observed()).paints.slice(before.paints.length).find(p => p.protocol === 1 && p.sessionId === SESSION && p.revision === 81 && p.documentId !== current.documentId && p.updateReady), 'watchdog recovery paint')
      await interact()
      const restored = await waitState(s => s.instance !== oldInstance && s.title === 'Confirmed recovery snapshot' && s.scroll === 900)
      assert.equal(restored.color, 'rgb(8, 9, 10)')
      assert.equal((await observed()).boots.length, before.boots.length + 1)
      const results = (await observed()).results.length
      await start(current, 81, payload(82, design({ image: 'forbidden.png' })))
      await post({ type: 'fx0-preview-cancel', protocol: 1, requestId: 'stale-cancel', documentId: current.documentId })
      await sleep(250)
      assert.equal((await observed()).results.length, results, 'the same WindowProxy cannot revive old document IDs')
      assert.equal(hits.get('forbidden.png') ?? 0, 0)
      await update(recovered, 81, payload(83, design({ title: 'First patch after recovery', color: 'rgb(11, 12, 13)' })))
      const after = await waitState(s => s.title === 'First patch after recovery' && s.color === 'rgb(11, 12, 13)')
      preserved(restored, after)
      assert.equal((await observed()).boots.length, before.boots.length + 1)
      await noErrors()
    })
    await noErrors()

    await t.test('the real React PreviewPane hydrates, hot-updates, reloads, times out, retries and clears private scopes', async () => {
      paneFixture = await buildPaneFixture(dir)
      const publish = (revision, options = {}, sessionId = SESSION) => {
        const candidate = { ...payload(revision, design(options)), sessionId }
        paneArtifacts.set(`${sessionId}:${revision}`, candidate); paneLatest.set(sessionId, revision)
      }
      const frontSelector = '#preview-pane iframe[title="Design artifact preview"]:not([aria-hidden="true"])'
      const paneState = () => evaluate(`(() => { const frame = document.querySelector(${JSON.stringify(frontSelector)}); return frame ? observed.reports.filter(s => s.mountUrl === frame.getAttribute('src')).at(-1) ?? null : null })()`)
      const waitPane = predicate => until(async () => { const current = await paneState(); return current && predicate(current) && current }, 'visible React PreviewPane state')
      const applied = revision => until(async () => (await observed()).results.find(r => r.status === 'applied' && r.protocol === 1 && r.revision === revision), `React-coordinated applied revision ${revision}`)
      const painted = revision => until(async () => (await observed()).paints.find(p => p.protocol === 1 && p.revision === revision && p.updateReady), `React-coordinated painted revision ${revision}`)
      const iframeCount = () => evaluate("document.querySelectorAll('#preview-pane iframe').length")
      const status = () => evaluate("document.querySelector('#preview-pane [role=status]')?.textContent ?? ''")
      const htmlCount = () => paneRequests.filter(r => !r.json).length
      try {
        publish(101)
        await cdp.call('Page.navigate', { url: `${origin}/pane` })
        await painted(101)
        await waitPane(s => s.title === 'Original title')
        const ssr = await observed(), initialHtmlCount = htmlCount()
        assert.equal(ssr.boots.length, 1)
        assert.equal(initialHtmlCount, 1)
        assert.equal(await evaluate('typeof setRevision'), 'undefined', 'SSR iframe paints before the hydration bundle is released')
        await evaluate(`void (window.initialPaneFrame = document.querySelector(${JSON.stringify(frontSelector)}))`)
        holdBundle = false
        for (const response of bundleHeld.splice(0)) response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(paneFixture.bundle)
        await until(() => evaluate('window.fixtureReady === true'), 'real React hydration effects')
        await until(async () => (await observed()).paints.length > ssr.paints.length, 'status handshake replays an already-painted SSR document')
        assert.equal(htmlCount(), initialHtmlCount, 'hydration adopts the SSR load instead of starting another document')
        assert.equal((await observed()).boots.length, 1)
        await interact()
        const before = await waitPane(s => s.scroll === 900 && s.focused)
        const initialSrc = await evaluate('initialPaneFrame.getAttribute("src")')
        const initialPaint = (await painted(101)).documentId

        // The server can already be ahead of the journal event. The next patch must
        // use that actual applied revision, not the event's requested revision.
        publish(103, { color: 'rgb(30, 40, 50)', title: 'Server already at 103' })
        await evaluate("setDraft('<!doctype html><html><head></head><body><p>Unpublished draft</p></body></html>'); setRevision(102)")
        assert.equal((await applied(103)).documentId, initialPaint)
        preserved(before, await waitPane(s => s.title === 'Server already at 103' && s.color === 'rgb(30, 40, 50)'))
        publish(104, { color: 'rgb(60, 70, 80)', title: 'Next patch after actual revision', padding: 12 })
        await evaluate('setRevision(104)')
        assert.equal((await applied(104)).documentId, initialPaint)
        preserved(before, await waitPane(s => s.title === 'Next patch after actual revision' && s.padding === '12px' && s.color === 'rgb(60, 70, 80)'))
        assert.equal(await evaluate('initialPaneFrame === document.querySelector(' + JSON.stringify(frontSelector) + ')'), true)
        assert.equal(await evaluate('initialPaneFrame.getAttribute("src")'), initialSrc)
        assert.equal(htmlCount(), initialHtmlCount, 'compatible effects never navigate src or execute a candidate frame')
        assert.equal((await observed()).boots.length, 1)
        assert.equal(await iframeCount(), 1, 'a draft cannot cover the published interactive design')
        const requestsBeforeOldEvent = paneRequests.length
        await evaluate('setDraft(null); setRevision(103)')
        await sleep(150)
        assert.equal(paneRequests.length, requestsBeforeOldEvent, 'an old journal event does not roll the preview back')
        await evaluate("document.getElementById('next').click()", 2)
        assert.equal((await waitPane(s => s.clicks === 1)).className, 'slide-5')

        // An incompatible program is executed only by the real second-slot HTML
        // load, once. Then a compatible patch must use that new document's baseline.
        publish(105, { program: 'react replacement', title: 'Reloaded through React' })
        await evaluate('setRevision(105)')
        const reloadedPaint = await painted(105)
        await waitPane(s => s.program === 'react replacement' && s.title === 'Reloaded through React')
        await until(async () => await iframeCount() === 1, 'old double-buffer slot removed')
        assert.notEqual(reloadedPaint.documentId, initialPaint)
        assert.equal((await observed()).results.filter(r => r.revision === 105 && r.status === 'reload').length, 1)
        assert.equal(htmlCount(), initialHtmlCount + 1)
        assert.equal((await observed()).boots.length, 2, 'no speculative candidate execution or duplicate reload')
        assert.equal(await evaluate('initialPaneFrame.isConnected'), false)
        await evaluate(`void (window.reloadedPaneFrame = document.querySelector(${JSON.stringify(frontSelector)}))`)
        await interact()
        const reloaded = await waitPane(s => s.scroll === 900 && s.focused)
        publish(106, { program: 'react replacement', title: 'First patch after React reload', padding: 8 })
        await evaluate('setRevision(106)')
        assert.equal((await applied(106)).documentId, reloadedPaint.documentId)
        preserved(reloaded, await waitPane(s => s.title === 'First patch after React reload' && s.padding === '8px'))
        assert.equal((await observed()).boots.length, 2)

        const confirmed = await paneState(), htmlBeforeStall = htmlCount(), heldCount = paneHeld.length
        publish(107, { program: 'react replacement', title: 'Must not apply a partial JSON body' })
        paneModes.set(`${SESSION}:107`, 'hang')
        const began = Date.now()
        await evaluate('setRevision(107)')
        await until(() => paneHeld.length === heldCount + 1, 'React JSON acquisition reaches the stalled body')
        await until(async () => (await status()).includes('timed out'), 'React ten-second body deadline', 15_000)
        assert.ok(Date.now() - began >= 9000, 'acquisition deadline covers the body, not just response headers')
        await until(() => paneHeld[heldCount].closed, 'React aborts the stalled response reader')
        preserved(confirmed, await paneState())
        assert.equal((await paneState()).title, confirmed.title)
        assert.equal(htmlCount(), htmlBeforeStall, 'acquisition timeout retains the confirmed document without an automatic reload')
        assert.equal((await observed()).boots.length, 2)
        assert.equal(paneRequests.filter(r => r.wanted === 107).length, 1, 'no automatic request loop')
        publish(108, { program: 'react replacement', title: 'Retry gets the actual latest revision', padding: 10 })
        paneModes.delete(`${SESSION}:107`)
        await evaluate("[...document.querySelectorAll('#preview-pane button')].find(button => button.textContent === 'Retry preview').click()")
        assert.equal((await applied(108)).documentId, reloadedPaint.documentId)
        const newest = await waitPane(s => s.title === 'Retry gets the actual latest revision' && s.padding === '10px')
        assert.equal(await status(), '')
        assert.equal(await evaluate('reloadedPaneFrame === document.querySelector(' + JSON.stringify(frontSelector) + ')'), true)
        paneHeld[heldCount].response.end(paneHeld[heldCount].rest)
        await sleep(200)
        assert.equal((await paneState()).title, newest.title, 'late partial-body completion cannot roll back the retry')
        assert.equal((await observed()).results.some(r => r.revision === 107), false)

        // A real history/scope change must cancel acquisition. Returning to latest
        // is an explicit document load, not an attempt to patch the historical one.
        publish(110, { program: 'never execute canceled JSON', title: 'Canceled navigation candidate' })
        paneModes.set(`${SESSION}:110`, 'hang')
        const navigationHeld = paneHeld.length
        await evaluate('setRevision(110)')
        await until(() => paneHeld.length === navigationHeld + 1, 'navigation races a JSON acquisition')
        await evaluate('setViewing(101)')
        await painted(101)
        await waitPane(s => s.program === 'original' && s.title === 'Original title' && s.instance !== before.instance)
        await until(() => paneHeld[navigationHeld].closed, 'history navigation aborts the old acquisition')
        paneModes.delete(`${SESSION}:110`)
        await until(async () => await iframeCount() === 1, 'history owns one confirmed slot')
        assert.equal(await evaluate(`new URL(document.querySelector(${JSON.stringify(frontSelector)}).src).searchParams.get('revision')`), '101')
        assert.ok(paneRequests.some(r => !r.json && r.wanted === 101 && r.revision === 101))
        publish(111, { program: 'latest after history', title: 'Returned to latest' })
        await evaluate('setViewing(null)')
        await painted(111)
        await waitPane(s => s.program === 'latest after history' && s.title === 'Returned to latest')
        paneHeld[navigationHeld].response.end(paneHeld[navigationHeld].rest)
        await sleep(200)
        assert.equal((await observed()).boots.some(b => b.program === 'never execute canceled JSON'), false)
        assert.equal((await paneState()).title, 'Returned to latest')

        const otherSession = 'other-preview-browser-session'
        publish(1, { program: 'other private session', title: 'Other private design' }, otherSession)
        await evaluate(`setSession(${JSON.stringify(otherSession)}); setRevision(1)`)
        await waitPane(s => s.program === 'other private session' && s.title === 'Other private design')
        await until(async () => await iframeCount() === 1, 'new session replaces the old scope')
        assert.equal(await evaluate(`new URL(document.querySelector(${JSON.stringify(frontSelector)}).src).searchParams.get('session')`), otherSession)
        // Revocation must remove *all* private layers, not reveal a draft that had
        // been correctly hidden behind the published design or retain its link dialog.
        await evaluate("setDraft('<!doctype html><html><head></head><body><p>Private retained draft</p></body></html>')")
        assert.equal(await iframeCount(), 1)
        await evaluate("parent.postMessage({type:'fx0-artifact-open',url:'https://example.com/private-design-link'},location.origin)", 1)
        await until(() => evaluate("!!document.querySelector('[role=dialog]')"), 'private design link confirmation')
        const requestsBeforeZero = paneRequests.length
        await evaluate("window.dispatchEvent(new CustomEvent('fx0:auth-required',{detail:401}))")
        await until(async () => await iframeCount() === 0, 'revocation removes both published and draft iframes')
        await until(() => evaluate("!document.querySelector('[role=dialog]')"), 'revocation closes the private design link')
        await sleep(200)
        assert.equal(paneRequests.length, requestsBeforeZero)
        assert.equal(await status(), '')
        assert.equal(await iframeCount(), 0, 'a retained draft or late result cannot revive the private scope')
        // Revision zero still supports a legitimate authorized first-generation draft.
        await evaluate("setAccessAllowed(true);setDraft('<!doctype html><html><head></head><body><p>Authorized first draft</p></body></html>')")
        await until(() => evaluate("!!document.querySelector('iframe[title=\"Design preview while generating\"]')"), 'authorized first-generation draft remains supported')
        await evaluate('setDraft(null)')

        // With no confirmed document, an initial JSON failure is recoverable via
        // the component's own Retry button, not a test-driven iframe mount.
        publish(2, { program: 'initial retry', title: 'Initial failure recovered' }, otherSession)
        paneModes.set(`${otherSession}:2`, 'error')
        const htmlBeforeInitialError = htmlCount(), bootsBeforeInitialError = (await observed()).boots.length
        await evaluate('setRevision(2)')
        await until(async () => (await status()).includes('could not be loaded'), 'initial acquisition error')
        assert.equal(await iframeCount(), 0)
        assert.equal(htmlCount(), htmlBeforeInitialError)
        paneModes.delete(`${otherSession}:2`)
        await evaluate("[...document.querySelectorAll('#preview-pane button')].find(button => button.textContent === 'Retry preview').click()")
        await waitPane(s => s.program === 'initial retry' && s.title === 'Initial failure recovered')
        assert.equal(htmlCount(), htmlBeforeInitialError + 1)
        assert.equal((await observed()).boots.length, bootsBeforeInitialError + 1)
        assert.equal(paneRequests.filter(r => r.session === otherSession && r.wanted === 2 && r.json).length, 2)
        assert.equal(await status(), '')
        await noErrors()
      } catch (error) {
        t.diagnostic(`React fixture failure: ${error.stack}; browser errors: ${JSON.stringify(errors)}`)
        t.diagnostic(`React fixture requests: ${JSON.stringify(paneRequests)}`)
        t.diagnostic(`React fixture observation: ${JSON.stringify(await evaluate('({ ...observed, reports: observed.reports.slice(-1) })'))}`)
        throw error
      } finally {
        holdBundle = false
        for (const response of bundleHeld.splice(0)) response.destroy()
        for (const { response } of paneHeld) response.destroy()
      }
    })
    await noErrors()
  } catch (error) {
    t.diagnostic(`Browser failure: ${error.stack}; runtime errors: ${JSON.stringify(errors)}`)
    t.diagnostic(`Chrome stderr (tail): ${chromeError}`)
    if (cdp) {
      try { t.diagnostic(`Last browser observations: ${JSON.stringify(await cdp.evaluate('({ ...observed, reports: observed.reports.slice(-1) })'))}`) } catch {}
    }
    throw error
  } finally {
    // Owned resources only. Bound graceful shutdown, then force cleanup even after a
    // failed assertion/CDP connection so a hung image cannot strand Chrome or a port.
    if (cdp) await cdp.close()
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise(resolve => chrome.once('exit', resolve))
      chrome.kill('SIGTERM')
      await Promise.race([exited, sleep(2000, undefined, { ref: false })])
      if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await exited }
    }
    chrome?.stderr.destroy()
    for (const { response } of [...held, ...paneHeld]) response.destroy()
    for (const response of bundleHeld) response.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
