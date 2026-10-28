import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { prepareDesignArtifactHtml } from '../lib/design-artifact.ts'

// Compile the real UI entry points, as html-ui.test.mjs does. No backend/build output
// or browser dependencies are needed. Drive their hooks and inspect React elements:
// this covers effects, rendered branches and user callbacks, not browser layout.
const root = new URL('../', import.meta.url)
const projectUrl = new URL('../package.json', import.meta.url).href
const output = realpathSync(mkdtempSync(join(tmpdir(), 'fx0-collab-ui-')))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url)), [
  '--ignoreConfig', '--outDir', output, '--strict', '--types', 'node',
  '--jsx', 'react-jsx', '--target', 'esnext', '--module', 'esnext',
  '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
  'components/collab-app.tsx', 'components/collab-canvas.tsx',
], { cwd: root, stdio: 'pipe' })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
const outputUrl = pathToFileURL(`${output}/`).href
const entries = ['collab-app', 'collab-canvas'].map(name => new URL(`components/${name}.js`, outputUrl).href)

// Only the two entry points get controlled hooks. Their JSX runtime and child
// components remain real React; children are inspected, not recursively rendered.
const hookUrl = `data:text/javascript,${encodeURIComponent(`
let active
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
export function useState(initial) {
  const h = active, i = h.index++
  if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial
  return [h.slots[i], value => { h.slots[i] = typeof value === 'function' ? value(h.slots[i]) : value }]
}
export function useRef(initial) {
  const h = active, i = h.index++
  return h.slots[i] ??= { current: initial }
}
export function useCallback(fn, deps) {
  const h = active, i = h.index++
  if (!same(h.slots[i]?.deps, deps)) h.slots[i] = { fn, deps }
  return h.slots[i].fn
}
export function useEffect(fn, deps) {
  const h = active, i = h.index++, previous = h.slots[i]
  if (same(previous?.deps, deps)) return
  h.slots[i] = { deps }
  h.effects.push(() => { previous?.cleanup?.(); h.slots[i].cleanup = fn() })
}
export function harness(Component, props = {}) {
  const h = { slots: [], effects: [], index: 0, tree: null,
    render(next = props) {
      props = next; h.index = 0; active = h
      try { h.tree = Component(props) } finally { active = null }
      for (const effect of h.effects.splice(0)) effect()
      return h.tree
    },
    async settle() { for (let i = 0; i < 12; i++) { await new Promise(resolve => setImmediate(resolve)); h.render() } },
    unmount() { for (const slot of h.slots) if (slot?.cleanup) { slot.cleanup(); slot.cleanup = undefined } },
  }
  return h
}
`)}`
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (!context.parentURL?.startsWith(outputUrl)) return nextResolve(specifier, context)
  if (specifier === 'react' && entries.includes(context.parentURL)) return { url: hookUrl, shortCircuit: true }
  if (specifier.startsWith('.')) return nextResolve(`${specifier.replace(/\.ts$/, '')}.js`, context)
  return nextResolve(specifier, { ...context, parentURL: projectUrl })
} })
after(() => hooks.deregister())
const { harness } = await import(hookUrl)
const { default: CollabApp } = await import(entries[0])
const { default: CollabCanvas } = await import(entries[1])

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [tree, ...nodes(tree.props.children)]
}
const component = (tree, name) => nodes(tree).find(node => node.type?.name === name)
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.props.children === label)
const snapshot = (id = 'room-1', revision = 1) => ({
  id, title: 'Shared design', version: 1, status: 'idle', review: false,
  messages: [], members: [], viewerId: 'viewer',
  revisions: [{ id: revision, createdAt: 1 }],
})

function browser(t, href = 'https://fx0.test/ampersand?room=room-1') {
  const listeners = new Map()
  const window = {
    location: { href },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
    setInterval() { return 1 }, clearInterval() {},
    history: {},
  }
  for (const method of ['replaceState', 'pushState']) window.history[method] = (_state, _unused, url) => {
    window.location.href = new URL(url, window.location.href).href
  }
  const cleanups = [], restores = []
  for (const [key, value] of Object.entries({ window, localStorage: { getItem: () => 'Ada', setItem() {} }, document: {
    visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
  } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    restores.push(() => { if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key] })
  }
  t.after(() => { for (const cleanup of [...cleanups, ...restores]) cleanup() })
  return {
    window, listeners, onCleanup(fn) { cleanups.push(fn) },
    emit(type, event = {}) { for (const fn of listeners.get(type) ?? []) fn(event) },
  }
}

function mockRequests(t, replies) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init })
    if (url === '/api/ampersand' && init.method === 'GET') return Response.json({ configured: true, rooms: [], model: 'test' })
    assert.ok(replies.length, `Unexpected request: ${init.method} ${url}`)
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    return reply
  })
  return calls
}

for (const failure of ['network', 502, 503]) {
  test(`opening a saved room after ${failure} offers a GET-only retry without an invite`, async t => {
    const b = browser(t)
    const calls = mockRequests(t, [
      failure === 'network' ? new TypeError('Offline') : new Response('<html>unavailable', { status: failure }),
      Response.json({ room: snapshot() }),
    ])
    const app = harness(CollabApp)
    b.onCleanup(() => app.unmount())
    app.render()
    await app.settle()
    assert.equal(component(app.tree, 'CollabEntry'), undefined, 'a read failure must not offer join/create')
    assert.ok(nodes(app.tree).some(node => node.props.role === 'alert'))
    const retry = button(app.tree, 'Try opening room again')
    assert.ok(retry)
    retry.props.onClick()
    app.render()
    assert.equal(button(app.tree, 'Try opening room again'), undefined, 'no duplicate retry while loading')
    assert.equal(component(app.tree, 'CollabEntry'), undefined)
    await app.settle()
    assert.equal(component(app.tree, 'CollabComposer').props.room.id, 'room-1')
    assert.equal(new URL(b.window.location.href).hash, '')
    assert.equal(calls.filter(call => call.url.includes('?room=')).length, 2)
    assert.ok(calls.every(call => call.method === 'GET'), 'retry must never join, invite, create or POST')
  })
}

for (const status of [401, 403, 404]) {
  test(`expected ${status} on an invite still permits the explicit join POST`, async t => {
    const b = browser(t, 'https://fx0.test/ampersand?room=room-1#invite=secret')
    const calls = mockRequests(t, [Response.json({ error: 'Join first' }, { status }), Response.json({ room: snapshot() })])
    const app = harness(CollabApp)
    b.onCleanup(() => app.unmount())
    app.render()
    await app.settle()
    const entry = component(app.tree, 'CollabEntry')
    assert.equal(entry.props.joining, true)
    assert.equal(button(app.tree, 'Try opening room again'), undefined)
    await entry.props.onSubmit({ preventDefault() {} })
    await app.settle()
    assert.equal(component(app.tree, 'CollabComposer').props.room.id, 'room-1')
    assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body)), [
      { action: 'join', id: 'room-1', invite: 'secret', name: 'Ada' },
    ])
  })
}

test('a transient invite read retries GET and retains the invite for a subsequent authorized join', async t => {
  const b = browser(t, 'https://fx0.test/ampersand?room=room-1#invite=secret')
  const calls = mockRequests(t, [new TypeError('Offline'), Response.json({ error: 'Join first' }, { status: 403 }), Response.json({ room: snapshot() })])
  const app = harness(CollabApp)
  b.onCleanup(() => app.unmount())
  app.render()
  await app.settle()
  button(app.tree, 'Try opening room again').props.onClick()
  await app.settle()
  assert.ok(calls.every(call => call.method === 'GET'))
  await component(app.tree, 'CollabEntry').props.onSubmit({ preventDefault() {} })
  await app.settle()
  assert.equal(component(app.tree, 'CollabComposer').props.room.id, 'room-1')
  assert.equal(JSON.parse(calls.find(call => call.method === 'POST').body).invite, 'secret')
})

test('a late read failure cannot replace the room selected by a newer navigation', async t => {
  const b = browser(t)
  let rejectOld
  const oldRead = new Promise((_resolve, reject) => { rejectOld = reject })
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === '/api/ampersand') return Response.json({ configured: true, rooms: [], model: 'test' })
    if (url.includes('room-1')) return oldRead
    return Response.json({ room: snapshot('room-2') })
  })
  const app = harness(CollabApp)
  b.onCleanup(() => app.unmount())
  app.render()
  b.window.location.href = 'https://fx0.test/ampersand?room=room-2'
  b.emit('popstate')
  await app.settle()
  rejectOld(new TypeError('Offline'))
  await app.settle()
  assert.equal(component(app.tree, 'CollabComposer').props.room.id, 'room-2')
  assert.equal(button(app.tree, 'Try opening room again'), undefined)
})

function preview(t) {
  const b = browser(t)
  const canvas = harness(CollabCanvas, { room: snapshot(), mobileOpen: true, onBack() {} })
  const viewElement = component(canvas.render(), 'CanvasView')
  const view = harness(viewElement.type, viewElement.props)
  const previewElement = component(view.render(), 'PublishedPreview')
  const pane = harness(previewElement.type, previewElement.props)
  pane.render()
  const frame = nodes(pane.tree).find(node => node.type === 'iframe')
  const source = {}
  frame.props.ref.current = { contentWindow: source }
  b.onCleanup(() => pane.unmount())
  return { ...b, pane, view, frame, source }
}

test('only the current iframe can request a validated HTTPS link; it never opens automatically', t => {
  const p = preview(t)
  const dialog = () => component(p.pane.render(), 'DesignLinkDialog')
  p.window.open = () => assert.fail('a message must not open a window')
  assert.equal(p.frame.props.sandbox, 'allow-scripts')
  assert.equal(dialog().props.url, null)
  const send = (data, source = p.source) => p.emit('message', { source, data, origin: 'null' })
  send({ type: 'open', url: 'https://example.com' }, {})
  assert.equal(dialog().props.url, null, 'unrelated, nested or stale frames cannot request links')
  for (const data of [null, 'open', {}, { type: 'ready', url: 'https://example.com' }, ...[
    'http://example.com', 'javascript:alert(1)', 'data:text/html,test', '/relative',
    'https://user:pass@example.com', 'https://user@example.com', 'https://example.com/' + 'a'.repeat(2048), 42,
  ].map(url => ({ type: 'open', url }))]) {
    send(data)
    assert.equal(dialog().props.url, null, JSON.stringify(data))
  }
  // Exercise the actual artifact bootstrap rather than assuming its wire format.
  const html = prepareDesignArtifactHtml('<!doctype html><html><head></head><body></body></html>', undefined, 'server-only-random-token')
  const handlers = new Map(), posted = []
  class Element { closest() { return { getAttribute: () => 'https://example.com/path?q=1' } } }
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    Element, parent: { postMessage: data => posted.push(data) },
    addEventListener: (name, fn) => handlers.set(name, fn), setInterval() {},
  })
  let prevented = false
  handlers.get('click')({ target: new Element(), preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  const request = posted.find(data => data.type === 'open')
  assert.equal(request.token, 'server-only-random-token')
  send(request)
  assert.equal(dialog().props.url, 'https://example.com/path?q=1', 'unknown server token is not a parent-side requirement')
  send({ type: 'open', url: 'https://other.test/' })
  assert.equal(dialog().props.url, 'https://example.com/path?q=1', 'messages cannot swap the confirmation target')
  dialog().props.onClose()
  send(request)
  assert.equal(dialog().props.url, null, 'closing pauses repeated requests')
  p.pane.unmount()
  assert.equal(p.listeners.get('message').size, 0)
})

test('revision changes and source view replace/unmount the preview and its pending confirmation', t => {
  const p = preview(t)
  p.emit('message', { source: p.source, data: { type: 'open', url: 'https://example.com/' } })
  assert.ok(component(p.pane.render(), 'DesignLinkDialog').props.url)
  const before = component(p.view.tree, 'PublishedPreview')
  p.view.render({ room: snapshot('room-1', 2), onBack() {} })
  const after = component(p.view.tree, 'PublishedPreview')
  assert.notEqual(after.key, before.key, 'React must remount the preview on revision changes')
  const fresh = harness(after.type, after.props)
  fresh.render()
  assert.equal(component(fresh.tree, 'DesignLinkDialog').props.url, null)
  fresh.unmount()
  button(p.view.tree, 'Source').props.onClick()
  assert.equal(component(p.view.render(), 'PublishedPreview'), undefined)
  assert.ok(component(p.view.tree, 'RevisionSource'))
})
