import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import * as React from 'react'

const root = new URL('../', import.meta.url)
const projectUrl = new URL('../package.json', import.meta.url).href
const output = realpathSync(mkdtempSync(join(tmpdir(), 'fx0-guest-ui-')))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url)), [
  '--ignoreConfig', '--outDir', output, '--strict', '--types', 'node', '--jsx', 'react-jsx',
  '--target', 'esnext', '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck',
  '--esModuleInterop', 'components/chat-app.tsx',
], { cwd: root, stdio: 'pipe' })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
const outputUrl = pathToFileURL(`${output}/`).href
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (!context.parentURL?.startsWith(outputUrl)) return nextResolve(specifier, context)
  if (specifier.startsWith('.')) return nextResolve(`${specifier.replace(/\.ts$/, "")}.js`, context)
  return nextResolve(specifier, { ...context, parentURL: projectUrl })
} })
after(() => hooks.deregister())
const { default: ChatApp } = await import(pathToFileURL(join(output, 'components/chat-app.js')).href)
const { default: Composer } = await import(pathToFileURL(join(output, 'components/composer.js')).href)
const { default: SignInDialog } = await import(pathToFileURL(join(output, 'components/sign-in-dialog.js')).href)
const { default: Transcript } = await import(pathToFileURL(join(output, 'components/transcript.js')).href)
const { default: PreviewPane } = await import(pathToFileURL(join(output, 'components/preview-pane.js')).href)
const { compactTranscript } = await import(pathToFileURL(join(output, 'lib/transcript.js')).href)
const { default: Sidebar } = await import(pathToFileURL(join(output, 'components/sidebar.js')).href)
const { default: Brand } = await import(pathToFileURL(join(output, 'components/brand.js')).href)
const { default: AccountMenu } = await import(pathToFileURL(join(output, 'components/account-menu.js')).href)
const { default: SourceLink } = await import(pathToFileURL(join(output, 'components/source-link.js')).href)
const { default: ImagePreview } = await import(pathToFileURL(join(output, 'components/image-preview.js')).href)
const { default: HowItWorks, REPO_URL } = await import(pathToFileURL(join(output, 'components/how-it-works.js')).href)
const { AUTH_REQUIRED_EVENT } = await import(pathToFileURL(join(output, 'components/auth-ui.js')).href)
const { saveGuestDraft, GUEST_DRAFT_KEY } = await import(pathToFileURL(join(output, 'components/guest-draft.js')).href)

// Drive the compiled components' actual hooks and handlers without introducing a
// DOM dependency. This is not browser/focus-trap coverage; Radix owns that behavior.
function renderHooks(Component) {
  const slots = []
  let index = 0
  let effects = []
  const cleanups = []
  const dispatcher = {
    useState(initial) {
      const slot = index++
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
      return [slots[slot], (value) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    },
    useRef(initial) { const slot = index++; return slots[slot] ??= { current: initial } },
    useCallback(callback) { index++; return callback },
    useMemo(factory) { index++; return factory() },
    useId() { return `test-${index++}` },
    useImperativeHandle(ref, create) { index++; if (ref) ref.current = create() },
    useEffect(callback, deps) {
      const slot = index++
      if (!slots[slot] || deps.some((value, i) => !Object.is(value, slots[slot][i]))) {
        slots[slot] = deps
        effects.push(() => { cleanups[slot]?.(); cleanups[slot] = callback() })
      }
    },    useLayoutEffect(callback, deps) { return dispatcher.useEffect(callback, deps) },
  }
  return {
    render(props) {
      index = 0
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
      const previous = internals.H
      internals.H = dispatcher
      try { return Component(props) } finally { internals.H = previous }
    },
    flush() { const pending = effects; effects = []; for (const effect of pending) effect() },
    cleanup() { for (const cleanup of cleanups) cleanup?.() },
  }
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  if (node.type === Transcript) return find(renderHooks(Transcript.type).render(node.props), predicate)
  // A streamed region's Suspense fallback renders ChatApp's live state.
  for (const child of React.Children.toArray([node.props?.fallback, node.props?.children])) {
    const result = find(child, predicate)
    if (result) return result
  }
  return null
}
// The request data the page streams in; a guest's never names a private chat.
const guestBoot = { user: null, team: null, sessionId: 'external-private-id', sessions: [], events: [], view: { artifactRevision: 0 }, now: 1, missing: false }
const image = { data: 'aGVsbG8=', mimeType: 'image/png', preview: 'data:image/png;base64,aGVsbG8=' }
const draft = { text: 'Keep my draft', images: [image] }
const tick = () => new Promise((resolve) => setImmediate(resolve))

function browser(t, routes = {}) {
  const values = new Map()
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
  const events = new EventTarget()
  const timers = []
  t.mock.method(globalThis, 'setInterval', () => 1)
  t.mock.method(globalThis, 'clearInterval', () => {})
  t.mock.method(globalThis, 'setTimeout', (callback) => { timers.push(callback); return 1 })
  t.mock.method(globalThis, 'clearTimeout', () => {})
  const cleanups = []
  const previous = { window: globalThis.window, document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame }
  globalThis.window = {
    innerWidth: 1280, sessionStorage: storage, location: { href: 'http://localhost/', search: '', protocol: 'http:' },
    history: { replaceState() {}, pushState() {} },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  }
  const cookies = new Map()
  globalThis.document = { get cookie() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') }, set cookie(raw) { const [key, value] = raw.split(';')[0].split('='); cookies.set(key, value) }, title: '', visibilityState: 'visible', documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, addEventListener() {}, removeEventListener() {}, querySelector: () => null }
  globalThis.requestAnimationFrame = () => 1
  t.after(() => {
    for (const cleanup of cleanups) cleanup()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init })
    if (url === '/api/models') {
      return Response.json({
        models: ['a-model', 'default-model', 'default-model-fast', 'z-model'], defaultModel: 'default-model',
        efforts: { 'default-model': ['high'] }, fast: ['default-model', 'default-model-fast'], featured: ['z-model'],
      })
    }
    if (routes[url]) return routes[url](init)
    assert.fail(`Unexpected private request: ${url}`)
  })
  return { storage, requests, timers, cleanups }
}

function mount(t, ui, data = guestBoot, { booted = true } = {}) {
  const chat = renderHooks(ChatApp)
  const composer = renderHooks(Composer)
  const account = { user: data.user, team: data.team, freePrompts: data.freePrompts }
  const sidebar = { sessions: data.sessions, nextCursor: null }
  const bootData = { sessionId: data.user ? data.sessionId : 'draft', snapshot: { transcript: compactTranscript(data.events, data.view), summary: data.sessions.find((session) => session.id === data.sessionId) ?? null }, now: data.now, missing: data.missing }
  const initial = { account: Promise.resolve(account), sidebar: Promise.resolve(sidebar), boot: Promise.resolve(bootData), defaultModel: data.defaultModel ?? 'default-model' }
  let tree = chat.render(initial)
  // React hands the streamed data to ChatApp through BootLoader's onBoot.
  const adopt = (promise, value) => find(tree, (node) => node.props?.boot === promise && typeof node.props?.onBoot === 'function').props.onBoot(value)
  const boot = () => { adopt(initial.account, account); adopt(initial.sidebar, sidebar); adopt(initial.boot, bootData) }
  if (booted) boot()
  tree = chat.render(initial)
  const composerProps = () => find(tree, (node) => node.type === Composer).props
  let composerTree = composer.render(composerProps())
  composer.flush()
  chat.flush()
  ui.cleanups.push(() => { composer.cleanup(); chat.cleanup() })
  return {
    chat, composer,
    account() { adopt(initial.account, account); tree = chat.render(initial); composerTree = composer.render(composerProps()); chat.flush() },
    boot() { boot(); tree = chat.render(initial); composerTree = composer.render(composerProps()); chat.flush() },
    render() { tree = chat.render(initial); composerTree = composer.render(composerProps()); return tree },
    dialog() { return find(tree, (node) => node.type === SignInDialog).props },
    handle() { return composerProps().ref.current },
    send() { find(composerTree, (node) => node.props?.['aria-label'] === 'Send message').props.onClick({ detail: 0 }) },
    tree: () => tree,
    composerTree: () => composerTree,
  }
}

const trialUser = { id: 'guest:new', name: 'You', email: null, picture: null, guest: true }
const trialModel = 'anthropic/claude-opus-5.5-fast'

test('a trial guest sends without sign-in or draft reservation and updates the remaining allowance', async (t) => {
  t.mock.method(console, 'info', () => {})
  const ui = browser(t, {
    '/api/prompt?session=new': () => new Response('', { headers: { 'content-type': 'text/event-stream', 'x-fx0-session': 'trial-chat', 'x-fx0-free-prompts': '4' } }),
  })
  document.cookie = 'fx0-model=z-model'
  document.cookie = 'fx0-effort=high'
  document.cookie = 'fx0-fast=0'
  const app = mount(t, ui, { ...guestBoot, user: trialUser, sessionId: 'draft', freePrompts: 5 })
  await tick()
  app.render()
  const composer = find(app.tree(), (node) => node.type === Composer)
  composer.props.onDraftInput('Make a design')
  assert.equal(find(app.tree(), (node) => node.type === Sidebar).props.user, null, 'a trial identity is not an OAuth account')
  assert.equal(find(app.composerTree(), (node) => /^Model: claude-opus-5\.5/.test(node.props?.['aria-label'] ?? '')).props.disabled, true)
  assert.equal(find(app.composerTree(), (node) => node.props?.['aria-label'] === 'reasoning effort: high'), null)
  assert.deepEqual(app.handle().getGeneration(), { model: trialModel, effort: 'low', fast: true, defaultModel: 'default-model' })
  app.handle().restoreDraft(draft)
  app.render()
  app.send()
  await tick()
  app.render()
  assert.equal(app.dialog().open, false)
  assert.equal(find(app.tree(), (node) => node.type === Transcript).props.sessionId, 'trial-chat')
  const prompts = ui.requests.filter(({ url }) => url.startsWith('/api/prompt'))
  assert.equal(prompts.length, 1)
  assert.deepEqual(JSON.parse(prompts[0].init.body).generation, { model: trialModel, effort: 'low', fast: true })
  assert.equal(ui.requests.some(({ url, init }) => url.startsWith('/api/warm') || (url === '/api/sessions' && init?.method === 'POST')), false)
  assert.ok(find(app.composerTree(), (node) => node.props?.role === 'status' && [].concat(node.props.children)[0] === '4 free prompts left'))
})

for (const staleAllowance of [false, true]) {
  test(`an exhausted trial ${staleAllowance ? 'rejected by the server' : 'known before sending'} preserves the draft, transcript and preview`, async (t) => {
    t.mock.method(console, 'info', () => {})
    const ui = browser(t, {
      '/api/events?session=trial-chat&after=2': () => new Response(''),
      '/api/prompt?session=trial-chat': () => Response.json({ code: 'trial_exhausted', error: 'Your five free prompts are used. Sign in to continue.' }, { status: 402 }),
    })
    const app = mount(t, ui, {
      ...guestBoot, user: trialUser, sessionId: 'trial-chat', freePrompts: staleAllowance ? 1 : 0,
      events: [{ type: 'user', seq: 1, id: 1, text: 'Earlier prompt' }, { type: 'text', seq: 2, id: 1, delta: 'Earlier answer' }],
      view: { artifactRevision: 2 },
    })
    app.handle().restoreDraft(draft)
    app.render()
    app.send()
    await tick()
    app.render()
    assert.equal(app.dialog().open, true)
    assert.deepEqual(app.handle().getDraft(), { ...draft, designMd: null })
    const transcript = find(app.tree(), (node) => node.type === Transcript).props
    assert.ok(transcript.entries.some((entry) => entry.text === 'Earlier prompt'))
    assert.ok(transcript.entries.some((entry) => entry.text === 'Earlier answer'))
    assert.equal(transcript.entries.some((entry) => entry.text === draft.text), false, 'the rejected prompt is not part of the chat')
    assert.deepEqual(find(app.tree(), (node) => node.type === PreviewPane).props.source, { kind: 'design', sessionId: 'trial-chat', revision: 2 })
    assert.equal(ui.requests.filter(({ url }) => url.startsWith('/api/prompt')).length, staleAllowance ? 1 : 0)
    assert.equal(app.dialog().onSignIn(), true)
    assert.equal(JSON.parse(ui.storage.getItem(GUEST_DRAFT_KEY)).submit, true)
    app.dialog().onOpenChange(false)
    app.render()
    assert.deepEqual(app.handle().getDraft(), { ...draft, designMd: null })
  })
}

test('an exhausted trial says so briefly and its Sign in opens the dialog', async (t) => {
  const ui = browser(t)
  const app = mount(t, ui, { ...guestBoot, user: trialUser, sessionId: 'draft', freePrompts: 0 })
  await tick()
  app.render()
  const notice = find(app.composerTree(), (node) => node.props?.role === 'status' && [].concat(node.props.children)[0] === 'Free prompts are used.')
  assert.ok(notice)
  const signIn = find(app.composerTree(), (node) => node.type === 'button' && node.props.children === 'Sign in')
  signIn.props.onClick({ detail: 0 })
  app.render()
  assert.equal(app.dialog().open, true)
})

test('stop says when there was no reply to stop, rather than claiming a stop was requested', async (t) => {
  t.mock.method(console, 'info', () => {})
  let answer = { cancelled: false }
  const ui = browser(t, {
    '/api/events?session=trial-chat&after=2': () => new Response(''),
    '/api/cancel?session=trial-chat': () => Response.json(answer),
  })
  const app = mount(t, ui, {
    ...guestBoot, user: trialUser, sessionId: 'trial-chat', freePrompts: 4,
    events: [{ type: 'user', seq: 1, id: 1, text: 'Earlier prompt' }, { type: 'text', seq: 2, id: 1, delta: 'Earlier answer' }],
  })
  const announced = async () => {
    find(app.tree(), (node) => node.type === Composer).props.onStop()
    await tick()
    app.render()
    return find(app.tree(), (node) => node.props?.role === 'status' && node.props['aria-live'] === 'polite').props.children
  }
  assert.equal(await announced(), 'There\'s no reply to stop.')
  answer = { cancelled: true }
  assert.equal(await announced(), 'Stop requested.')
  assert.equal(ui.requests.filter(({ url, init }) => url === '/api/cancel?session=trial-chat' && init?.method === 'POST').length, 2)
})

test('signed-in non-trial model settings explain team billing rather than claiming a free prompt', async (t) => {
  const ui = browser(t)
  const app = mount(t, ui, { ...guestBoot, user: { id: 'user-1', name: 'User', email: null, picture: null }, sessionId: 'draft', freePrompts: 5 })
  await tick()
  app.render()
  assert.ok(find(app.composerTree(), (node) => node.props?.role === 'status' && /Uses your billing team/.test([].concat(node.props.children)[0])))
  assert.equal(find(app.composerTree(), (node) => node.props?.role === 'status' && /prompts? left/.test([].concat(node.props.children)[0])), null)
})

test('a signed-in user with no free prompts left sees no billing notice', async (t) => {
  const ui = browser(t)
  const app = mount(t, ui, { ...guestBoot, user: { id: 'user-1', name: 'User', email: null, picture: null }, sessionId: 'draft', freePrompts: 0 })
  await tick()
  app.render()
  assert.equal(find(app.composerTree(), (node) => node.props?.role === 'status' && /Uses your billing team|prompts? left/.test([].concat(node.props.children)[0])), null)
})

test('an existing paid chat cannot claim free prompts; switching chats and new drafts keep the global allowance', async (t) => {
  const summary = (id, trial = false) => ({ id, title: id, createdAt: 1, lastActivity: 1, busy: false, ...(trial ? { trialChat: true } : {}) })
  const ui = browser(t, {
    '/api/events?session=paid-chat&after=1': () => new Response(''),
    '/api/events?session=trial-chat&after=1': () => new Response(''),
    '/api/model?session=paid-chat': () => Response.json({ model: trialModel, effort: 'low', fast: true }),
    '/api/model?session=trial-chat': () => Response.json({ model: trialModel, effort: 'low', fast: true }),
    '/api/session?session=trial-chat': () => Response.json({ transcript: compactTranscript([{ type: 'user', seq: 1, id: 1, text: 'Trial design' }], guestBoot.view), summary: summary('trial-chat', true) }),
  })
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'user-1', name: 'User', email: null, picture: null }, defaultModel: trialModel,
    sessionId: 'paid-chat', freePrompts: 5, sessions: [summary('paid-chat'), summary('trial-chat', true)],
    events: [{ type: 'user', seq: 1, id: 1, text: 'Paid design' }],
  })
  await tick()
  app.render()
  const freeNotice = () => find(app.composerTree(), (node) => node.props?.role === 'status' && /prompts? left/.test([].concat(node.props.children)[0]))
  const rail = () => find(app.tree(), (node) => node.type === Sidebar).props
  assert.equal(freeNotice(), null, 'an exact model match does not make a paid chat eligible')
  assert.ok(find(app.composerTree(), (node) => node.props?.role === 'status' && /Uses your billing team/.test([].concat(node.props.children)[0])))
  rail().onSelect('trial-chat')
  await tick()
  app.render()
  assert.ok(freeNotice(), 'an uncached trial chat is eligible')
  rail().onSelect('paid-chat')
  await tick()
  app.render()
  assert.equal(freeNotice(), null, 'the cached paid chat stays paid')
  rail().onNew()
  app.render()
  assert.ok(freeNotice(), 'a new design retains the global allowance')
  rail().onSelect('trial-chat')
  await tick()
  app.render()
  assert.ok(freeNotice(), 'the cached trial chat retains its eligibility')
  assert.equal(ui.requests.filter(({ url }) => url === '/api/session?session=trial-chat').length, 1)
})

test('opening an uncached chat moves to its URL and an empty chat at once; a later click wins; a failed load returns to a new chat', async (t) => {
  const summary = (id) => ({ id, title: id, createdAt: 1, lastActivity: 1, busy: false })
  const snapshot = (id) => Response.json({ transcript: compactTranscript([{ type: 'user', seq: 1, id: 1, text: `Design ${id}` }], guestBoot.view), summary: summary(id) })
  let releaseSlow
  const slow = new Promise((resolve) => { releaseSlow = resolve })
  const ui = browser(t, {
    '/api/events?session=one&after=1': () => new Response(''),
    '/api/events?session=fast&after=1': () => new Response(''),
    '/api/model?session=one': () => Response.json({ model: '', effort: '', fast: false }),
    '/api/model?session=fast': () => Response.json({ model: '', effort: '', fast: false }),
    '/api/session?session=slow': () => slow.then(() => snapshot('slow')),
    '/api/session?session=fast': () => snapshot('fast'),
    '/api/session?session=broken': () => new Response('unavailable', { status: 503 }),
  })
  const pushes = []
  const replaces = []
  window.history.pushState = (_state, _title, url) => { pushes.push(String(url)); window.location.search = new URL(String(url)).search }
  window.history.replaceState = (_state, _title, url) => { replaces.push(String(url)); window.location.search = new URL(String(url)).search }
  const classes = new Set()
  document.documentElement.classList = { add: (name) => classes.add(name), remove: (name) => classes.delete(name), toggle() {}, contains: (name) => classes.has(name) }
  t.mock.method(console, 'error', () => {})
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'user-1', name: 'User', email: null, picture: null },
    sessionId: 'one', sessions: [summary('one'), { ...summary('slow'), artifactRevision: 3 }, summary('fast'), summary('broken')],
    events: [{ type: 'user', seq: 1, id: 1, text: 'Design one' }],
  })
  await tick()
  app.render()
  const rail = () => find(app.tree(), (node) => node.type === Sidebar).props
  const entries = () => find(app.tree(), (node) => node.type === Transcript).props.entries

  // The click moves at once: URL, highlighted item and the empty chat, before any response.
  rail().onSelect('slow')
  assert.match(pushes.at(-1), /[?&]s=slow\b/, 'the URL names the chat in the click itself')
  assert.ok(classes.has('chat-url'), 'the empty chat shows its loading skeleton')
  app.render()
  assert.equal(rail().activeId, 'slow', 'the clicked chat is highlighted at once')
  assert.deepEqual(entries(), [], 'the previous chat is no longer shown')
  const preview = () => find(app.tree(), (node) => node.type === PreviewPane)?.props
  assert.deepEqual(preview()?.source, { kind: 'design', sessionId: 'slow', revision: 3 },
    'the preview starts loading the listed design before the transcript arrives')

  // Typing while it opens does not reserve a new draft chat.
  find(app.tree(), (node) => node.type === Composer).props.onDraftInput('typed while loading')
  await tick()
  assert.equal(ui.requests.filter(({ url }) => url === '/api/sessions').length, 0, 'no draft reservation while a chat opens')

  // A later click wins; the slow response that lands afterwards is dropped.
  rail().onSelect('fast')
  await tick()
  app.render()
  assert.equal(entries()[0]?.text, 'Design fast')
  releaseSlow()
  await tick()
  await tick()
  app.render()
  assert.equal(entries()[0]?.text, 'Design fast', 'the earlier load does not replace the chat clicked later')
  assert.equal(rail().activeId, 'fast')
  assert.equal(preview()?.source.sessionId, 'fast', 'the dropped chat\'s early preview is gone')
  assert.ok(!classes.has('chat-url'))

  // A failed load returns to a new chat with the usual notice, not an endless skeleton.
  rail().onSelect('broken')
  await tick()
  await tick()
  app.render()
  assert.ok(!classes.has('chat-url'), 'no skeleton is left behind')
  assert.doesNotMatch(replaces.at(-1), /[?&]s=/, 'the URL no longer names the chat that failed')
  assert.equal(rail().activeId, 'draft')
  assert.ok(find(app.tree(), (node) => node.props?.role === 'alert' && node.props.children === 'Unable to load that session. Try again.'))
})

test('New design while a chat opens wins over the late snapshot', async (t) => {
  const summary = (id) => ({ id, title: id, createdAt: 1, lastActivity: 1, busy: false })
  let releaseSlow
  const slow = new Promise((resolve) => { releaseSlow = resolve })
  const ui = browser(t, {
    '/api/events?session=one&after=1': () => new Response(''),
    '/api/model?session=one': () => Response.json({ model: '', effort: '', fast: false }),
    '/api/session?session=slow': () => slow.then(() => Response.json({ transcript: compactTranscript([{ type: 'user', seq: 1, id: 1, text: 'Design slow' }], guestBoot.view), summary: summary('slow') })),
  })
  window.history.pushState = (_state, _title, url) => { window.location.search = new URL(String(url)).search }
  window.history.replaceState = (_state, _title, url) => { window.location.search = new URL(String(url)).search }
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'user-1', name: 'User', email: null, picture: null },
    sessionId: 'one', sessions: [summary('one'), summary('slow')],
    events: [{ type: 'user', seq: 1, id: 1, text: 'Design one' }],
  })
  await tick()
  app.render()
  const rail = () => find(app.tree(), (node) => node.type === Sidebar).props
  const entries = () => find(app.tree(), (node) => node.type === Transcript).props.entries
  rail().onSelect('slow')
  app.render()
  rail().onNew()
  app.render()
  releaseSlow()
  await tick()
  await tick()
  app.render()
  assert.deepEqual(entries(), [], 'the late snapshot does not replace the new design')
  assert.equal(rail().activeId, 'draft')
  assert.doesNotMatch(window.location.search, /[?&]s=/, 'the URL stays on the new design')
})

test('Back to the new-chat page while a chat opens wins over the late snapshot', async (t) => {
  const summary = (id) => ({ id, title: id, createdAt: 1, lastActivity: 1, busy: false })
  let releaseSlow
  const slow = new Promise((resolve) => { releaseSlow = resolve })
  const ui = browser(t, {
    '/api/session?session=slow': () => slow.then(() => Response.json({ transcript: compactTranscript([{ type: 'user', seq: 1, id: 1, text: 'Design slow' }], guestBoot.view), summary: summary('slow') })),
  })
  const app = mount(t, ui, { ...guestBoot, user: { id: 'user-1', name: 'User', email: null, picture: null }, sessionId: 'draft', sessions: [summary('slow')] })
  await tick()
  app.render()
  const rail = () => find(app.tree(), (node) => node.type === Sidebar).props
  const entries = () => find(app.tree(), (node) => node.type === Transcript).props.entries
  rail().onSelect('slow')
  app.render()
  assert.equal(rail().activeId, 'slow')
  navigate('')
  app.render()
  releaseSlow()
  await tick()
  await tick()
  app.render()
  assert.deepEqual(entries(), [], 'the late snapshot does not replace the new chat')
  assert.equal(rail().activeId, 'draft')
})

for (const hasOtherChat of [true, false]) {
  test(`deleting a chat while it opens drops its late snapshot (${hasOtherChat ? 'another chat remains' : 'last chat'})`, async (t) => {
    const summary = (id) => ({ id, title: id, createdAt: 1, lastActivity: 1, busy: false })
    let releaseSlow
    const slow = new Promise((resolve) => { releaseSlow = resolve })
    let reads = 0
    const ui = browser(t, {
      '/api/events?session=one&after=1': () => new Response(''),
      '/api/events?session=slow&after=1': () => new Response(''),
      '/api/model?session=one': () => Response.json({ model: '', effort: '', fast: false }),
      '/api/model?session=slow': () => Response.json({ model: '', effort: '', fast: false }),
      '/api/session?session=slow': (init) => {
        if (init?.method === 'DELETE') return new Response('')
        reads++
        if (reads > 1) return new Response('Not found', { status: 404 })
        return slow.then(() => Response.json({
          transcript: compactTranscript([{ type: 'user', seq: 1, id: 1, text: 'Deleted chat content' }], guestBoot.view),
          summary: summary('slow'),
        }))
      },
    })
    t.mock.method(console, 'error', () => {})
    const app = mount(t, ui, {
      ...guestBoot, user: { id: 'user-1', name: 'User', email: null, picture: null },
      sessionId: hasOtherChat ? 'one' : 'draft',
      sessions: hasOtherChat ? [summary('one'), summary('slow')] : [summary('slow')],
      events: hasOtherChat ? [{ type: 'user', seq: 1, id: 1, text: 'Design one' }] : [],
    })
    await tick()
    app.render()
    const rail = () => find(app.tree(), (node) => node.type === Sidebar).props
    rail().onSelect('slow')
    app.render()
    rail().onDelete('slow')
    await tick()
    app.render()
    assert.ok(ui.requests.some(({ url, init }) => url === '/api/session?session=slow' && init?.method === 'DELETE'))
    assert.ok(!rail().sessions.some((session) => session.id === 'slow'))
    releaseSlow()
    await tick()
    await tick()
    app.render()
    assert.equal(rail().activeId, hasOtherChat ? 'one' : 'draft', 'the late snapshot cannot reopen the deleted chat')
    assert.equal(rail().loadingId, null)
    assert.notEqual(find(app.tree(), (node) => node.type === PreviewPane)?.props.source.sessionId, 'slow')

    // Back/Forward to the deleted chat must ask the server, not reuse its late snapshot.
    navigate('?s=slow')
    await tick()
    await tick()
    app.render()
    assert.equal(reads, 2, 'the deleted chat was not put back in the cache')
    assert.equal(rail().activeId, 'draft')
  })
}

test('once idle, the three most recent other chats load in the background and then open from the cache', async (t) => {
  const summary = (id, at) => ({ id, title: id, createdAt: 1, lastActivity: at, busy: false })
  const snapshot = (id) => Response.json({ transcript: compactTranscript([{ type: 'user', seq: 1, id: 1, text: `Design ${id}` }], guestBoot.view), summary: summary(id, 1) })
  const ui = browser(t, {
    '/api/events?session=one&after=1': () => new Response(''),
    '/api/events?session=a&after=1': () => new Response(''),
    '/api/model?session=one': () => Response.json({ model: '', effort: '', fast: false }),
    '/api/model?session=a': () => Response.json({ model: '', effort: '', fast: false }),
    '/api/session?session=a': () => snapshot('a'),
    '/api/session?session=b': () => snapshot('b'),
    '/api/session?session=c': () => snapshot('c'),
  })
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'user-1', name: 'User', email: null, picture: null },
    sessionId: 'one', sessions: [summary('one', 9), summary('a', 8), summary('b', 7), summary('c', 6), summary('d', 5)],
    events: [{ type: 'user', seq: 1, id: 1, text: 'Design one' }],
  })
  await tick()
  app.render()
  const sessionRequests = () => ui.requests.filter(({ url }) => url.startsWith('/api/session?')).map(({ url }) => url)
  assert.deepEqual(sessionRequests(), [], 'nothing loads before the app is idle')
  for (const run of ui.timers.splice(0)) run()
  await tick()
  assert.deepEqual(sessionRequests().sort(), ['/api/session?session=a', '/api/session?session=b', '/api/session?session=c'],
    'the open chat and older chats are not loaded')
  app.render()
  for (const run of ui.timers.splice(0)) run()
  await tick()
  assert.equal(sessionRequests().length, 3, 'once per page')

  const rail = () => find(app.tree(), (node) => node.type === Sidebar).props
  rail().onSelect('a')
  await tick()
  app.render()
  assert.equal(find(app.tree(), (node) => node.type === Transcript).props.entries[0]?.text, 'Design a')
  assert.equal(sessionRequests().filter((url) => url.endsWith('=a')).length, 1, 'opening it uses the background load')
})

test('the first prompt response retains trial eligibility when a signed-in draft becomes a cached chat', async (t) => {
  t.mock.method(console, 'info', () => {})
  const ui = browser(t, {
    '/api/prompt?session=new': () => new Response('', { headers: { 'content-type': 'text/event-stream', 'x-fx0-session': 'admitted-trial', 'x-fx0-free-prompts': '4', 'x-fx0-trial-chat': '1' } }),
    '/api/events?session=admitted-trial&after=0': () => new Response(''),
  })
  document.cookie = `fx0-model=${trialModel}`
  const app = mount(t, ui, { ...guestBoot, user: { id: 'user-1', name: 'User', email: null, picture: null }, sessionId: 'draft', defaultModel: trialModel, freePrompts: 5 })
  app.handle().restoreDraft({ text: 'Start a trial design', images: [] })
  app.render()
  app.send()
  await tick()
  app.render()
  const freeNotice = () => find(app.composerTree(), (node) => node.props?.role === 'status' && [].concat(node.props.children)[0] === '4 free prompts left')
  assert.equal(find(app.tree(), (node) => node.type === Transcript).props.sessionId, 'admitted-trial')
  assert.ok(freeNotice(), 'the promoted chat must use the server admission header')
  const rail = () => find(app.tree(), (node) => node.type === Sidebar).props
  rail().onNew()
  app.render()
  rail().onSelect('admitted-trial')
  await tick()
  app.render()
  assert.ok(freeNotice(), 'cache restoration must retain the first admission marker')
  assert.equal(ui.requests.some(({ url }) => url === '/api/session?session=admitted-trial'), false)
})

// The browser pressing Back or Forward to `search`.
function navigate(search) {
  window.location.href = `http://localhost/${search}`
  window.location.search = search
  window.dispatchEvent(new Event('popstate'))
}

test('Back from a chat to the new-chat page shows a new chat, keeps what was typed, and its next prompt starts a new chat', async (t) => {
  t.mock.method(console, 'info', () => {})
  const ui = browser(t, {
    '/api/events?session=chat-a&after=1': () => new Response(''),
    '/api/prompt?session=new': () => new Response('', { headers: { 'content-type': 'text/event-stream', 'x-fx0-session': 'chat-b' } }),
    '/api/events?session=chat-b&after=0': () => new Response(''),
  })
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'user-1', name: 'User', email: null, picture: null }, sessionId: 'chat-a',
    sessions: [{ id: 'chat-a', title: 'chat-a', createdAt: 1, lastActivity: 1, busy: false }],
    events: [{ type: 'user', seq: 1, id: 1, text: 'Earlier design' }],
  })
  await tick()
  app.render()
  app.handle().restoreDraft(draft)
  navigate('')
  await tick()
  app.render()
  assert.equal(find(app.tree(), (node) => node.type === Transcript).props.sessionId, 'draft')
  assert.deepEqual(app.handle().getDraft(), { ...draft, designMd: null }, 'Back keeps what was typed')
  app.send()
  await tick()
  app.render()
  assert.deepEqual(ui.requests.filter(({ url }) => url.startsWith('/api/prompt')).map(({ url }) => url), ['/api/prompt?session=new'])
  assert.equal(ui.requests.some(({ url }) => url.startsWith('/api/session?')), false, 'Back loads no chat')
})

test('Back to a link whose chat ID is invalid shows a new chat with the first paint\'s notice', async (t) => {
  t.mock.method(console, 'info', () => {})
  const ui = browser(t, { '/api/events?session=chat-a&after=1': () => new Response('') })
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'user-1', name: 'User', email: null, picture: null }, sessionId: 'chat-a',
    events: [{ type: 'user', seq: 1, id: 1, text: 'Earlier design' }],
  })
  await tick()
  app.render()
  navigate('?s=Not-A-Chat')
  await tick()
  app.render()
  assert.equal(find(app.tree(), (node) => node.type === Transcript).props.sessionId, 'draft')
  assert.equal(find(app.tree(), (node) => node.props?.role === 'status' && node.props['aria-live'] === 'polite').props.children, 'That chat does not exist or is not yours.')
  assert.equal(ui.requests.some(({ url }) => url.startsWith('/api/session?')), false)
})

test('account bootstrap clears a stale signed-in hint after the account is known', (t) => {
  const ui = browser(t)
  document.cookie = 'fx0-signed-in=1'
  const app = mount(t, ui, guestBoot, { booted: false })
  assert.match(document.cookie, /fx0-signed-in=1/, 'unknown account keeps the existing first-paint hint')
  app.account()
  assert.doesNotMatch(document.cookie, /fx0-signed-in=1/)
  assert.ok(ui.requests.every(({ url }) => url === '/api/models'))
})

test('account bootstrap restores a missing signed-in hint without private requests', (t) => {
  const ui = browser(t)
  mount(t, ui, { ...guestBoot, user: { id: 'owner', name: 'Owner' }, sessionId: 'draft' })
  assert.match(document.cookie, /fx0-signed-in=1/)
  assert.ok(ui.requests.every(({ url }) => url === '/api/models'))
})

test('guest mount/focus performs no private fetch; prompt gate opens modal and cancel keeps text and images', async (t) => {
  const ui = browser(t)
  const app = mount(t, ui)
  await tick()
  for (const callback of ui.timers) callback()
  window.dispatchEvent(new Event('focus'))
  await tick()
  assert.ok(ui.requests.every(({ url }) => url === '/api/models'))
  app.handle().restoreDraft(draft)
  app.render()
  assert.equal(app.dialog().open, false)
  app.send()
  app.render()
  assert.equal(app.dialog().open, true)
  assert.deepEqual(app.handle().getDraft(), { ...draft, designMd: null })
  assert.ok(ui.requests.every(({ url }) => url === '/api/models'))
  app.dialog().onOpenChange(false)
  app.render()
  assert.equal(app.dialog().open, false)
  assert.deepEqual(app.handle().getDraft(), { ...draft, designMd: null })
  assert.equal(ui.storage.getItem(GUEST_DRAFT_KEY), null)
  assert.equal(app.dialog().onSignIn(), true, 'Valid draft should allow OAuth')
  assert.equal(JSON.parse(ui.storage.getItem(GUEST_DRAFT_KEY)).text, draft.text)
  // The modal opened from a send, so the draft goes out after sign-in.
  assert.equal(JSON.parse(ui.storage.getItem(GUEST_DRAFT_KEY)).submit, true)
})

test('guest new chat is local only, and suggestions invoke the same sign-in gate', (t) => {
  const ui = browser(t)
  const app = mount(t, ui)
  app.handle().restoreDraft(draft)
  app.render()
  const composer = find(app.tree(), (node) => node.type === Composer)
  composer.props.onNewSession()
  app.render()
  assert.deepEqual(app.handle().getDraft(), { text: '', images: [], designMd: null })
  assert.equal(app.dialog().open, false)
  const suggestion = find(app.tree(), (node) => node.type === 'button' && node.props.children?.[0]?.props?.children === 'Design a landing page for a CLI coding agent')
  assert.ok(suggestion)
  suggestion.props.onClick({ detail: 0 })
  app.render()
  assert.equal(app.dialog().open, true)
  assert.equal(app.handle().getDraft().text, 'Design a landing page for a CLI coding agent')
  assert.ok(ui.requests.every(({ url }) => url === '/api/models'))
})

test('authenticated login restores composer once without autosending or reserving a draft session', async (t) => {
  const ui = browser(t)
  saveGuestDraft(ui.storage, draft)
  const app = mount(t, ui, { ...guestBoot, sessionId: 'draft', user: { id: 'user-1', name: 'User', email: null, picture: null } })
  app.render()
  assert.deepEqual(app.handle().getDraft(), { ...draft, designMd: null })
  assert.equal(ui.storage.getItem(GUEST_DRAFT_KEY), null)
  app.chat.flush()
  await tick()
  assert.ok(ui.requests.every(({ url }) => url === '/api/models'))
  assert.equal(app.dialog().open, false)
})

test('a prompt sent before the account is known waits for it instead of gating sign-in', (t) => {
  const ui = browser(t)
  const app = mount(t, ui, guestBoot, { booted: false })
  // The static shell shows no account control rather than a sign-in button.
  assert.equal(find(app.tree(), (node) => node.type === Sidebar)?.props.user, undefined)
  app.handle().restoreDraft(draft)
  app.render()
  app.send()
  app.render()
  assert.equal(app.dialog().open, false)
  assert.deepEqual(app.handle().getDraft(), { ...draft, designMd: null })
  // Edits made while waiting go with the prompt rather than being cleared.
  const edited = { text: 'Keep my draft, and this too', images: [image, image] }
  app.handle().clearDraft()
  app.render()
  app.handle().restoreDraft(edited)
  app.render()
  app.boot()
  app.render()
  assert.equal(app.dialog().open, true)
  assert.deepEqual(app.handle().getDraft(), { ...edited, designMd: null })
  assert.ok(ui.requests.every(({ url }) => url === '/api/models'))
})

test('knowing the account alone never releases a send before the requested chat is ready', (t) => {
  const ui = browser(t)
  const app = mount(t, ui, guestBoot, { booted: false })
  app.handle().restoreDraft(draft)
  app.render()
  app.send()
  app.account()
  app.render()
  assert.equal(app.dialog().open, false)
  assert.deepEqual(app.handle().getDraft(), { ...draft, designMd: null })
  app.boot()
  app.render()
  assert.equal(app.dialog().open, true)
})

test('a send released by chat boot targets the requested chat rather than reserving a draft', async (t) => {
  t.mock.method(console, 'info', () => {})
  const emptyStream = () => new Response(new ReadableStream({ start(controller) { controller.close() } }))
  const ui = browser(t, { '/api/events?session=saved&after=0': emptyStream, '/api/prompt?session=saved': emptyStream })
  const app = mount(t, ui, { ...guestBoot, user: { id: 'owner', name: 'Owner' }, sessionId: 'saved' }, { booted: false })
  app.handle().restoreDraft({ text: 'Continue here', images: [] })
  app.render()
  app.send()
  app.account()
  await tick()
  assert.ok(ui.requests.every(({ url }) => url === '/api/models'))
  app.boot()
  await tick()
  assert.ok(ui.requests.some(({ url }) => url === '/api/prompt?session=saved'))
  assert.ok(!ui.requests.some(({ url }) => url === '/api/sessions' || url.includes('session=new')))
})

test('a prompt says sending until the server accepts it, then thinking while its turn starts', async (t) => {
  t.mock.method(console, 'info', () => {})
  let respond
  const accepted = new Promise((resolve) => { respond = resolve })
  let events
  const body = new ReadableStream({ start(controller) { events = controller } })
  const push = (item) => events.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(item)}\n\n`))
  const emptyStream = () => new Response(new ReadableStream({ start(controller) { controller.close() } }))
  const ui = browser(t, { '/api/events?session=saved&after=0': emptyStream, '/api/prompt?session=saved': () => accepted })
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'owner', name: 'Owner' }, sessionId: 'saved',
    sessions: [{ id: 'saved', title: 'Saved', createdAt: 1, lastActivity: 1, busy: false }],
  })
  await tick()
  app.render()
  const activity = () => find(app.render(), (node) => node.type?.name === 'ActivityLine')?.props.label ?? null
  const stoppable = () => find(app.tree(), (node) => node.type === Composer).props.busy
  app.handle().restoreDraft({ text: 'Make it blue', images: [] })
  app.render()
  app.send()
  await tick()
  assert.equal(activity(), 'sending', 'nothing is stored before the server answers')

  respond(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
  await tick()
  assert.equal(activity(), 'thinking', 'the accepted prompt is stored and its turn is starting')
  assert.equal(stoppable(), false, 'Stop still waits for the turn to start')

  push({ type: 'user', seq: 1, id: 1, text: 'Make it blue', at: 10 })
  push({ type: 'turn_start', seq: 2, id: 1, turnId: 1, at: 11 })
  await tick()
  await tick()
  assert.equal(activity(), 'thinking')
  assert.equal(stoppable(), true)
  events.close()
})

test('new design chosen before chat boot cannot be overwritten by its delayed transcript', (t) => {
  const ui = browser(t)
  const app = mount(t, ui, { ...guestBoot, user: { id: 'owner', name: 'Owner' }, sessionId: 'old', events: [{ type: 'user', seq: 1, text: 'Old chat' }] }, { booted: false })
  app.account()
  find(app.tree(), (node) => node.type === Sidebar).props.onNew()
  app.render()
  app.boot()
  app.render()
  const transcript = find(app.tree(), (node) => node.type === Transcript)
  assert.equal(transcript.props.sessionId, 'draft')
  assert.deepEqual(transcript.props.entries, [])
})

test('a transient journal error does not fail or poison a cached running chat; journaled errors still do', async (t) => {
  const failure = 'event journal unavailable: temporary read failure'
  const stream = (...items) => new Response(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  let connections = 0
  const ui = browser(t, {
    '/api/events?session=running&after=3': () => stream(connections++ === 0
      ? { type: 'error', text: failure }
      : { type: 'error', seq: 4, turnId: 1, id: 1, text: 'The actual turn failed' }),
    '/api/events?session=other&after=1': () => stream(),
    '/api/session?session=other': () => Response.json({
      transcript: compactTranscript([{ type: 'user', id: 1, seq: 1, text: 'Another chat' }], guestBoot.view),
      summary: { id: 'other', title: 'Other', createdAt: 1, lastActivity: 1, busy: false },
    }),
  })
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'owner', name: 'Owner' }, sessionId: 'running',
    sessions: [{ id: 'running', title: 'Running', createdAt: 1, lastActivity: 10, busy: true }],
    events: [{ type: 'user', seq: 1, id: 1, text: 'Generate' }, { type: 'turn_start', seq: 2, id: 1, turnId: 1, at: 10 }, { type: 'text', seq: 3, turnId: 1, delta: 'Partial answer' }],
  })
  await tick()
  app.render()
  const transcript = () => find(app.tree(), (node) => node.type === Transcript).props
  const rail = () => find(app.tree(), (node) => node.type === Sidebar).props
  assert.equal(transcript().activeTurnId, 1)
  assert.ok(!transcript().entries.some((entry) => entry.text === failure))
  assert.equal(rail().sessions.find((session) => session.id === 'running').busy, true)
  assert.ok(find(app.tree(), (node) => node.props?.role === 'alert' && node.props.children === failure), 'the transport problem remains visible as a notice')

  // Visit another chat, then restore the cached transcript before reopening SSE.
  rail().onSelect('other')
  await tick()
  app.render()
  rail().onSelect('running')
  await tick()
  app.render()
  assert.equal(transcript().activeTurnId, 1)
  assert.ok(!transcript().entries.some((entry) => entry.text === failure))
  assert.equal(rail().sessions.find((session) => session.id === 'running').busy, true)
  assert.equal(ui.requests.filter(({ url }) => url === '/api/session?session=running').length, 0, 'restored from cache')

  app.chat.flush()
  await tick()
  app.render()
  assert.equal(transcript().activeTurnId, null)
  assert.ok(transcript().entries.some((entry) => entry.text === 'The actual turn failed'))
  assert.equal(rail().sessions.find((session) => session.id === 'running').busy, false)
})

test('a reply that finishes later does not move its chat above a newer prompt', async (t) => {
  const stream = (...items) => new Response(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  const ui = browser(t, {
    '/api/events?session=older&after=2': () => stream({ type: 'done', seq: 3, id: 1, turnId: 1, at: 300 }),
  })
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'owner', name: 'Owner' }, sessionId: 'older',
    sessions: [
      { id: 'newer', title: 'Newer', createdAt: 200, lastActivity: 200, busy: true },
      { id: 'older', title: 'Older', createdAt: 100, lastActivity: 100, busy: true },
    ],
    events: [{ type: 'user', seq: 1, id: 1, text: 'Older prompt', at: 100 }, { type: 'turn_start', seq: 2, id: 1, turnId: 1, at: 150 }],
  })
  await tick()
  app.render()
  const rail = find(app.tree(), (node) => node.type === Sidebar).props
  assert.equal(rail.sessions.find((session) => session.id === 'older').busy, false, 'the reply finished')
  assert.deepEqual(rail.sessions.map((session) => session.id), ['newer', 'older'])
})

test('reopening a running chat with joined follow-ups keeps streaming drafts and rejects completed turns', async (t) => {
  const stream = (...items) => new Response(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  const events = [
    { type: 'user', seq: 1, id: 1, text: 'First design' },
    { type: 'turn_start', seq: 2, id: 1, turnId: 1 },
    { type: 'user', seq: 3, id: 2, text: 'Make it blue' },
    { type: 'status', seq: 4, id: 2, turnId: 1, text: 'steering the running turn' },
    { type: 'done', seq: 5, id: 1, turnId: 1 },
    { type: 'user', seq: 6, id: 3, text: 'Another design' },
    { type: 'turn_start', seq: 7, id: 3, turnId: 3 },
    { type: 'user', seq: 8, id: 4, text: 'Make it teal' },
    { type: 'status', seq: 9, id: 4, turnId: 3, text: 'steering the running turn' },
  ]
  let html = '<body><h1>Streaming'
  let finished = false
  const draft = (turnId, revision, delta) => ({ type: 'design_draft', draftId: `attempt-${turnId}`, draftRevision: revision, turnId, artifactRevision: 0, draftOffset: 0, delta })
  const ui = browser(t, {
    '/api/events?session=running&after=9': () => stream(
      draft(1, 1, 'Old completed design'),
      draft(3, 2, html),
      ...(finished ? [{ type: 'done', seq: 10, id: 3, turnId: 3 }, draft(3, 3, 'Late completed design')] : []),
    ),
    '/api/events?session=other&after=1': () => stream(),
    '/api/session?session=other': () => Response.json({
      transcript: compactTranscript([{ type: 'user', id: 1, seq: 1, text: 'Another chat' }], guestBoot.view),
      summary: { id: 'other', title: 'Other', createdAt: 1, lastActivity: 1, busy: false },
    }),
  })
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'owner', name: 'Owner' }, sessionId: 'running', events,
    sessions: [{ id: 'running', title: 'Running', createdAt: 1, lastActivity: 10, busy: true }],
  })
  const preview = () => find(app.tree(), (node) => node.type === PreviewPane).props
  const rail = () => find(app.tree(), (node) => node.type === Sidebar).props
  await tick()
  app.render()
  assert.equal(preview().draft, html, 'boot accepts the active turn despite its higher joined-message id')

  rail().onSelect('other')
  await tick()
  app.render()
  html += ' after reopening</h1>'
  rail().onSelect('running')
  await tick()
  app.render()
  assert.equal(preview().draft, null, 'a chat switch clears the previous provisional picture')
  assert.equal(ui.requests.filter(({ url }) => url === '/api/session?session=running').length, 0, 'reopened from its cached transcript')
  app.chat.flush()
  await tick()
  app.render()
  assert.equal(preview().draft, html, 'the cached active turn resumes its full draft prefix')

  rail().onSelect('other')
  await tick()
  app.render()
  finished = true
  rail().onSelect('running')
  await tick()
  app.render()
  app.chat.flush()
  await tick()
  app.render()
  assert.equal(preview().draft, null, 'a completed turn rejects late draft bytes after reopening')
})

test('background 401/403 leaves UI visible and opens no modal until an explicit send', (t) => {
  const ui = browser(t)
  const app = mount(t, ui)
  for (const status of [401, 403]) {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT, { detail: status }))
    app.render()
    assert.equal(app.dialog().open, false)
    assert.ok(find(app.tree(), (node) => node.type === Composer))
    // The account control lives at the bottom of the session rail.
    assert.equal(find(app.tree(), (node) => node.type === Sidebar)?.props.user, null)
    app.handle().restoreDraft(draft)
    app.render()
    app.send()
    app.render()
    assert.equal(app.dialog().open, true)
    assert.equal(app.dialog().reauthorize, status === 403)
    app.dialog().onOpenChange(false)
    app.render()
  }
})


test('guest model, effort and fast settings are local cookie preferences without private GET/POST', async (t) => {
  const ui = browser(t)
  const app = mount(t, ui)
  await tick()
  app.render()
  const option = find(app.composerTree(), (node) => node.props?.role === 'option' && node.props.children?.[0]?.props?.children === 'default-model')
  assert.ok(option)
  option.props.onClick({ detail: 0 })
  app.render()
  assert.match(document.cookie, /fx0-model=default-model/)
  // A model that offers fast is chosen with fast on.
  assert.match(document.cookie, /fx0-fast=1/)
  const effort = find(app.composerTree(), (node) => node.props?.['aria-label'] === 'reasoning effort: default')
  assert.ok(effort)
  effort.props.onPointerDown({ preventDefault() {}, stopPropagation() {} })
  app.render()
  assert.match(document.cookie, /fx0-effort=high/)
  const fast = find(app.composerTree(), (node) => node.props?.['aria-label'] === 'use default-model with fast mode')
  assert.ok(fast)
  fast.props.onPointerDown({ preventDefault() {}, stopPropagation() {} })
  app.render()
  assert.match(document.cookie, /fx0-fast=0/)
  assert.deepEqual(app.handle().getGeneration(), { model: 'default-model', defaultModel: 'default-model', effort: 'high', fast: false })
  assert.ok(ui.requests.every(({ url }) => url === '/api/models'))
})

// The composer alone, as the app renders it for a signed-in viewer.
function composerAt(ui, sessionId, initialGeneration) {
  const composer = renderHooks(Composer)
  const ref = { current: null }
  const base = { ref, persistSettings: true, busy: false, stopping: false, initialGeneration, onSend() {}, onStop() {}, onNewSession() {} }
  let knownGeneration
  const props = () => ({ ...base, sessionId, knownGeneration })
  let tree = composer.render(props())
  composer.flush()
  ui.cleanups.push(() => composer.cleanup())
  return {
    ref,
    at(next, known) { sessionId = next; knownGeneration = known; tree = composer.render(props()); composer.flush(); tree = composer.render(props()) },
    render() { tree = composer.render(props()); return tree },
  }
}

test('a draft reveals the remembered model before paint without showing the app default', async (t) => {
  const ui = browser(t)
  document.cookie = 'fx0-model=z-model'
  const composer = renderHooks(Composer)
  const props = { sessionId: 'draft', sessionReady: false, persistSettings: false, busy: false, stopping: false,
    initialGeneration: { model: '', defaultModel: 'default-model', effort: '', fast: false },
    onSend() {}, onStop() {}, onNewSession() {} }
  const initial = composer.render(props)
  assert.ok(find(initial, node => node.props?.['aria-label'] === 'Model: loading'))
  assert.equal(find(initial, node => node.props?.['aria-label'] === 'Model: default-model'), null)
  composer.flush()
  assert.ok(find(composer.render(props), node => node.props?.['aria-label'] === 'Model: loading'), 'wait until boot confirms whether this is a draft or an existing chat')
  props.sessionReady = true
  const restored = composer.render(props)
  assert.ok(find(restored, node => node.props?.['aria-label'] === 'Model: z-model'))
  assert.equal(find(restored, node => node.props?.['aria-label'] === 'Model: default-model'), null)
  ui.cleanups.push(() => composer.cleanup())
  await tick()
})

test('a chat waits for its own model instead of flashing the draft or previous chat selection', async (t) => {
  const response = Promise.withResolvers()
  const ui = browser(t, {
    '/api/model?session=chat-1': () => response.promise,
    '/api/model?session=chat-2': () => Response.json({ model: 'a-model', effort: '', fast: false }),
  })
  document.cookie = 'fx0-model=z-model'
  const view = composerAt(ui, 'chat-1', { model: '', defaultModel: 'default-model', effort: '', fast: false })
  await tick()
  assert.ok(find(view.render(), node => node.props?.['aria-label'] === 'Model: loading'))
  response.resolve(Response.json({ model: 'other-model', effort: '', fast: false }))
  await tick()
  assert.ok(find(view.render(), node => node.props?.['aria-label'] === 'Model: other-model'))
  view.at('chat-2')
  assert.ok(find(view.render(), node => node.props?.['aria-label'] === 'Model: loading'))
  await tick()
  assert.ok(find(view.render(), node => node.props?.['aria-label'] === 'Model: a-model'))
})

test('switching to a chat the sidebar lists shows its model at once, with no skeleton or request', async (t) => {
  const ui = browser(t, { '/api/model?session=chat-1': () => Response.json({ model: 'first-model', effort: '', fast: false }) })
  const view = composerAt(ui, 'chat-1', { model: '', defaultModel: 'default-model', effort: '', fast: false })
  await tick()
  assert.ok(find(view.render(), node => node.props?.['aria-label'] === 'Model: first-model'))
  view.at('chat-2', { model: 'listed-model', effort: 'high', fast: false })
  const tree = view.render()
  assert.ok(find(tree, node => node.props?.['aria-label'] === 'Model: listed-model'), 'the listed model shows on the first frame')
  assert.equal(find(tree, node => node.props?.['aria-label'] === 'Model: loading'), null)
  assert.equal(ui.requests.some(({ url }) => url === '/api/model?session=chat-2'), false, 'no settings request for a listed chat')
})

test('switching to a listed chat with no stored model does not write the previous chat\'s model to it', async (t) => {
  const ui = browser(t, { '/api/model?session=chat-1': () => Response.json({ model: 'first-model', effort: '', fast: false }) })
  const view = composerAt(ui, 'chat-1', { model: '', defaultModel: 'default-model', effort: '', fast: false })
  await tick()
  assert.ok(find(view.render(), node => node.props?.['aria-label'] === 'Model: first-model'))
  view.at('chat-2', { model: '', effort: '', fast: false })
  await tick()
  view.render()
  const writes = ui.requests.filter(({ url, init }) => url === '/api/model?session=chat-2' && init?.method === 'POST')
  assert.deepEqual(writes.map(({ init }) => JSON.parse(init.body).model), [], 'no model is written to the chat on a switch')
})

test('a chat whose settings fail to load shows the current model with the error, not an endless skeleton', async (t) => {
  const ui = browser(t, { '/api/model?session=chat-1': () => Response.json({ error: 'Request failed' }, { status: 503 }) })
  const view = composerAt(ui, 'chat-1', { model: 'kept-model', defaultModel: 'default-model', effort: '', fast: false })
  await tick()
  const tree = view.render()
  assert.ok(find(tree, node => node.props?.['aria-label'] === 'Model: kept-model'))
  assert.equal(find(tree, node => node.props?.['aria-label'] === 'Model: loading'), null)
})

test('a "-fast" model shows as its base model with fast on, and the bolt turns fast off', async (t) => {
  const ui = browser(t)
  document.cookie = 'fx0-model=default-model-fast'
  const view = composerAt(ui, 'draft', { model: 'default-model-fast', defaultModel: 'default-model', effort: '', fast: false })
  await tick()
  const tree = view.render()
  assert.ok(find(tree, (node) => node.props?.['aria-label'] === 'Model: default-model'), 'labelled as its base model')
  // Fast shows only in the picker: the trigger carries just the model name.
  assert.equal(find(tree, (node) => node.props?.['aria-label'] === 'fast mode on'), null)
  assert.equal(find(tree, (node) => node.props?.['aria-label'] === 'use default-model with fast mode').props['aria-pressed'], true, 'with the bolt lit')
  // The model rows, past the DESIGN.md picker's options: the "-fast" id is not its own row.
  const rows = []
  find(tree, (node) => { if (node.props?.role === 'option') rows.push([node.props.children?.[0]?.props?.children, node.props['aria-selected']]); return false })
  assert.deepEqual(rows.filter(([name]) => String(name).startsWith('default-model')), [['default-model', true]])
  const bolt = find(tree, (node) => node.props?.['aria-label'] === 'use default-model with fast mode')
  bolt.props.onPointerDown({ preventDefault() {}, stopPropagation() {} })
  view.render()
  assert.deepEqual(view.ref.current.getGeneration(), { model: 'default-model', defaultModel: 'default-model', effort: '', fast: false })
  assert.match(document.cookie, /fx0-model=default-model(;|$)/)
  assert.match(document.cookie, /fx0-fast=0/)
})

test('the model picker opens on the selected model, then the featured ones, then the rest', async (t) => {
  const ui = browser(t)
  const view = composerAt(ui, 'draft', { model: '', defaultModel: 'default-model', effort: '', fast: false })
  await tick()
  const rows = []
  find(view.render(), (node) => { if (node.props?.role === 'option') rows.push(node.props.children?.[0]?.props?.children); return false })
  assert.deepEqual(rows.filter((name) => String(name).endsWith('-model')), ['default-model', 'z-model', 'a-model'])
})

for (const input of ['pointer', 'keyboard']) {
  test(`selecting a model closes the picker immediately (${input})`, async (t) => {
    let releaseSave
    const saved = new Promise((resolve) => { releaseSave = resolve })
    const ui = browser(t, {
      '/api/model?session=chat-1': (init) => saved.then(() => Response.json(JSON.parse(init.body))),
    })
    const view = composerAt(ui, 'chat-1', {
      model: 'a-model', defaultModel: 'default-model', effort: '', fast: false,
      stored: { model: 'a-model', effort: '', fast: false },
    })
    await tick()
    const picker = (tree) => find(tree, (node) => typeof node.props?.onOpenChange === 'function' && 'open' in node.props)
    picker(view.render()).props.onOpenChange(true)
    const tree = view.render()
    assert.equal(picker(tree).props.open, true)
    const row = find(tree, (node) => node.props?.role === 'option' && node.props.children?.[0]?.props?.children === 'z-model')
    if (input === 'pointer') row.props.onPointerDown({ button: 0 })
    else row.props.onClick({ detail: 0 })
    const after = view.render()
    assert.equal(picker(after).props.open, false, 'close without waiting for the settings request')
    assert.equal(view.ref.current.getGeneration().model, 'z-model')
    releaseSave()
    await tick()
    await tick()
    view.render()
    const writes = ui.requests.filter(({ url, init }) => url === '/api/model?session=chat-1' && init?.method === 'POST')
    assert.equal(writes.length, 1)
    assert.equal(JSON.parse(writes[0].init.body).model, 'z-model')
  })
}

test('model search preserves catalog recency order for equally matching names', async (t) => {
  const ui = browser(t)
  const view = composerAt(ui, 'draft', { model: '', defaultModel: 'default-model', effort: '', fast: false })
  await tick()
  find(view.render(), (node) => node.props?.id === 'model-search').props.onChange({ target: { value: 'model' } })
  const rows = []
  find(view.render(), (node) => { if (node.props?.role === 'option') rows.push(node.props.children?.[0]?.props?.children); return false })
  assert.deepEqual(rows, ['a-model', 'default-model', 'z-model'], 'equally ranked matches keep the API order, not the featured order')
})

test('a reloaded chat uses the settings the page rendered, and asks only for later chats', async (t) => {
  const ui = browser(t, { '/api/model?session=chat-2': () => Response.json({ model: 'z-model', effort: '', fast: false }) })
  const stored = { model: 'a-model', effort: 'high', fast: true }
  const view = composerAt(ui, 'chat-1', { model: 'a-model', defaultModel: 'default-model', effort: 'high', fast: true, stored })
  await tick()
  view.render()
  assert.deepEqual(ui.requests.filter(({ url }) => url.startsWith('/api/model?')), [], 'no settings request on load')
  assert.equal(view.ref.current.getGeneration().model, 'a-model')
  view.at('chat-2')
  await tick()
  await tick()
  view.render()
  assert.deepEqual(ui.requests.filter(({ url }) => url.startsWith('/api/model?')).map(({ url }) => url), ['/api/model?session=chat-2'])
  assert.equal(view.ref.current.getGeneration().model, 'z-model')
})

test('a rendered chat with no stored model still saves the one the picker shows', async (t) => {
  const ui = browser(t, { '/api/model?session=chat-1': (init) => Response.json({ ok: true, ...JSON.parse(init.body) }) })
  const view = composerAt(ui, 'chat-1', { model: 'default-model', defaultModel: 'default-model', effort: '', fast: false, stored: { model: '', effort: '', fast: false } })
  await tick()
  await tick()
  view.render()
  const writes = ui.requests.filter(({ url }) => url === '/api/model?session=chat-1')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].init.method, 'POST', 'written through, not read')
  assert.equal(JSON.parse(writes[0].init.body).model, 'default-model')
})

test('opening a chat keeps the remembered model and fast, and a new chat starts from them', async (t) => {
  const ui = browser(t, { '/api/model?session=chat-1': () => Response.json({ model: 'other-model', effort: '', fast: false }) })
  document.cookie = 'fx0-model=default-model'
  document.cookie = 'fx0-effort=high'
  document.cookie = 'fx0-fast=1'
  const view = composerAt(ui, 'chat-1', { model: 'other-model', defaultModel: 'default-model', effort: '', fast: false })
  await tick()
  await tick()
  view.render()
  assert.deepEqual(view.ref.current.getGeneration(), { model: 'other-model', defaultModel: 'default-model', effort: '', fast: false }, 'the chat runs its own settings')
  assert.match(document.cookie, /fx0-model=default-model(;|$)/)
  assert.match(document.cookie, /fx0-fast=1/)
  view.at('draft')
  assert.deepEqual(view.ref.current.getGeneration(), { model: 'default-model', defaultModel: 'default-model', effort: 'high', fast: true })
})

test('the source link opens the fx0 repo in a new tab', (t) => {
  browser(t)
  const link = find(renderHooks(SourceLink).render({}), (node) => node.type === 'a')
  assert.equal(link.props['aria-label'], 'fx0 source on GitHub (opens in a new tab)')
  assert.equal(link.props.href, 'https://github.com/vercel-labs/fx0')
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.rel, 'noopener noreferrer')
})

test('an attached image thumbnail opens the image full size', (t) => {
  browser(t)
  const view = renderHooks(ImagePreview)
  const props = { src: 'data:image/png;base64,AAAA', alt: 'Attached image 1', className: 'max-h-20' }
  let tree = view.render(props)
  const thumbnail = find(tree, (node) => node.type === 'button')
  assert.equal(thumbnail.props['aria-label'], 'View attached image 1')
  assert.equal(find(thumbnail, (node) => node.type === 'img').props.src, props.src)
  assert.equal(find(tree, (node) => node.props?.open !== undefined).props.open, false)
  thumbnail.props.onClick()
  tree = view.render(props)
  const dialog = find(tree, (node) => node.props?.open !== undefined)
  assert.equal(dialog.props.open, true)
  const images = []
  find(dialog, (node) => { if (node.type === 'img') images.push(node.props.src); return false })
  assert.deepEqual(images, [props.src])
})

test('how it works explains fx0 and links to forking its repo', (t) => {
  browser(t)
  const tree = renderHooks(HowItWorks).render({})
  const trigger = find(tree, (node) => node.type === 'button')
  assert.equal(trigger?.props['aria-label'], 'how it works')
  assert.equal(REPO_URL, 'https://github.com/vercel-labs/fx0')
  const repo = find(tree, (node) => node.type === 'a' && node.props.href === `${REPO_URL}/fork`)
  assert.equal(repo?.props.children, 'fork fx0')
  assert.equal(repo.props.target, '_blank')
  // The files it tells a fork to edit are where it says.
  const paths = []
  find(tree, (node) => { if (node.type === 'code' && /\.ts$/.test([].concat(node.props.children)[0])) paths.push(node.props.children); return false })
  assert.deepEqual(paths, ['lib/agent.ts', 'lib/tools.ts'])
  for (const path of paths) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} exists`)
})

test('oversized OAuth draft blocks navigation visibly rather than losing text or images', (t) => {
  const ui = browser(t)
  const app = mount(t, ui)
  const oversized = { ...draft, text: 'a'.repeat(256 * 1024 + 1) }
  app.handle().restoreDraft(oversized)
  app.render()
  app.send()
  app.render()
  const allowed = app.dialog().onSignIn()
  app.render()
  assert.equal(allowed, false)
  assert.match(app.dialog().error, /Unable to preserve this draft/)
  assert.deepEqual(app.handle().getDraft(), { ...oversized, designMd: null })
  assert.equal(ui.storage.getItem(GUEST_DRAFT_KEY), null)
})

test('guest history, URL navigation and diagnostics cannot access private sessions', async (t) => {
  const ui = browser(t)
  const app = mount(t, ui)
  const sidebar = find(app.tree(), (node) => typeof node.props?.onPrefetch === 'function')
  sidebar.props.onPrefetch('someone-elses-session')
  sidebar.props.onSelect('someone-elses-session')
  sidebar.props.onDelete('someone-elses-session')
  window.location.search = '?s=someone-elses-session'
  window.dispatchEvent(new Event('popstate'))
  // The guest stays on a draft, which has nothing to diagnose: the button isn't there.
  assert.equal(find(app.tree(), (node) => node.props?.['aria-label'] === 'open session diagnostics'), null)
  app.render()
  const composer = find(app.tree(), (node) => node.type === Composer)
  assert.equal(composer.props.sessionId, 'draft')
  assert.equal(composer.props.persistSettings, false)
  assert.equal(app.dialog().open, false)
  await tick()
  assert.ok(ui.requests.every(({ url }) => url === '/api/models'))
})

test('the chat title menu opens diagnostics, and deletes the chat only on a second press', async (t) => {
  const deletes = []
  const ui = browser(t, {
    '/api/events?session=saved&after=1': () => new Response('', { headers: { 'content-type': 'text/event-stream' } }),
    '/api/session?session=saved': (init) => { deletes.push(init?.method); return Response.json({ ok: true }) },
  })
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'owner', name: 'Owner' }, sessionId: 'saved',
    sessions: [{ id: 'saved', title: 'Saved', createdAt: 1, lastActivity: 1, busy: false }],
    events: [{ type: 'user', seq: 1, id: 1, text: 'Keep this' }],
  })
  await tick()
  app.render()
  const item = (text) => find(app.tree(), (node) => node.type === 'button' && node.props.children === text)
  const diagnostics = () => find(app.tree(), (node) => node.props?.['aria-label'] === 'open session diagnostics')

  assert.equal(diagnostics().props.disabled, false)
  diagnostics().props.onClick({ detail: 0 })
  app.render()
  assert.equal(diagnostics().props['aria-expanded'], true)

  assert.equal(item('delete chat').props.disabled, false)
  item('delete chat').props.onClick()
  app.render()
  assert.deepEqual(deletes, [], 'the first press only asks to confirm')
  assert.ok(item('confirm delete'))
  item('confirm delete').props.onClick()
  await tick()
  app.render()
  assert.deepEqual(deletes, ['DELETE'])
  // With no chats left the view falls back to a draft, which has no title menu.
  assert.equal(diagnostics(), null)
  assert.equal(find(app.tree(), (node) => node.type === Sidebar).props.sessions.length, 0)
})

test('deleting the chat the page is still opening keeps its delayed transcript from reopening it', async (t) => {
  const deletes = []
  const ui = browser(t, { '/api/session?session=old': (init) => { deletes.push(init?.method); return Response.json({ ok: true }) } })
  window.location.search = '?s=old'
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'owner', name: 'Owner' }, sessionId: 'old',
    sessions: [{ id: 'old', title: 'Old', createdAt: 1, lastActivity: 1, busy: false }],
    events: [{ type: 'user', seq: 1, id: 1, text: 'Old chat' }],
  }, { booted: false })
  app.account()
  find(app.tree(), (node) => node.type === Sidebar).props.onDelete('old')
  await tick()
  app.boot()
  app.render()
  assert.deepEqual(deletes, ['DELETE'])
  assert.equal(find(app.tree(), (node) => node.type === Transcript).props.sessionId, 'draft')
  assert.ok(!find(app.tree(), (node) => node.type === Sidebar).props.sessions.some((session) => session.id === 'old'))
})

test('a refused delete of the open chat restores its row and keeps the error after leaving it', async (t) => {
  const busy = 'Chat is busy; stop the active turn and retry'
  let releaseOther
  const other = new Promise((resolve) => { releaseOther = resolve })
  const ui = browser(t, {
    '/api/events?session=saved&after=1': () => new Response('', { headers: { 'content-type': 'text/event-stream' } }),
    '/api/events?session=other&after=1': () => new Response('', { headers: { 'content-type': 'text/event-stream' } }),
    '/api/session?session=saved': () => Response.json({ error: busy }, { status: 409 }),
    '/api/session?session=other': () => other,
  })
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'owner', name: 'Owner' }, sessionId: 'saved',
    sessions: [
      { id: 'saved', title: 'Saved', createdAt: 1, lastActivity: 2, busy: false },
      { id: 'other', title: 'Other', createdAt: 1, lastActivity: 1, busy: false },
    ],
    events: [{ type: 'user', seq: 1, id: 1, text: 'Keep this' }],
  })
  await tick()
  app.render()
  const rail = () => find(app.tree(), (node) => node.type === Sidebar).props
  rail().onDelete('saved')
  app.render()
  assert.deepEqual(rail().sessions.map((session) => session.id), ['other'], 'the row goes before the server answers')
  await tick()
  // The switch to the next chat lands after the refusal, as on a slow load.
  releaseOther(Response.json({
    transcript: compactTranscript([{ type: 'user', id: 1, seq: 1, text: 'Another chat' }], guestBoot.view),
    summary: { id: 'other', title: 'Other', createdAt: 1, lastActivity: 1, busy: false },
  }))
  await tick()
  app.render()
  assert.deepEqual(rail().sessions.map((session) => session.id), ['saved', 'other'])
  assert.ok(find(app.tree(), (node) => node.props?.role === 'alert' && node.props.children === busy))
})

test('escape twice in quick succession clears the prompt; a slow second escape does not', (t) => {
  const ui = browser(t)
  const app = mount(t, ui)
  const prompt = () => find(app.composerTree(), (node) => node.props?.name === 'prompt')
  const escape = (timeStamp) => prompt().props.onKeyDown({ key: 'Escape', timeStamp, preventDefault() {}, nativeEvent: { isComposing: false } })
  app.handle().restoreDraft({ text: 'create a landing page', images: [] })
  app.render()
  escape(1000)
  app.render()
  escape(2000)
  app.render()
  assert.equal(app.handle().getDraft().text, 'create a landing page')
  escape(2300)
  app.render()
  assert.equal(app.handle().getDraft().text, '')
})

test('attach offers image or design.md on a new chat, and design.md opens its list in place', async (t) => {
  const ui = browser(t)
  const view = composerAt(ui, 'draft', { model: '', defaultModel: 'default-model', effort: '', fast: false })
  await tick()
  const byLabel = (label) => find(view.render(), (node) => node.props?.['aria-label'] === label)
  const item = (text) => find(view.render(), (node) => node.props?.role === 'menuitem' && [node.props.children].flat().some((child) => child === text || child?.props?.children === text))
  assert.ok(byLabel('attach'), 'one attach button')
  assert.equal(byLabel('add design.md'), null, 'no separate design.md button')
  assert.ok(item('image') && item('design.md'))
  assert.equal(byLabel('design.md files'), null, 'the list waits for design.md')
  item('design.md').props.onClick({ detail: 0 })
  const list = byLabel('design.md files')
  assert.ok(list, 'design.md opens its list in the same menu')
  const vercel = find(list, (node) => node.props?.role === 'option' && node.props.children?.[0]?.props?.children === 'Vercel')
  vercel.props.onClick({ detail: 0 })
  view.render()
  assert.deepEqual(view.ref.current.getDesignMd(), { id: 'vercel', name: 'Vercel' })
  assert.ok(byLabel('attach, design.md: Vercel'), 'the button says what is attached')
  // On an existing chat attach means images, since a design.md only goes with a first prompt.
  view.at('chat-1')
  assert.ok(byLabel('attach images'))
  assert.equal(byLabel('attach'), null)
})

test('choosing image closes the attach menu without leaving its tooltip stuck open', async (t) => {
  const ui = browser(t)
  const view = composerAt(ui, 'draft', { model: '', defaultModel: 'default-model', effort: '', fast: false })
  await tick()
  // The tooltip's own node: its direct children are the trigger and the "attach" label.
  const tooltip = () => find(view.render(), (node) => typeof node.props?.onOpenChange === 'function' && 'open' in node.props &&
    [node.props.children].flat().some((child) => child?.props?.children === 'attach'))
  tooltip().props.onOpenChange(true)
  assert.equal(tooltip().props.open, true, 'hovering shows the tooltip')
  find(view.render(), (node) => node.props?.['aria-label'] === 'attach').props.onPointerDown({ button: 0, preventDefault() {} })
  assert.equal(tooltip().props.open, false, 'hidden while the menu is open')
  const image = find(view.render(), (node) => node.props?.role === 'menuitem' && node.props.children === 'image')
  image.props.onClick({ detail: 0 })
  // The system file dialog takes the pointer, so no pointer leave arrives to close it.
  assert.equal(tooltip().props.open, false, 'still closed after the menu closes')
})

test('publish with Drop opens Vercel Drop inside the click, before the design loads', async (t) => {
  browser(t)
  const { default: DesignExport, DROP_URL } = await import(pathToFileURL(join(output, 'components/design-export.js')).href)
  const opened = []
  window.open = (...args) => { opened.push(args); return null }
  const tree = renderHooks(DesignExport).render({ sessionId: 'chat-1', revision: null, latest: 2, title: 'Coffee', onNotice() {} })
  const publish = find(tree, (node) => node.type === 'button' && [node.props.children].flat().includes('publish with Drop'))
  assert.ok(publish, 'the export menu offers Drop')
  // Only the click carries user activation for every pointer type; pointer-down doesn't
  // for touch or pen, so a popup blocker would stop the tab.
  assert.equal(publish.props.onPointerDown, undefined)
  publish.props.onClick({ detail: 1 })
  // Synchronous, in the user's click, so a popup blocker allows it.
  assert.deepEqual(opened, [[DROP_URL, '_blank', 'noopener,noreferrer']])
  assert.equal(DROP_URL, 'https://vercel.com/drop')
})

test('normal sidebar keeps its home, help, account, row spacing and two-click delete defaults', () => {
  const deleted = [], selected = []
  let homes = 0
  const props = {
    sessions: [{ id: 'chat-1', title: 'Saved chat', lastActivity: 1, busy: false }],
    activeId: 'chat-1', loadingId: null, now: 10,
    onSelect: id => selected.push(id), onPrefetch() {}, onNew: () => homes++,
    onDelete: id => deleted.push(id), user: null, team: null,
    onSignIn() {}, onSignOut() {}, onSwitchTeam: async () => {}, onGrantTeams() {},
  }
  const sidebar = renderHooks(Sidebar.type)
  const render = () => sidebar.render(props)
  const tree = render()
  const brand = find(tree, node => node.type === Brand)
  const anchor = Brand(brand.props)
  assert.equal(anchor.props.href, '/')
  assert.ok(find(tree, node => node.type === HowItWorks))
  assert.equal(find(tree, node => node.type === AccountMenu).props.user, null)
  assert.match(find(tree, node => node.props?.title === 'Saved chat').props.className, /group-focus-within\/row:pr-6 group-hover\/row:pr-6/)
  let prevented = 0
  const click = { button: 0, preventDefault: () => prevented++ }
  anchor.props.onClick(click)
  assert.equal(homes, 1)
  assert.equal(prevented, 1)
  for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) anchor.props.onClick({ ...click, [modifier]: true })
  anchor.props.onClick({ ...click, button: 1 })
  assert.equal(homes, 1, 'modified clicks retain native link behavior')
  assert.equal(prevented, 1)
  find(tree, node => node.props?.['aria-current'] === 'page').props.onClick({ detail: 0 })
  assert.deepEqual(selected, ['chat-1'])
  find(tree, node => node.props?.['aria-label'] === 'delete Saved chat').props.onClick()
  assert.deepEqual(deleted, [])
  find(render(), node => node.props?.['aria-label'] === 'confirm delete Saved chat').props.onClick()
  assert.deepEqual(deleted, ['chat-1'])
  assert.ok(find(render(), node => node.props?.['aria-label'] === 'delete Saved chat'))
})

test('demo sidebar overrides stay opt-in without duplicating the normal sidebar', () => {
  const tree = renderHooks(Sidebar.type).render({
    sessions: [{ id: 'room-1', title: 'Room', lastActivity: 1, busy: false }],
    activeId: 'room-1', loadingId: null, now: 10,
    onSelect() {}, onPrefetch() {}, onNew() {},
    homeHref: '/ampersand', help: false, account: false,
    user: null, team: null, onSignIn() {}, onSignOut() {}, onSwitchTeam: async () => {}, onGrantTeams() {},
  })
  assert.equal(Brand(find(tree, node => node.type === Brand).props).props.href, '/ampersand')
  assert.equal(find(tree, node => node.type === HowItWorks), null)
  assert.equal(find(tree, node => node.type === AccountMenu), null)
  assert.equal(find(tree, node => node.props?.['aria-label'] === 'delete Room'), null)
  assert.doesNotMatch(find(tree, node => node.props?.title === 'Room').props.className, /group-hover\/row:pr-6/)
})

// Sign-out intentionally closes this document's shared auth gate until reload.
test('signout immediately clears the app, fences late boot data and offers retry on failure', async (t) => {
  const response = Promise.withResolvers()
  const deletion = Promise.withResolvers()
  let retry = false
  const ui = browser(t, {
    '/api/auth/signout': () => retry ? new Response(null, { status: 200 }) : response.promise,
    '/api/events?session=private-chat&after=1': () => new Response(new ReadableStream()),
    '/api/session?session=other-private': () => deletion.promise,
  })
  const navigations = []
  window.location.assign = url => navigations.push(url)
  const data = { ...guestBoot, user: { id: 'owner', name: 'Private Owner' }, team: 'private-team', sessionId: 'private-chat',
    sessions: [{ id: 'private-chat', title: 'Private chat', createdAt: 1, lastActivity: 1 }, { id: 'other-private', title: 'Another private chat', createdAt: 1, lastActivity: 1 }],
    events: [{ type: 'user', text: 'Private message', id: 1, seq: 1 }], view: { artifactRevision: 1 } }
  const app = mount(t, ui, data)
  await tick()
  const rail = () => find(app.tree(), node => node.type === Sidebar).props
  assert.equal(rail().user.id, 'owner')
  rail().onDelete('other-private')
  app.render()
  const controls = renderHooks(AccountMenu)
  const accountProps = () => rail().account.props.fallback.props
  const menu = controls.render(accountProps())
  find(menu, node => node.type === 'button' && node.props.children?.some?.(child => child?.props?.children === 'sign out')).props.onClick({ detail: 0 })
  app.render()
  assert.equal(rail().user, null)
  assert.equal(rail().team, null)
  assert.deepEqual(rail().sessions, [])
  assert.equal(find(app.tree(), node => node.type === Transcript).props.sessionId, 'draft')
  assert.deepEqual(find(app.tree(), node => node.type === Transcript).props.entries, [])
  assert.equal(find(app.tree(), node => node.type === PreviewPane).props.source.revision, 0)
  assert.equal(rail().signOutStatus, 'pending')
  rail().onSignOut()
  assert.equal(ui.requests.filter(({ url }) => url === '/api/auth/signout').length, 1, 'all account controls share one pending signout')
  assert.deepEqual(navigations, [])
  const guestMenu = controls.render(accountProps())
  assert.ok(find(guestMenu, node => node.props?.children === 'Sign in').props.disabled)
  app.boot()
  deletion.resolve(new Response(null, { status: 503 }))
  await tick()
  app.render()
  assert.equal(rail().user, null, 'late account boot cannot restore the old login')
  assert.deepEqual(rail().sessions, [], 'late sidebar boot cannot restore private chats')
  response.resolve(new Response(null, { status: 503 }))
  await tick()
  app.render()
  assert.equal(rail().signOutStatus, 'failed')
  assert.deepEqual(rail().sessions, [])
  const retryButton = find(app.tree(), node => node.props?.children === 'Retry sign out')
  assert.ok(retryButton)
  assert.deepEqual(navigations, [])
  // The old grant is unusable and retrying may keep failing; a fresh sign-in must stay open.
  const failedMenu = controls.render(accountProps())
  const signInAfterFailure = find(failedMenu, node => node.props?.children === 'Sign in')
  assert.equal(signInAfterFailure.props.disabled, false)
  signInAfterFailure.props.onClick({ detail: 0 })
  assert.deepEqual(navigations, ['/api/auth/signin'])
  navigations.length = 0
  retry = true
  // A reload remounts the guest app while the old HttpOnly grant may still
  // exist. The durable intent resumes the POST without another user click.
  assert.match(document.cookie, /fx0-signout-pending=1/)
  const reloaded = mount(t, ui)
  await tick()
  reloaded.render()
  assert.equal(find(reloaded.tree(), node => node.type === Sidebar).props.user, null)
  assert.equal(ui.requests.filter(({ url }) => url === '/api/auth/signout').length, 2)
  assert.deepEqual(navigations, ['/'])
})

test('a signed-in chat can open the model picker while a reply is generating', async (t) => {
  const ui = browser(t, {
    '/api/events?session=running&after=2': () => new Response('', { headers: { 'content-type': 'text/event-stream' } }),
  })
  const app = mount(t, ui, {
    ...guestBoot, user: { id: 'owner', name: 'Owner' }, sessionId: 'running',
    sessions: [{ id: 'running', title: 'Running', createdAt: 1, lastActivity: 1, busy: true }],
    events: [{ type: 'user', seq: 1, id: 1, text: 'Generate', at: 1 }, { type: 'turn_start', seq: 2, id: 1, turnId: 1, at: 2 }],
  })
  await tick()
  app.render()
  assert.equal(find(app.tree(), (node) => node.type === Composer).props.busy, true)
  const picker = find(app.composerTree(), (node) => node.props?.['aria-label']?.startsWith?.('Model: '))
  assert.ok(picker)
  assert.equal(picker.props.disabled, false)
})
