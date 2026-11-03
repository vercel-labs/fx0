import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

let moduleId = 0
const loadUi = () => import(`../components/auth-ui.ts?test=${++moduleId}`)

function storage(entries = []) {
  const values = new Map(entries)
  return {
    get length() { return values.size },
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  }
}

function browser(t, local = storage(), session = storage()) {
  const events = []
  const navigations = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const cookies = new Map([['fx0-signed-in', '1']])
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: {
    prerendering: false,
    visibilityState: 'visible',
    get cookie() { return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') },
    set cookie(raw) {
      const [name, value] = raw.split(';')[0].split('=')
      if (/Max-Age=0(?:;|$)/.test(raw)) cookies.delete(name)
      else cookies.set(name, value)
    },
  } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: local,
    sessionStorage: session,
    dispatchEvent: (event) => { events.push(event); return true },
    location: { protocol: 'https:', assign: (url) => navigations.push(url) },
  } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else delete globalThis.window
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else delete globalThis.document
  })
  return { events, navigations }
}

test('401 keeps the app and its draft in place, opens no navigation and does not retry', async (t) => {
  const ui = await loadUi()
  const local = storage([['fx0-author', 'old user'], ['other-app', 'keep']])
  const session = storage([['fx0:transcript', 'private']])
  const { events, navigations } = browser(t, local, session)
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }))
  await assert.rejects(ui.fetchUi('/api/prompt'), { status: 401 })
  await assert.rejects(ui.fetchUi('/api/model'), { status: 401 })
  assert.equal(fetch.mock.callCount(), 1)
  // Guest mode: the sign-in dialog owns recovery, so a background 401 never
  // navigates away or discards an unsent draft. Sign-out still clears storage.
  assert.deepEqual(navigations, [])
  assert.deepEqual(events.map((event) => [event.type, event.detail]), [[ui.AUTH_REQUIRED_EVENT, 401]])
})

test('403 requests reauthorization without login navigation or repeated requests', async (t) => {
  const ui = await loadUi()
  const { events, navigations } = browser(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }))
  await assert.rejects(ui.fetchUi('/api/events'), { status: 403, message: /Reauthorize/ })
  await assert.rejects(ui.fetchUi('/api/sessions'), { status: 403 })
  assert.equal(fetch.mock.callCount(), 1)
  assert.deepEqual(navigations, [])
  assert.equal(events[0].detail, 403)
})

test('a failed preview frame opens the same gate once, and later requests reuse its error', async (t) => {
  const ui = await loadUi()
  const { events } = browser(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }))
  const first = ui.signalAuthRequired(401)
  assert.ok(first instanceof ui.AuthRouteError)
  assert.equal(first.status, 401)
  assert.equal(ui.signalAuthRequired(403), first)
  await assert.rejects(ui.fetchUi('/api/prompt'), (error) => error === first)
  assert.equal(fetch.mock.callCount(), 0)
  assert.deepEqual(events.map((event) => [event.type, event.detail]), [[ui.AUTH_REQUIRED_EVENT, 401]])
})

test('a fetch 403 and a later frame signal share one gate error without a second event', async (t) => {
  const ui = await loadUi()
  const { events } = browser(t)
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }))
  const fetched = await ui.fetchUi('/api/sessions').catch((error) => error)
  assert.equal(fetched.status, 403)
  assert.equal(ui.signalAuthRequired(401), fetched)
  assert.deepEqual(events.map((event) => [event.type, event.detail]), [[ui.AUTH_REQUIRED_EVENT, 403]])
})

test('uiAuthError is null while open, then the same error for frame and fetch signals, with no extra event', async (t) => {
  const ui = await loadUi()
  const { events } = browser(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }))
  assert.equal(ui.uiAuthError(), null)
  assert.equal(events.length, 0, 'reading the gate dispatches nothing')
  const frame = ui.signalAuthRequired(401)
  assert.equal(ui.uiAuthError(), frame)
  assert.equal(ui.signalAuthRequired(403), frame)
  const fetched = await ui.fetchUi('/api/prompt').catch((error) => error)
  assert.equal(fetched, frame, 'a fetch after the gate closed reuses the frame error')
  assert.equal(ui.uiAuthError(), frame)
  assert.equal(fetch.mock.callCount(), 0)
  assert.deepEqual(events.map((event) => [event.type, event.detail]), [[ui.AUTH_REQUIRED_EVENT, 401]])
})

test('a fetch 403 closes the gate for uiAuthError, and a later frame signal reuses that error', async (t) => {
  const ui = await loadUi()
  const { events } = browser(t)
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }))
  assert.equal(ui.uiAuthError(), null)
  const fetched = await ui.fetchUi('/api/sessions').catch((error) => error)
  assert.equal(ui.uiAuthError(), fetched)
  assert.equal(ui.signalAuthRequired(401), fetched)
  assert.equal(ui.uiAuthError(), fetched)
  assert.deepEqual(events.map((event) => [event.type, event.detail]), [[ui.AUTH_REQUIRED_EVENT, 403]])
})

test('ordinary API errors stay with the owning UI and do not close the auth gate', async (t) => {
  const ui = await loadUi()
  const { events } = browser(t)
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }))
  assert.equal((await ui.fetchUi('/api/model')).status, 503)
  assert.equal((await ui.fetchUi('/api/model')).status, 503)
  assert.equal(fetch.mock.callCount(), 2)
  assert.deepEqual(events, [])
})

test('API diagnostics use one lazy document-local page ID and read live browser context', async (t) => {
  const local = storage()
  const session = storage()
  browser(t, local, session)
  const cookie = document.cookie
  const randomUUID = t.mock.method(globalThis.crypto, 'randomUUID')
  const ui = await loadUi()
  assert.equal(randomUUID.mock.callCount(), 0, 'module loading does not create an identity')
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }))
  document.prerendering = true
  document.visibilityState = 'hidden'
  await ui.fetchUi('/api/sessions')
  document.prerendering = false
  document.visibilityState = 'visible'
  await ui.fetchUi('/api/model')
  const first = fetch.mock.calls[0].arguments[1].headers
  const second = fetch.mock.calls[1].arguments[1].headers
  const page = first.get('x-fx0-auth-page')
  assert.match(page, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.equal(second.get('x-fx0-auth-page'), page)
  assert.equal(randomUUID.mock.callCount(), 1)
  assert.equal(first.get('x-fx0-auth-prerender'), '1')
  assert.equal(first.get('x-fx0-auth-visibility'), 'hidden')
  assert.equal(second.get('x-fx0-auth-prerender'), '0')
  assert.equal(second.get('x-fx0-auth-visibility'), 'visible')
  const nextDocument = await loadUi()
  assert.equal(randomUUID.mock.callCount(), 1)
  await nextDocument.fetchUi('/api/sessions')
  assert.notEqual(fetch.mock.calls[2].arguments[1].headers.get('x-fx0-auth-page'), page)
  assert.equal(randomUUID.mock.callCount(), 2)
  assert.equal(document.cookie, cookie)
  assert.equal(local.length, 0)
  assert.equal(session.length, 0)
})

test('API diagnostics preserve caller headers, request options and cancellation', async (t) => {
  browser(t)
  const ui = await loadUi()
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }))
  for (const headers of [
    { 'content-type': 'application/json', 'x-caller': 'keep' },
    [['content-type', 'application/json'], ['x-caller', 'keep']],
    new Headers({ 'content-type': 'application/json', 'x-caller': 'keep' }),
  ]) {
    const controller = new AbortController()
    const init = { method: 'POST', body: '{"model":"test"}', headers, signal: controller.signal, credentials: 'same-origin', keepalive: true }
    await ui.fetchUi('/api/model', init)
    const [input, sent] = fetch.mock.calls.at(-1).arguments
    assert.equal(input, '/api/model')
    assert.equal(sent.headers.get('content-type'), 'application/json')
    assert.equal(sent.headers.get('x-caller'), 'keep')
    assert.equal(new Headers(headers).has('x-fx0-auth-page'), false, 'caller headers are not mutated')
    assert.deepEqual({ ...sent, headers, signal: controller.signal }, init)
    assert.equal(sent.signal.aborted, false)
    controller.abort()
    assert.equal(sent.signal.aborted, true)
  }
})

test('diagnostics do not attach to absolute, protocol-relative, backslash or non-API URLs', async (t) => {
  browser(t)
  const ui = await loadUi()
  const randomUUID = t.mock.method(globalThis.crypto, 'randomUUID')
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }))
  const headers = { 'x-caller': 'keep' }
  for (const input of [
    'https://external.example/api/sessions',
    'https://fx0.example/api/sessions',
    '//external.example/api/sessions',
    '/\\external.example/api/sessions',
    '/api/\\external.example/sessions',
    '\\api\\sessions',
    '/sessions',
    '/api',
  ]) {
    await ui.fetchUi(input, { headers })
    const [url, init] = fetch.mock.calls.at(-1).arguments
    assert.equal(url, input)
    assert.equal(init.headers, headers)
  }
  assert.equal(randomUUID.mock.callCount(), 0)
})

test('unsupported browser state is reported as unknown, not as observed non-prerendering', async (t) => {
  browser(t)
  const ui = await loadUi()
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }))
  delete document.prerendering
  for (const state of [undefined, 'unrecognized']) {
    document.visibilityState = state
    await ui.fetchUi('/api/sessions')
    const headers = fetch.mock.calls.at(-1).arguments[1].headers
    assert.equal(headers.get('x-fx0-auth-prerender'), 'unknown')
    assert.equal(headers.get('x-fx0-auth-visibility'), 'unknown')
  }
})

test('unavailable or throwing diagnostic APIs never prevent fetching', async (t) => {
  for (const scenario of [
    'missing crypto', 'missing randomUUID', 'throwing randomUUID', 'throwing crypto',
    'missing document', 'throwing document', 'throwing prerendering', 'throwing visibility',
  ]) {
    await t.test(scenario, async (t) => {
      browser(t)
      const ui = await loadUi()
      const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
      t.after(() => Object.defineProperty(globalThis, 'crypto', originalCrypto))
      const blocked = () => { throw new Error('Unavailable browser API') }
      if (scenario === 'missing crypto') Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
      if (scenario === 'missing randomUUID') Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} })
      if (scenario === 'throwing randomUUID') Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: blocked } })
      if (scenario === 'throwing crypto') Object.defineProperty(globalThis, 'crypto', { configurable: true, get: blocked })
      if (scenario === 'missing document') globalThis.document = undefined
      if (scenario === 'throwing document') Object.defineProperty(globalThis, 'document', { configurable: true, get: blocked })
      if (scenario === 'throwing prerendering') Object.defineProperty(document, 'prerendering', { get: blocked })
      if (scenario === 'throwing visibility') Object.defineProperty(document, 'visibilityState', { get: blocked })
      const response = new Response(null, { status: 200 })
      const fetch = t.mock.method(globalThis, 'fetch', async () => response)
      const headers = { 'x-caller': 'keep' }
      assert.equal(await ui.fetchUi('/api/sessions', { headers }), response)
      assert.equal(fetch.mock.callCount(), 1)
      assert.equal(fetch.mock.calls[0].arguments[1].headers, headers)
      assert.equal(ui.uiAuthError(), null)
    })
  }
})

test('storage cleanup is app-scoped and tolerates unavailable storage', async (t) => {
  const ui = await loadUi()
  const session = storage([['fx0', 'private'], ['fx0.session', 'private'], ['fx0-other', 'private'], ['fx00-other', 'keep']])
  browser(t, storage(), session)
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('Blocked') } })
  assert.doesNotThrow(ui.clearUserStorage)
  assert.deepEqual([...session.values], [['fx00-other', 'keep']])
})

test('successful signout POST clears private state before returning to the guest app', async (t) => {
  const ui = await loadUi()
  const local = storage([['fx0-history', 'private']])
  const session = storage([['fx0:session', 'private']])
  const { navigations } = browser(t, local, session)
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }))
  let clearedMemory = false
  await ui.signOutAccount(() => {
    assert.equal(local.length, 0)
    assert.equal(session.length, 0)
    assert.deepEqual(navigations, [])
    clearedMemory = true
  })
  assert.deepEqual(fetch.mock.calls[0].arguments, ['/api/auth/signout', { method: 'POST', keepalive: true }])
  assert.equal(clearedMemory, true)
  assert.deepEqual(navigations, ['/'])
})

test('signout remains available after team permission rejection', async (t) => {
  const ui = await loadUi()
  const { navigations } = browser(t)
  t.mock.method(globalThis, 'fetch', async (url) => new Response(null, { status: url === '/api/auth/signout' ? 200 : 403 }))
  await assert.rejects(ui.fetchUi('/api/prompt'), { status: 403 })
  await ui.signOutAccount(() => {})
  assert.deepEqual(navigations, ['/'])
})

test('failed signout keeps private state hidden, reports failure and permits an explicit retry', async (t) => {
  const ui = await loadUi()
  const local = storage([['fx0-history', 'private']])
  const { navigations } = browser(t, local)
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }))
  let cleared = 0
  await assert.rejects(ui.signOutAccount(() => { cleared++ }), /Unable to sign out/)
  assert.equal(cleared, 1)
  assert.equal(local.length, 0)
  assert.deepEqual(navigations, [])
  assert.match(document.cookie, /fx0-signout-pending=1/, 'failure preserves logout intent for reload/retry')
  await assert.rejects(ui.fetchUi('/api/sessions'), { status: 401 })
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }))
  await ui.signOutAccount(() => { cleared++ })
  assert.equal(cleared, 2)
  assert.deepEqual(navigations, ['/'])
})

test('optimistic signout hides private state synchronously while the server response is unresolved', async (t) => {
  const ui = await loadUi()
  const local = storage([['fx0-history', 'private']])
  const { navigations } = browser(t, local)
  const response = Promise.withResolvers()
  const fetch = t.mock.method(globalThis, 'fetch', () => response.promise)
  let cleared = false
  const pending = ui.signOutAccount(() => { cleared = true })
  assert.equal(cleared, true, 'the click must clear the UI without awaiting fetch')
  assert.match(document.cookie, /fx0-signout-pending=1/, 'a refresh must carry logout intent before the POST finishes')
  assert.doesNotMatch(document.cookie, /fx0-signed-in=1/, 'first paint must also reflect the logout')
  assert.equal(local.length, 0)
  assert.deepEqual(navigations, [], 'do not reload while cookies still carry the old session')
  await assert.rejects(ui.fetchUi('/api/prompt'), { status: 401 })
  assert.equal(fetch.mock.callCount(), 1)
  response.resolve(new Response(null, { status: 200 }))
  await pending
  assert.deepEqual(navigations, ['/'])
})

test('signout aborts in-flight private requests and rejects a late response even when fetch ignores abort', async (t) => {
  const ui = await loadUi()
  browser(t)
  const response = Promise.withResolvers()
  let signal
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (url === '/api/auth/signout') return Promise.resolve(new Response(null, { status: 503 }))
    signal = init.signal
    return response.promise
  })
  const request = ui.fetchUi('/api/sessions')
  const rejected = assert.rejects(request, { status: 401 })
  assert.equal(signal.aborted, false)
  await assert.rejects(ui.signOutAccount(() => {}), /Unable to sign out/)
  assert.equal(signal.aborted, true)
  response.resolve(Response.json({ sessions: ['private'] }))
  await rejected
})

test('invalidating private caches discards a response whose body finishes after signout', async (t) => {
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === './auth-ui' && context.parentURL?.includes('/components/cached-fetch.ts')) {
      return next(new URL('../components/auth-ui.ts', import.meta.url).href, context)
    }
    return next(specifier, context)
  } })
  t.after(() => hook.deregister())
  const cache = await import('../components/cached-fetch.ts')
  browser(t)
  const body = Promise.withResolvers()
  const reading = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json() { reading.resolve(); return body.promise } }))
  const pending = cache.loadCached('fx0:cache:teams:owner', '/api/teams', 0)
  await reading.promise
  cache.invalidateCached('fx0:')
  body.resolve({ teams: ['private team'] })
  assert.equal(await pending, null)
  assert.equal(cache.readCached('fx0:cache:teams:owner'), null)
  assert.equal(window.sessionStorage.getItem('fx0:cache:teams:owner'), null)
})

test('event stream preserves split UTF-8, LF/CRLF frames and multiline SSE data', async () => {
  const ui = await loadUi()
  const wire = ': keepalive\r\n\r\ndata: {"type":"text","delta":"Diseño"}\r\n\r\ndata: first\ndata: second\n\n'
  const bytes = new TextEncoder().encode(wire)
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
  const frames = []
  await ui.readEventStream(new Response(body), (data) => frames.push(data))
  assert.deepEqual(frames, ['{"type":"text","delta":"Diseño"}', 'first\nsecond'])
  assert.equal(body.locked, false)
})

test('event stream releases the reader if ingestion fails', async () => {
  const ui = await loadUi()
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: event\n\n')) },
    cancel() { cancelled = true },
  })
  await assert.rejects(ui.readEventStream(new Response(body), () => { throw new Error('Failed ingestion') }), /Failed ingestion/)
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
})

test('event stream reports missing response bodies', async () => {
  const ui = await loadUi()
  await assert.rejects(ui.readEventStream(new Response(null), () => {}), /unavailable/)
})
