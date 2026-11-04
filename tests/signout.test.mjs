import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextRequest } from 'next/server.js'
import { sealData } from 'iron-session'

const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/lib/turn-credential.ts') && specifier === './journal.ts') {
    return { url: dataUrl('export const prefixed = key => "signout-test:" + key; export const redis = () => globalThis.__signoutFixture.redis'), shortCircuit: true }
  }
  if (specifier === '@/lib/agent') {
    return { url: dataUrl('export async function cancelUserRuntime(...args) { const f = globalThis.__signoutFixture; f.cancellations.push(args); await f.cleanup(args[1]) }'), shortCircuit: true }
  }
  if (specifier.startsWith('@/lib/')) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context)
  if (specifier === 'next/server' && context.parentURL?.endsWith('/api/auth/signout/route.ts')) {
    return { url: dataUrl(`export * from ${JSON.stringify(import.meta.resolve('next/server.js'))}; export function after(work) { globalThis.__signoutFixture.after.push(work) }`), shortCircuit: true }
  }
  return next(specifier, context)
} })

const secure = await import('../lib/secure-session.ts')
const credentials = await import('../lib/turn-credential.ts')
// The credential a turn's model requests would bill, or null when nothing may.
const credentialOf = async (chatId, turnId) => {
  const funding = await credentials.readExecutionFunding(chatId, turnId)
  return funding.ok ? funding.credential : null
}
const { POST: signout } = await import('../app/api/auth/signout/route.ts')

const session = (loginId) => ({
  loginId, loginAt: Date.now(), userId: 'same-owner', email: 'synthetic@example.invalid',
  accessToken: `synthetic-${loginId}`, teamId: 'team_synthetic',
  expiresAt: Date.now() + 3_600_000, isLoggedIn: true,
})

function fixture(t) {
  const values = new Map(), indices = new Map(), hashes = new Map()
  const state = { after: [], cancellations: [], commands: [], values, fail: null,
    revokeGate: null, revokeStarted: null, saveGate: null, saveStarted: null,
    cleanup: credentials.dropLoginCredentials }
  const redis = {
    pipeline() {
      const work = []
      const pipeline = {}
      let deletes = false
      const drop = (key) => Number(values.delete(key) | indices.delete(key) | hashes.delete(key))
      // Sign-out's compare-and-delete script: KEYS[2..], and KEYS[1] only while
      // it holds ARGV[1]. tests/turn-credential.integration.mjs runs the real Lua.
      pipeline.eval = (_script, keys, args) => {
        deletes = true
        work.push(() => [keys.slice(1).reduce((count, key) => count + drop(key), 0), args[0] !== '' && values.get(keys[0]) === args[0] ? drop(keys[0]) : 0])
        return pipeline
      }
      pipeline.del = (...keys) => { deletes = true; work.push(() => keys.reduce((count, key) => count + drop(key), 0)); return pipeline }
      for (const [name, execute] of Object.entries({
        set: (key, value) => values.set(key, value),
        sadd: (key, value) => indices.set(key, [...(indices.get(key) ?? []), value]),
        expire: () => 1,
        get: (key) => values.get(key) ?? null,
        hgetall: (key) => hashes.get(key) ?? null,
        hlen: (key) => Object.keys(hashes.get(key) ?? {}).length,
        hget: (key, field) => hashes.get(key)?.[field] ?? null,
        hset: (key, entries) => hashes.set(key, { ...(hashes.get(key) ?? {}), ...entries }),
      })) pipeline[name] = (...args) => { work.push(() => execute(...args)); return pipeline }
      pipeline.exec = async () => {
        state.commands.push('pipeline')
        state.saveStarted?.resolve()
        if (state.saveGate) await state.saveGate.promise
        if (deletes && state.fail === 'delete') throw new Error('synthetic delete failure')
        return work.map((execute) => execute())
      }
      return pipeline
    },
    async get(key) {
      state.commands.push('get')
      if (state.fail === 'revocation-read' && key.includes(':revoked-login:')) throw new Error('synthetic revocation read failure')
      return values.get(key) ?? null
    },
    async set(key, value) {
      state.commands.push('set')
      state.revokeStarted?.resolve()
      if (state.revokeGate) await state.revokeGate.promise
      if (state.fail === 'revoke') throw new Error('synthetic revocation write failure')
      values.set(key, value)
      return 'OK'
    },
    async smembers(key) {
      state.commands.push('smembers')
      if (state.fail === 'read') throw new Error('synthetic read failure')
      return indices.get(key) ?? []
    },
    async del(...keys) {
      state.commands.push('del')
      if (state.fail === 'delete') throw new Error('synthetic delete failure')
      for (const key of keys) { values.delete(key); indices.delete(key); hashes.delete(key) }
      return keys.length
    },
  }
  state.redis = redis
  globalThis.__signoutFixture = state
  t.after(() => { delete globalThis.__signoutFixture })
  const env = { SESSION_SECRET: 'signout-test-password-at-least-32-characters', APP_URL: 'https://signout.example',
    VERCEL_OAUTH_CLIENT_ID: 'synthetic-client', VERCEL_OAUTH_CLIENT_SECRET: 'synthetic-secret' }
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  return state
}

async function request(session, pending = false) {
  const grant = await secure.sealSessionCookie(session)
  return new NextRequest('https://signout.example/api/auth/signout', { method: 'POST', headers: {
    origin: 'https://signout.example', cookie: `${secure.SESSION_COOKIE_NAME}=${session.loginId}; ${grant.cookieName}=${grant.value}${pending ? '; fx0-signout-pending=1' : ''}`,
  } })
}

test('logout waits for one durable revocation write, then returns before cleanup or OAuth', async (t) => {
  const state = fixture(t)
  const laptop = session('a'.repeat(32)), phone = session('b'.repeat(32))
  await credentials.saveTurnCredential('laptop-chat', laptop, 1)
  await credentials.saveTurnCredential('phone-chat', phone, 1)
  state.commands.length = 0
  state.revokeStarted = Promise.withResolvers()
  state.revokeGate = Promise.withResolvers()
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }))
  let responded = false
  const pending = request(laptop).then(signout).then((response) => { responded = true; return response })
  await state.revokeStarted.promise
  assert.equal(responded, false, 'revocation must be confirmed before success')
  assert.equal(state.after.length, 0)
  assert.equal(fetch.mock.callCount(), 0)
  state.revokeGate.resolve()
  const response = await pending
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { success: true })
  assert.deepEqual(state.commands, ['set'], 'no chat enumeration, credential read or deletion on the response path')
  assert.ok(state.values.has('signout-test:credential:laptop-chat'), 'cleanup has not run yet')
  assert.equal(await credentials.readTurnCredential('laptop-chat'), null)
  assert.deepEqual(await credentials.readExecutionFunding('laptop-chat', 1), { ok: false, refused: 'revoked' })
  assert.equal((await credentialOf('phone-chat', 1)).loginId, phone.loginId)
  assert.equal(fetch.mock.callCount(), 0, 'provider revocation does not block success')
  assert.equal(state.cancellations.length, 0)
  assert.equal(response.headers.get('clear-site-data'), null, 'Clear-Site-Data stalls Chrome for seconds; previews revalidate instead')
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${secure.grantCookieName(laptop.loginId)}=`) && cookie.includes('Max-Age=0')))
  await state.after[0]()
  assert.deepEqual(state.cancellations, [[laptop.userId, laptop.loginId]])
  assert.equal(state.values.has('signout-test:credential:laptop-chat'), false)
  assert.equal(fetch.mock.callCount(), 1, 'provider failure cannot restore the deleted credential')
  assert.equal(await credentialOf('laptop-chat', 1), null)
})

for (const hasChats of [false, true]) test(`logout erases the login-wide credential with ${hasChats ? 'existing' : 'no'} chats and preserves another login`, async (t) => {
  const state = fixture(t)
  const laptop = session('a'.repeat(32)), phone = session('b'.repeat(32))
  if (hasChats) {
    await credentials.saveTurnCredential('laptop-chat', laptop, 1)
    await credentials.saveTurnCredential('phone-chat', phone, 1)
  }
  const headKey = (login) => `signout-test:auth:credential:${login.loginId}`
  for (const login of [laptop, phone]) {
    const key = headKey(login)
    state.values.set(key, await sealData({ key, userId: login.userId, loginId: login.loginId, loginAt: login.loginAt,
      accessToken: login.accessToken, refreshToken: `synthetic-refresh-${login.loginId}`, expiresAt: login.expiresAt,
      validUntil: Date.now() + 30 * 24 * 3600_000 }, { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 }))
  }
  const phoneHead = state.values.get(headKey(phone))
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }))
  const response = await signout(await request(laptop))
  assert.equal(response.status, 200)
  assert.equal(await credentials.loginRevoked(laptop.loginId), true, 'revocation precedes background cleanup')
  assert.equal(state.values.has(headKey(laptop)), true, 'head deletion does not delay the logout response')
  await state.after[0]()
  assert.equal(state.values.has(headKey(laptop)), false, 'successful cleanup erases the encrypted access and refresh tokens')
  assert.equal(state.values.get(headKey(phone)) === phoneHead, true, 'another login of the same user keeps its exact credential')
  assert.equal(await credentials.loginRevoked(laptop.loginId), true, 'the permanent tombstone survives credential deletion')
  assert.equal(await credentials.loginRevoked(phone.loginId), false)
  if (hasChats) {
    assert.equal(await credentialOf('laptop-chat', 1), null)
    assert.equal((await credentialOf('phone-chat', 1)).loginId, phone.loginId)
  }
})

test('pending logout hides the old grant from normal readers but still revokes it on retry', async (t) => {
  const state = fixture(t)
  const incoming = await request(session('c'.repeat(32)), true)
  assert.deepEqual(await secure.getSessionFromRequest(incoming), {})
  assert.deepEqual(await secure.getGrantFromRequest(incoming), {}, 'pending logout cannot renew tokens')
  assert.deepEqual(state.commands, [], 'hiding the account requires no Redis wait')
  const response = await signout(incoming)
  assert.equal(response.status, 200)
  assert.deepEqual(state.commands, ['set'], 'logout must not mistake the pending session for anonymous')
  assert.ok(state.values.has(`signout-test:revoked-login:${'c'.repeat(32)}`))
  assert.ok(response.headers.getSetCookie().some(cookie => cookie.startsWith('fx0-signout-pending=;') && cookie.includes('Max-Age=0')))
})

test('logout retains cookies and allows retry if the durable revocation write fails', async (t) => {
  const state = fixture(t)
  const user = session('a'.repeat(32))
  await credentials.saveTurnCredential('active-chat', user, 1)
  const incoming = await request(user, true)
  state.fail = 'revoke'
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('No external revocation on failed logout'))
  const response = await signout(incoming)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '5')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(response.headers.getSetCookie(), [])
  assert.deepEqual(await secure.getSessionFromRequest(incoming), {}, 'failed revocation must still hide the account on reload')
  assert.equal(response.headers.get('clear-site-data'), null)
  assert.equal((await response.json()).success, undefined)
  assert.equal((await credentialOf('active-chat', 1)).loginId, user.loginId)
  assert.equal(state.after.length, 0)
  assert.equal(fetch.mock.callCount(), 0)
  state.fail = null
  assert.equal((await signout(incoming)).status, 200)
  assert.equal(await credentialOf('active-chat', 1), null)
})

for (const failure of ['read', 'delete']) test(`revoked credentials stay unusable when background cleanup ${failure} and OAuth fail`, async (t) => {
  const state = fixture(t)
  const laptop = session('a'.repeat(32)), phone = session('b'.repeat(32))
  // A chat from before per-turn funding holds only its latest credential.
  await credentials.renewLatestCredential('legacy-chat', laptop)
  await credentials.saveTurnCredential('shared-chat', laptop, 1)
  await credentials.saveTurnCredential('shared-chat', phone, 2)
  state.fail = failure
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }))
  assert.equal((await signout(await request(laptop))).status, 200)
  await assert.rejects(state.after[0](), /synthetic/)
  assert.equal(await credentials.readTurnCredential('legacy-chat'), null)
  assert.equal(await credentialOf('legacy-chat'), null)
  assert.equal(await credentialOf('shared-chat', 1), null, 'exact-turn fallback is fenced')
  assert.equal((await credentialOf('shared-chat', 2)).loginId, phone.loginId)
  assert.equal((await credentials.readTurnCredential('shared-chat')).loginId, phone.loginId)
  await assert.rejects(credentials.saveTurnCredential('new-chat', laptop, 1), /Signed out/)
  await assert.rejects(credentials.renewLatestCredential('legacy-chat', { ...laptop, expiresAt: laptop.expiresAt + 3600_000 }), /Signed out/)
})

test('a save admitted before logout cannot resurrect execution credentials after revocation', async (t) => {
  const state = fixture(t)
  const user = session('a'.repeat(32))
  state.saveStarted = Promise.withResolvers()
  state.saveGate = Promise.withResolvers()
  const pending = credentials.saveTurnCredential('late-chat', user, 1)
  await state.saveStarted.promise
  assert.equal((await signout(await request(user))).status, 200)
  state.saveGate.resolve()
  await pending
  assert.ok(state.values.has('signout-test:credential:late-chat'), 'the delayed write really completed')
  assert.equal(await credentials.readTurnCredential('late-chat'), null)
  assert.equal(await credentialOf('late-chat', 1), null)
})

test('execution fails closed if the revocation check is unavailable', async (t) => {
  const state = fixture(t)
  const user = session('a'.repeat(32))
  await credentials.saveTurnCredential('active-chat', user, 1)
  state.fail = 'revocation-read'
  await assert.rejects(credentials.readTurnCredential('active-chat'), /revocation read failure/)
  await assert.rejects(credentialOf('active-chat', 1), /revocation read failure/)
})

test('anonymous logout clears cookies without requiring a configured credential store', async (t) => {
  const state = fixture(t)
  state.fail = 'read'
  const response = await signout(new NextRequest('https://signout.example/api/auth/signout', {
    method: 'POST', headers: { origin: 'https://signout.example' },
  }))
  assert.equal(response.status, 200)
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${secure.SESSION_COOKIE_NAME}=`) && cookie.includes('Max-Age=0')))
})
