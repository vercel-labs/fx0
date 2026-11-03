import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { createHash, createHmac } from 'node:crypto'
import { sealData, unsealData } from 'iron-session'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { NextRequest } from 'next/server.js'

// Route handlers use the application's alias; source tests do not run Next's
// bundler. This only resolves paths, not replacement implementations.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/turn-credential' && context.parentURL?.endsWith('/api/auth/signout/route.ts')) return { url: 'data:text/javascript,export async function revokeLoginCredentials() {}', shortCircuit: true }
  // Session readers check sign-out revocation in the credential store's Redis;
  // these tests hold it in memory (globalThis.__revokedLogins).
  if (specifier === './turn-credential.ts' && /\/lib\/(auth|request-session)\.ts$/.test(context.parentURL ?? '')) {
    return { url: `data:text/javascript,${encodeURIComponent('export async function loginRevoked(id) { const r = globalThis.__revokedLogins; r.checks.push(id); if (r.fail) throw new Error("synthetic revocation read failure"); return r.ids.has(id) }')}`, shortCircuit: true }
  }
  // Pages read cookies from next/headers; a test hands them a request's jar.
  if (specifier === 'next/headers.js' && context.parentURL?.endsWith('/lib/secure-session.ts')) {
    return { url: `data:text/javascript,${encodeURIComponent('export async function cookies() { return globalThis.__pageCookies ?? new Map() }')}`, shortCircuit: true }
  }
  if (specifier === '@/lib/agent') return { url: 'data:text/javascript,export async function cancelUserRuntime(id) { globalThis.__signedOutUser = id }', shortCircuit: true }
  if (specifier.startsWith('@/lib/')) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context)
  // after() needs a Next request scope; the sign-out's follow-up runs at once and tests await it.
  if (specifier === 'next/server' && context.parentURL?.endsWith('/api/auth/signout/route.ts')) {
    return { url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(import.meta.resolve('next/server.js'))}; export function after(work) { globalThis.__signoutAfter = Promise.resolve().then(work) }`)}`, shortCircuit: true }
  }
  if (specifier === 'next/server') return next('next/server.js', context)
  if (specifier.startsWith('.') && context.parentURL?.startsWith(new URL('../', import.meta.url).href) &&
      !context.parentURL.includes('/node_modules/')) {
    const target = new URL(specifier, context.parentURL)
    if (!/\.[cm]?[jt]sx?$/.test(target.pathname)) return next(target.href + '.ts', context)
  }
  return next(specifier, context)
} })

process.env.SESSION_SECRET = 'deterministic-auth-test-secret-at-least-32-characters'
process.env.VERCEL_OAUTH_CLIENT_ID = 'auth-test-client'
process.env.VERCEL_OAUTH_CLIENT_SECRET = 'auth-test-client-secret'
process.env.APP_URL = 'https://fx0.example'
process.env.KV_REST_API_URL = 'https://auth-redis.example'
process.env.KV_REST_API_TOKEN = 'test-only-redis-token'

const authCrypto = await import('../lib/auth-crypto.ts')
const expectedLogTag = (kind, value, secret = process.env.SESSION_SECRET) => {
  const key = createHmac('sha256', secret).update('fx0:auth-log-key:v1').digest()
  return createHmac('sha256', key).update(kind).update('\0').update(value).digest('hex').slice(0, 24)
}
const protocol = await import('../lib/auth-protocol.ts')
const secure = await import('../lib/secure-session.ts')
const auth = await import('../lib/auth.ts')
const { withRequestSession } = await import('../lib/request-session.ts')
const { withChatRoute, withUserRoute } = await import('../lib/route-auth.ts')
const noRevocations = () => ({ ids: new Set(), checks: [], fail: false })
globalThis.__revokedLogins = noRevocations()
// Logins sign-out has revoked, for one test.
function revocations(t) {
  const revoked = noRevocations()
  globalThis.__revokedLogins = revoked
  t.after(() => { globalThis.__revokedLogins = noRevocations() })
  return revoked
}
const handledRequests = new WeakMap()
async function requestSession(request) {
  let handled
  const response = await withRequestSession((forwarded, session) => {
    handled = { request: forwarded, session }
    return new Response(null)
  })(request)
  if (handled) handledRequests.set(response, handled)
  return response
}
const { GET: signin } = await import('../app/api/auth/signin/route.ts')
const { POST: signout } = await import('../app/api/auth/signout/route.ts')
const { GET: me } = await import('../app/api/auth/me/route.ts')
const { AuthError } = await import('../lib/accounts.ts')

const session = (extra = {}) => ({
  loginId: '11111111111111111111111111111111', loginAt: 1_750_000_000_000,
  userId: 'verified-sub', email: 'user@example.com', name: 'Test User', picture: 'https://example.com/avatar.png',
  accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 60_000,
  teamId: 'team_granted', teamSlug: 'granted', isLoggedIn: true, ...extra,
})
const tokenResponse = (extra = {}) => ({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, ...extra })

function refreshCache() {
  const values = new Map()
  const locks = new Map()
  const operations = []
  let reportContention
  const contended = new Promise((resolve) => { reportContention = resolve })
  const cache = {
    async get(key) {
      const entry = values.get(key)
      return entry && entry.until > Date.now() ? entry.value : null
    },
    async acquire(key, owner, ttl) {
      operations.push(['acquire', key, owner, ttl])
      if (locks.get(key)?.until > Date.now()) { reportContention(); return false }
      locks.set(key, { owner, until: Date.now() + ttl * 1000 })
      return true
    },
    async publish(key, owner, value, ttl) {
      operations.push(['publish', key, value, ttl])
      const lock = locks.get(key)
      if (lock?.owner !== owner || lock.until <= Date.now()) return false
      values.set(key, { value, until: Date.now() + ttl * 1000 })
      locks.delete(key)
      return true
    },
    async release(key, owner) {
      operations.push(['release', key, owner])
      if (locks.get(key)?.owner === owner) locks.delete(key)
    },
  }
  return { cache, values, locks, operations, contended }
}

async function requestWithSession(path, data, extraHeaders = {}) {
  const sealed = await secure.sealSessionCookie(data)
  return new NextRequest(`https://fx0.example${path}`, { headers: {
    cookie: `theme=dark; ${protocol.SESSION_COOKIE_NAME}=${data.loginId}; ${sealed.cookieName}=${sealed.value}`,
    ...extraHeaders,
  } })
}

function forwardedRequest(response, path = '/api/prompt') {
  return new NextRequest(`https://fx0.example${path}`, { headers: {
    cookie: handledRequests.get(response).request.headers.get('cookie') ?? '',
  } })
}

test('log fingerprints are 96-bit keyed tags separated by data kind, without changing storage hashes', (t) => {
  const secret = process.env.SESSION_SECRET
  t.after(() => { process.env.SESSION_SECRET = secret })
  const value = 'synthetic-correlation-value'
  const kinds = ['user', 'login', 'refresh', 'cookie', 'page']
  const tags = kinds.map((kind) => authCrypto.logTag(kind, value))
  assert.equal(new Set(tags).size, kinds.length, 'the same value cannot be linked across different data kinds')
  for (const [index, kind] of kinds.entries()) {
    assert.match(tags[index], /^[a-f0-9]{24}$/)
    assert.equal(tags[index], expectedLogTag(kind, value))
    assert.equal(authCrypto.logTag(kind, value), tags[index], 'correlation is deterministic with the same private key')
  }
  const publicHash = createHash('sha256').update(value).digest('hex')
  assert.equal(authCrypto.hashHandle(value), publicHash)
  assert.ok(!tags.includes(publicHash.slice(0, 24)), 'log tags cannot be calculated with an unkeyed public hash')
  const directMasterMac = createHmac('sha256', secret).update('user\0' + value).digest('hex').slice(0, 24)
  assert.notEqual(tags[0], directMasterMac, 'logging uses its own purpose-derived subkey')
  process.env.SESSION_SECRET = 'another-synthetic-session-secret-at-least-32-characters'
  assert.notEqual(authCrypto.logTag('user', value), tags[0], 'private-key rotation also changes log identifiers')
  assert.equal(authCrypto.hashHandle(value), publicHash, 'key rotation must not change Redis or CAS fingerprints')
})

test('missing or invalid log key omits fingerprints without falling back to raw or unkeyed identifiers', (t) => {
  const secret = process.env.SESSION_SECRET
  t.after(() => { process.env.SESSION_SECRET = secret })
  for (const unavailable of [undefined, '', 'too-short']) {
    if (unavailable === undefined) delete process.env.SESSION_SECRET
    else process.env.SESSION_SECRET = unavailable
    for (const kind of ['user', 'login', 'refresh', 'cookie', 'page']) {
      assert.equal(authCrypto.logTag(kind, 'do-not-log-this-value'), null)
    }
    assert.equal(authCrypto.hashHandle('storage-value'), createHash('sha256').update('storage-value').digest('hex'))
  }
})

test('singleflight plus cross-instance lease performs one exchange and encrypts the 120s result', async () => {
  const store = refreshCache()
  let calls = 0
  let release
  let started
  const gate = new Promise((resolve) => { release = resolve })
  const fetching = new Promise((resolve) => { started = resolve })
  const fetcher = async (_url, options) => {
    calls++
    assert.equal(options.body.get('refresh_token'), 'old-refresh')
    assert.equal(options.body.get('grant_type'), 'refresh_token')
    assert.ok(options.signal instanceof AbortSignal)
    started()
    await gate
    return Response.json(tokenResponse())
  }
  const firstInstance = auth.createRefreshCoordinator({ fetch: fetcher, cache: store.cache })
  const secondInstance = auth.createRefreshCoordinator({ fetch: fetcher, cache: store.cache })
  const first = firstInstance('old-refresh')
  const sameInstance = firstInstance('old-refresh')
  assert.equal(first, sameInstance)
  await fetching
  const otherInstance = secondInstance('old-refresh')
  await store.contended
  release()
  const results = await Promise.all([first, sameInstance, otherInstance])
  assert.equal(calls, 1)
  assert.deepEqual(results[0], results[2])
  assert.equal(results[0].status, 'ok')
  assert.deepEqual(await secondInstance('old-refresh'), results[0])
  assert.equal(calls, 1)
  const [key, entry] = [...store.values][0]
  assert.ok(key.endsWith(createHash('sha256').update('old-refresh').digest('hex')))
  assert.ok(!key.includes('old-refresh'))
  assert.ok(!entry.value.includes('rotated-access') && !entry.value.includes('rotated-refresh'))
  assert.equal(store.operations[0][3], 30)
  assert.equal(store.operations.find((op) => op[0] === 'publish')[3], 120)
  const decoded = await unsealData(entry.value, { password: process.env.SESSION_SECRET, ttl: 120 })
  assert.equal(decoded.key, key)
  assert.deepEqual(decoded.result, results[0])
})

test('refresh preserves identity/team/payload and the old refresh token when no rotation is supplied', async () => {
  const refresh = auth.createRefreshCoordinator({ fetch: async () => Response.json(tokenResponse({ refresh_token: undefined })), cache: refreshCache().cache })
  const before = session({ customFutureField: 'keep-me' })
  const result = await refresh(before.refreshToken)
  assert.equal(result.status, 'ok')
  const after = auth.sessionWithRefresh(before, result)
  assert.deepEqual(after, { ...before, accessToken: 'rotated-access', expiresAt: result.expiresAt })
  assert.equal(after.teamId, 'team_granted')
  const cookie = await secure.sealSessionCookie(after)
  const decoded = await secure.getSessionFromRequest(new NextRequest('https://fx0.example', { headers: {
    cookie: `${secure.SESSION_COOKIE_NAME}=${after.loginId}; ${cookie.cookieName}=${cookie.value}`,
  } }))
  assert.deepEqual(decoded, after)
})

test('an in-app team choice overrides the grant team only for the login that made it', async () => {
  const data = session()
  const grant = await secure.sealSessionCookie(data)
  const read = (choice) => secure.getSessionFromRequest(new NextRequest('https://fx0.example', { headers: {
    cookie: `${secure.SESSION_COOKIE_NAME}=${data.loginId}; ${grant.cookieName}=${grant.value}` +
      (choice ? `; ${secure.TEAM_COOKIE_NAME}=${choice}` : ''),
  } }))
  const chosen = await secure.teamCookie(data.loginId, { teamId: 'team_chosen', teamSlug: 'chosen' })
  const decoded = await read(chosen.value)
  assert.equal(decoded.teamId, 'team_chosen')
  assert.equal(decoded.teamSlug, 'chosen')
  assert.equal(decoded.accessToken, data.accessToken)
  const otherLogin = await secure.teamCookie('f'.repeat(32), { teamId: 'team_chosen', teamSlug: 'chosen' })
  assert.equal((await read(otherLogin.value)).teamId, data.teamId)
  assert.equal((await read('forged')).teamId, data.teamId)
  assert.equal((await read()).teamId, data.teamId)
})

test('only exact OAuth invalid_grant is terminal; transient/malformed/config failures preserve grant', async () => {
  for (const [fetcher, status] of [
    [async () => Response.json({ error: 'invalid_grant' }, { status: 400 }), 'terminal'],
    [async () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }), 'transient'],
    [async () => Response.json({ error: 'invalid_grant' }, { status: 503 }), 'transient'],
    [async () => new Response('invalid_grant is mentioned here', { status: 400 }), 'transient'],
    [async () => Response.json({ access_token: '', expires_in: 3600 }), 'transient'],
    [async () => Response.json(tokenResponse({ expires_in: -1 })), 'transient'],
    [async () => { throw new Error('network failed') }, 'transient'],
  ]) {
    const refresh = auth.createRefreshCoordinator({ fetch: fetcher, cache: refreshCache().cache })
    assert.equal((await refresh('old-refresh')).status, status)
  }
  const prior = process.env.VERCEL_OAUTH_CLIENT_SECRET
  delete process.env.VERCEL_OAUTH_CLIENT_SECRET
  try {
    const refresh = auth.createRefreshCoordinator({ fetch: async () => assert.fail('must not exchange without client secret'), cache: refreshCache().cache })
    assert.equal((await refresh('old-refresh')).status, 'transient')
  } finally { process.env.VERCEL_OAUTH_CLIENT_SECRET = prior }
})

test('a transient exchange is never replayed: the lease is released and the next request on any instance retries', async () => {
  const store = refreshCache()
  const outcomes = [Response.json({ error: 'temporarily_unavailable' }, { status: 503 }), Response.json(tokenResponse())]
  let exchanges = 0
  const fetcher = async () => { exchanges++; return outcomes.shift() }
  const first = auth.createRefreshCoordinator({ fetch: fetcher, cache: store.cache })
  const second = auth.createRefreshCoordinator({ fetch: fetcher, cache: store.cache })
  assert.deepEqual(await first('blip-refresh'), { status: 'transient' })
  assert.equal(store.values.size, 0, 'a transient failure is not published')
  assert.equal(store.locks.size, 0, 'the lease is released at once, not at its TTL')
  const recovered = await second('blip-refresh')
  assert.equal(recovered.status, 'ok')
  assert.equal(exchanges, 2)
  assert.deepEqual(store.operations.map(([name]) => name), ['acquire', 'release', 'acquire', 'publish'])
})

test('a transient result cached by an older build is ignored rather than replayed', async () => {
  const store = refreshCache()
  const key = `fx0:v1:auth:refresh:${createHash('sha256').update('legacy-refresh').digest('hex')}`
  const sealed = await sealData({ key, result: { status: 'transient' }, expiresAt: Date.now() + 120_000 },
    { password: process.env.SESSION_SECRET, ttl: 120 })
  store.values.set(key, { value: sealed, until: Date.now() + 120_000 })
  let exchanges = 0
  const refresh = auth.createRefreshCoordinator({ fetch: async () => { exchanges++; return Response.json(tokenResponse()) }, cache: store.cache })
  assert.equal((await refresh('legacy-refresh')).status, 'ok')
  assert.equal(exchanges, 1)
})

test('Redis failure never falls back to an uncoordinated provider exchange', async () => {
  const store = refreshCache()
  store.cache.get = async () => { throw new Error('Redis unavailable') }
  const refresh = auth.createRefreshCoordinator({ fetch: async () => assert.fail('no exchange without lease'), cache: store.cache })
  assert.deepEqual(await refresh('old-refresh'), { status: 'transient' })
})

test('a held lease waits only for a bounded result and never exchanges the stale token', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  let reads = 0
  const refresh = auth.createRefreshCoordinator({
    fetch: async () => assert.fail('lease is owned by another instance'),
    cache: {
      get: async () => { if (++reads > 1) t.mock.timers.setTime(Date.now() + 12_000); return null },
      acquire: async () => false,
      publish: async () => assert.fail('no result to publish'),
    },
  })
  assert.deepEqual(await refresh('locked-refresh'), { status: 'transient' })
  assert.equal(reads, 2)
})

test('a cache publication outage does not discard the newly rotated token', async () => {
  const store = refreshCache()
  store.cache.publish = async () => { throw new Error('Redis publication failed') }
  const refresh = auth.createRefreshCoordinator({ fetch: async () => Response.json(tokenResponse()), cache: store.cache })
  const result = await refresh('old-refresh')
  assert.equal(result.status, 'ok')
  assert.equal(result.tokens.refresh_token, 'rotated-refresh')
  assert.equal(store.locks.size, 1) // Leave the protective lease until its TTL.
})

test('sealed result cannot be replayed under another refresh-token hash', async () => {
  const store = refreshCache()
  const good = auth.createRefreshCoordinator({ fetch: async () => Response.json(tokenResponse()), cache: store.cache })
  await good('old-refresh')
  const value = [...store.values.values()][0].value
  store.cache.get = async () => value
  const other = auth.createRefreshCoordinator({ fetch: async () => assert.fail('tampered result must fail closed'), cache: store.cache })
  assert.deepEqual(await other('different-refresh'), { status: 'transient' })
})

test('90-day cookie and seal TTL match; production flags, encrypted payload, clear, and tamper rejection', async () => {
  const before = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const options = secure.getSessionOptions()
    assert.equal(options.ttl, 90 * 24 * 60 * 60)
    assert.equal(options.ttl, options.cookieOptions.maxAge)
    const data = session()
    const cookie = await secure.sealSessionCookie(data)
    assert.match(cookie.setCookie, /HttpOnly/i)
    assert.match(cookie.setCookie, /Secure/i)
    assert.match(cookie.setCookie, /SameSite=Lax/i)
    assert.match(cookie.setCookie, /Max-Age=7776000/i)
    assert.ok(!cookie.value.includes(data.accessToken))
    // Iron's encrypted seal carries its expiration as its sixth component.
    const sealExpiration = Number(cookie.value.split('*')[5])
    assert.ok(Math.abs(sealExpiration - (Date.now() + options.ttl * 1000)) < 2000)
    const cleared = await secure.sealSessionCookie(null, data.loginId)
    assert.equal(cleared.cookieName, secure.grantCookieName(data.loginId))
    const selector = secure.selectorCookie(data.loginId)
    assert.equal(selector.cookieName, secure.SESSION_COOKIE_NAME)
    assert.equal(selector.value, data.loginId)
    for (const flag of [/HttpOnly/i, /Secure/i, /SameSite=Lax/i, /Max-Age=7776000/i]) assert.match(selector.setCookie, flag)
    assert.equal(cleared.value, '')
    assert.match(cleared.setCookie, /Max-Age=0/i)
    const tampered = `${cookie.value.slice(0, -6)}broken`
    const decoded = await secure.getSessionFromRequest(new NextRequest('https://fx0.example', { headers: {
      cookie: `${secure.SESSION_COOKIE_NAME}=${data.loginId}; ${cookie.cookieName}=${tampered}`,
    } }))
    assert.deepEqual(decoded, {})
  } finally {
    if (before === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = before
  }
})

test('readers require a valid selector, matching encrypted loginId and valid issuance fields', async () => {
  const data = session()
  const grant = await secure.sealSessionCookie(data)
  const read = (cookie) => secure.getSessionFromRequest(new NextRequest('https://fx0.example', { headers: { cookie } }))
  assert.deepEqual(await read(`${grant.cookieName}=${grant.value}`), {})
  assert.deepEqual(await read(`${secure.SESSION_COOKIE_NAME}=${grant.value}`), {}, 'legacy fixed credential cookies are not selectors')
  assert.deepEqual(await read(`${secure.SESSION_COOKIE_NAME}=bad-id; ${grant.cookieName}=${grant.value}`), {})
  const otherId = '22222222222222222222222222222222'
  assert.deepEqual(await read(`${secure.SESSION_COOKIE_NAME}=${otherId}; ${secure.grantCookieName(otherId)}=${grant.value}`), {})
  for (const extra of [
    { loginId: undefined }, { loginAt: undefined }, { loginAt: null }, { loginAt: 0 }, { loginAt: 'yesterday' },
    { loginAt: 1.5 }, { refreshToken: 123 }, { picture: {} }, { expiresAt: 0 },
  ]) {
    const bad = await sealData({ ...data, ...extra }, { password: process.env.SESSION_SECRET, ttl: secure.SESSION_TTL_SECONDS })
    assert.deepEqual(await read(`${secure.SESSION_COOKIE_NAME}=${data.loginId}; ${grant.cookieName}=${bad}`), {})
  }
  assert.equal(secure.isAuthenticatedSession({ ...data, loginAt: NaN }), false)
  await assert.rejects(secure.sealSessionCookie(data, otherId), /Invalid session payload/)
  await assert.rejects(secure.sealSessionCookie(null), /Invalid login ID/)
  assert.throws(() => secure.selectorCookie('bad-id'), /Invalid login ID/)
  assert.throws(() => protocol.forwardSessionCookie(new Headers(), secure.SESSION_COOKIE_NAME, null), /Only grant cookies/)
})

test('request cleanup bounds obsolete grant deletions and never touches selector or selected credentials', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('cookie cleanup must be local'))
  const request = await requestWithSession('/api/prompt', session({ expiresAt: Date.now() + 3600_000 }))
  const oldNames = Array.from({ length: 12 }, (_, i) => secure.grantCookieName((i + 1).toString(16).padStart(32, '0')))
  for (const name of oldNames) request.cookies.set(name, 'obsolete-seal-not-decrypted')
  request.cookies.set('vercel_auth_grant_not-a-login-id', 'unrelated')
  const response = await requestSession(request)
  const deletes = response.headers.getSetCookie()
  assert.equal(deletes.length, 8)
  assert.ok(deletes.every((value, i) => value.startsWith(`${oldNames[i]}=`) && value.includes('Max-Age=0')))
  const forwarded = forwardedRequest(response)
  assert.equal(forwarded.cookies.get(secure.SESSION_COOKIE_NAME).value, session().loginId)
  assert.equal((await secure.getSessionFromRequest(forwarded)).userId, 'verified-sub')
  assert.equal(forwarded.cookies.get('vercel_auth_grant_not-a-login-id').value, 'unrelated')
  for (const name of oldNames.slice(0, 8)) assert.equal(forwarded.cookies.has(name), false)
  for (const name of oldNames.slice(8)) assert.equal(forwarded.cookies.has(name), true)
  const loggedOut = new NextRequest('https://fx0.example/api/prompt', { headers: { cookie: `${oldNames[0]}=revived-by-late-refresh` } })
  const cleanup = await requestSession(loggedOut)
  assert.equal(cleanup.headers.getSetCookie().length, 1)
  assert.ok(!cleanup.headers.getSetCookie()[0].startsWith(`${secure.SESSION_COOKIE_NAME}=`))
  assert.deepEqual(await secure.getSessionFromRequest(forwardedRequest(cleanup)), {})
})

test('refresh floor covers 800s routes; ordinary requests refresh nothing and write no cookies', async (t) => {
  assert.equal(protocol.MIN_GATEWAY_VALIDITY_MS, 15 * 60_000)
  assert.ok(protocol.MIN_GATEWAY_VALIDITY_MS > 800 * 1000)
  const now = Date.now()
  assert.equal(auth.needsTokenRefresh(session({ expiresAt: now + protocol.MIN_GATEWAY_VALIDITY_MS + 1 }), now), false)
  assert.equal(auth.needsTokenRefresh(session({ expiresAt: now + protocol.MIN_GATEWAY_VALIDITY_MS }), now), true)
  const revoked = revocations(t)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('ordinary auth makes no refresh request'))
  const request = await requestWithSession('/api/prompt', session({ expiresAt: now + 3600_000 }))
  const response = await requestSession(request)
  assert.ok(handledRequests.has(response))
  assert.equal(response.headers.get('set-cookie'), null)
  assert.deepEqual(revoked.checks, [session().loginId], 'its one store read is the sign-out check')
  assert.deepEqual(await auth.resolveGrantedTeam(session()), { teamId: 'team_granted', teamSlug: 'granted' })
  assert.deepEqual((await (await me(request)).json()).user, auth.publicUser(session()))
  assert.deepEqual(Object.keys(auth.publicUser(session())), ['id', 'name', 'email', 'picture'])
  await assert.rejects(auth.resolveGrantedTeam(session({ teamId: undefined })), (error) => error instanceof AuthError && error.status === 403)
})

test('a signed-out login\'s grant replayed from a copy is no session for API routes: no refresh, and its cookie is cleared', async (t) => {
  const revoked = revocations(t)
  // Within the refresh floor: a live grant would refresh here.
  const grant = session({ expiresAt: Date.now() + 60_000 })
  revoked.ids.add(grant.loginId)
  // Refresh contains its own errors, so count requests rather than fail in one.
  const network = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500 }))
  const response = await requestSession(await requestWithSession('/api/prompt', grant))
  assert.equal(network.mock.callCount(), 0, 'a revoked grant never refreshes')
  assert.equal(response.status, 200)
  assert.deepEqual(handledRequests.get(response).session, {})
  const grantCookie = secure.grantCookieName(grant.loginId)
  assert.ok(response.headers.getSetCookie().some((value) => value.startsWith(`${grantCookie}=`) && value.includes('Max-Age=0')))
  assert.equal(forwardedRequest(response).cookies.has(grantCookie), false)
  assert.equal((await (await me(await requestWithSession('/api/auth/me', grant))).json()).user, null)
})

test('API routes fail closed when the sign-out check is unavailable', async (t) => {
  const revoked = revocations(t)
  revoked.fail = true
  const network = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500 }))
  const response = await requestSession(await requestWithSession('/api/prompt', session()))
  assert.equal(response.status, 503)
  assert.equal(handledRequests.has(response), false)
  assert.equal(network.mock.callCount(), 0, 'no refresh without the sign-out check')
})

test('pages read no session from a signed-out login\'s grant', async (t) => {
  const revoked = revocations(t)
  const grant = session({ expiresAt: Date.now() + 3600_000 })
  globalThis.__pageCookies = (await requestWithSession('/', grant)).cookies
  t.after(() => { delete globalThis.__pageCookies })
  assert.equal((await auth.requireUserSession()).loginId, grant.loginId)
  revoked.ids.add(grant.loginId)
  await assert.rejects(auth.requireUserSession(), (error) => error instanceof AuthError && error.status === 401)
  revoked.fail = true
  await assert.rejects(auth.requireUserSession(), /synthetic revocation read failure/, 'an unavailable check is no session either')
})

// In-memory REST endpoint exercises the REAL installed Redis adapter and request wrapper,
// not a replacement request wrapper. The separate coordinator tests inject only its cache
// and fetch boundary. No service credentials or remote requests are used.
const encodeRedisResult = (value) => typeof value === 'string' && value !== 'OK' ? Buffer.from(value).toString('base64') : value
const redisValues = new Map()
const redisExpirations = new Map()
test.beforeEach(() => { redisValues.clear(); redisExpirations.clear() })
function redisRest(options) {
  for (const [key, until] of redisExpirations) if (until <= Date.now()) { redisValues.delete(key); redisExpirations.delete(key) }
  const execute = (args) => {
    const [command, ...rest] = args
    const op = command.toUpperCase()
    if (op === 'GET') return redisValues.get(rest[0]) ?? null
    if (op === 'SET') {
      if (rest.some((arg) => String(arg).toUpperCase() === 'NX') && redisValues.has(rest[0])) return null
      redisValues.set(rest[0], rest[1])
      const ex = rest.findIndex((arg) => String(arg).toUpperCase() === 'EX')
      if (ex >= 0) redisExpirations.set(rest[0], Date.now() + Number(rest[ex + 1]) * 1000)
      return 'OK'
    }
    if (op === 'EVAL') {
      const [script, numKeys, ...items] = rest
      const keys = items.slice(0, Number(numKeys))
      const argv = items.slice(Number(numKeys))
      if (script.includes('auth-credential:read')) {
        return redisValues.has(keys[1]) ? -1 : redisValues.get(keys[0]) ?? null
      }
      if (script.includes('auth-credential:publish')) {
        if (redisValues.has(keys[1])) return -1
        if ((redisValues.get(keys[0]) ?? '') !== argv[0]) return 0
        redisValues.set(keys[0], argv[1])
        redisExpirations.set(keys[0], Date.now() + Number(argv[2]) * 1000)
        return 1
      }
      if (keys.length === 1) { // Lease release: compare-and-delete.
        if (redisValues.get(keys[0]) !== argv[0]) return 0
        redisValues.delete(keys[0])
        return 1
      }
      const [lockKey, resultKey] = keys
      const [owner, value] = argv
      if (redisValues.get(lockKey) !== owner) return 0
      redisValues.set(resultKey, value)
      redisExpirations.set(resultKey, Date.now() + Number(argv[2]) * 1000)
      redisValues.delete(lockKey)
      return 1
    }
    assert.fail(`unexpected Redis operation: ${op}`)
  }
  const body = JSON.parse(options.body)
  return Response.json(Array.isArray(body[0])
    ? body.map((args) => ({ result: encodeRedisResult(execute(args)) }))
    : { result: encodeRedisResult(execute(body)) })
}

function mockRefreshNetwork(t, response, redis = redisRest) {
  let exchanges = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://auth-redis.example')) return redis(options)
    assert.equal(String(url), protocol.TOKEN_ENDPOINT)
    exchanges++
    return response(options)
  })
  return () => exchanges
}

test('an 18-hour stale cookie recovers after the coordinator result is cold across multiple rotations', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  const used = []
  let current = 'incident-rt0'
  mockRefreshNetwork(t, (options) => {
    const token = options.body.get('refresh_token')
    used.push(token)
    if (token !== current) return Response.json({ error: 'invalid_grant' }, { status: 400 })
    current = `incident-rt${used.length}`
    return Response.json(tokenResponse({ refresh_token: current }))
  })
  const stale = session({ refreshToken: current })
  const original = await requestWithSession('/api/prompt', stale)
  assert.equal((await requestSession(original)).status, 200)
  for (let generation = 1; generation <= 3; generation++) {
    t.mock.timers.setTime(Date.now() + 18 * 3600_000)
    for (const key of redisValues.keys()) if (key.includes(':auth:refresh:')) redisValues.delete(key)
    const response = await requestSession(new NextRequest(original.url, { headers: original.headers }))
    assert.equal(response.status, 200)
    assert.equal(handledRequests.get(response)?.session.refreshToken, `incident-rt${generation + 1}`)
  }
  assert.deepEqual(used, ['incident-rt0', 'incident-rt1', 'incident-rt2', 'incident-rt3'])
})

const latestCredentialKey = (loginId = session().loginId) => `fx0:v1:auth:credential:${loginId}`
const revokedCredentialKey = (loginId = session().loginId) => `fx0:v1:revoked-login:${loginId}`
const redisScript = (options) => {
  const command = JSON.parse(options.body)
  return String((Array.isArray(command[0]) ? command[0] : command)[1])
}
async function browserGrant(response, loginId = session().loginId) {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${secure.grantCookieName(loginId)}=`))
  assert.ok(cookie)
  const request = new NextRequest('https://fx0.example/api/prompt', { headers: {
    cookie: `${secure.SESSION_COOKIE_NAME}=${loginId}; ${cookie.split(';')[0]}`,
  } })
  return { request, grant: await secure.getGrantFromRequest(request), cookie }
}

for (const terminal of [false, true]) test(`${terminal ? 'terminal old-token rejection' : 'delayed rotation publication'} adopts the durable CAS winner`, async (t) => {
  let started, release
  const entered = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const used = []
  mockRefreshNetwork(t, async (options) => {
    const token = options.body.get('refresh_token')
    used.push(token)
    if (token === `race-old-${terminal}`) {
      started(); await gate
      return terminal ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json(tokenResponse({ refresh_token: 'race-late-successor' }))
    }
    return Response.json(tokenResponse({ refresh_token: 'race-durable-winner', access_token: 'winner-access' }))
  })
  const oldRequest = requestSession(await requestWithSession('/api/prompt', session({ refreshToken: `race-old-${terminal}` })))
  await entered
  const winner = await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: `race-current-${terminal}` })))
  assert.equal(handledRequests.get(winner).session.refreshToken, 'race-durable-winner')
  const saved = redisValues.get(latestCredentialKey())
  release()
  const late = await oldRequest
  assert.equal(late.status, 200)
  assert.equal(handledRequests.get(late).session.refreshToken, 'race-durable-winner')
  assert.equal(redisValues.get(latestCredentialKey()), saved)
  assert.equal((await browserGrant(late)).grant.accessToken, 'winner-access')
  assert.equal(used.length, 2)
})

test('interleaved legacy bootstrap advances a CAS winner whose token this exchange already consumed', async (t) => {
  let publishStarted, releasePublish, exchangeStarted, releaseExchange
  const publishing = new Promise((resolve) => { publishStarted = resolve })
  const publishGate = new Promise((resolve) => { releasePublish = resolve })
  const exchanging = new Promise((resolve) => { exchangeStarted = resolve })
  const exchangeGate = new Promise((resolve) => { releaseExchange = resolve })
  mockRefreshNetwork(t, async (options) => {
    const token = options.body.get('refresh_token')
    if (token === 'bootstrap-rt1') { exchangeStarted(); await exchangeGate }
    return Response.json(tokenResponse({ refresh_token: token === 'bootstrap-rt0' ? 'bootstrap-rt1' : 'bootstrap-rt2' }))
  }, async (options) => {
    const command = JSON.parse(options.body)
    const args = Array.isArray(command[0]) ? command[0] : command
    if (redisScript(options).includes('auth-credential:publish')) {
      const candidate = await unsealData(args[4 + Number(args[2])], { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 })
      if (candidate.refreshToken === 'bootstrap-rt1') { publishStarted(); await publishGate }
    }
    return redisRest(options)
  })
  const first = requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'bootstrap-rt0' })))
  await publishing
  const second = requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'bootstrap-rt1' })))
  await exchanging
  releasePublish()
  await first
  releaseExchange()
  const completed = await second
  assert.equal(handledRequests.get(completed).session.refreshToken, 'bootstrap-rt2')
  const durable = await unsealData(redisValues.get(latestCredentialKey()), { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 })
  assert.equal(durable.refreshToken, 'bootstrap-rt2')
})

test('Redis read outage fails closed before provider exchange without clearing the grant', async (t) => {
  let exchanges = 0
  mockRefreshNetwork(t, () => { exchanges++; return Response.json(tokenResponse()) }, () => { throw new Error('Redis offline') })
  const response = await requestSession(await requestWithSession('/api/prompt', session()))
  assert.equal(response.status, 503)
  assert.equal(exchanges, 0)
  assert.equal(handledRequests.has(response), false)
  assert.equal(response.headers.get('set-cookie'), null)
})

for (const bootstrap of [true, false]) test(`publication outage preserves the only rotated cookie and repairs exact predecessor (${bootstrap ? 'legacy bootstrap' : 'existing record'})`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  let failPublication = false
  const used = []
  mockRefreshNetwork(t, (options) => {
    used.push(options.body.get('refresh_token'))
    return Response.json(tokenResponse({ refresh_token: `outage-rt${used.length}`, access_token: `outage-access${used.length}` }))
  }, (options) => {
    if (failPublication && redisScript(options).includes('auth-credential:publish')) throw new Error('Publication unavailable')
    return redisRest(options)
  })
  const original = await requestWithSession('/api/prompt', session({ refreshToken: `outage-original-${bootstrap}` }))
  if (!bootstrap) {
    await requestSession(original)
    t.mock.timers.setTime(Date.now() + 2 * 3600_000)
  }
  const previous = redisValues.get(latestCredentialKey())
  failPublication = true
  const failed = await requestSession(original)
  assert.equal(failed.status, 503)
  assert.equal(handledRequests.has(failed), false)
  assert.equal(redisValues.get(latestCredentialKey()), previous)
  const preserved = await browserGrant(failed)
  assert.equal(preserved.grant.refreshToken, `outage-rt${used.length}`)
  assert.equal(preserved.grant.credentialPublication.previous, createHash('sha256').update(previous ?? '').digest('hex'))
  assert.equal(preserved.grant.credentialPublication.previousToken, createHash('sha256').update(used.at(-1)).digest('hex'), 'bind the consumed durable token, not a stale incoming cookie')
  assert.equal(preserved.grant.credentialPublication.validUntil, Date.now() + 30 * 24 * 3600_000)
  assert.ok(Buffer.byteLength(preserved.cookie) < 4096)
  assert.doesNotMatch(preserved.cookie, /outage-rt|outage-access/)
  failPublication = false
  const count = used.length
  const repaired = await requestSession(preserved.request)
  assert.equal(repaired.status, 200)
  assert.equal(used.length, count, 'repair cannot exchange a token that already rotated')
  assert.equal(handledRequests.get(repaired).session.refreshToken, preserved.grant.refreshToken)
  assert.equal((await browserGrant(repaired)).grant.credentialPublication, undefined)
  assert.equal(redisExpirations.get(latestCredentialKey()), preserved.grant.credentialPublication.validUntil)
})

for (const recovery of ['missing', 'winner', 'revoked']) test(`pending publication retry handles ${recovery} without replaying or resurrecting an old grant`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  let failPublication = false
  const used = []
  mockRefreshNetwork(t, (options) => {
    used.push(options.body.get('refresh_token'))
    return Response.json(tokenResponse({ refresh_token: `pending-rt${used.length}` }))
  }, (options) => {
    if (failPublication && redisScript(options).includes('auth-credential:publish')) throw new Error('Publication failed')
    return redisRest(options)
  })
  const original = await requestWithSession('/api/prompt', session({ refreshToken: `pending-original-${recovery}` }))
  await requestSession(original)
  t.mock.timers.setTime(Date.now() + 2 * 3600_000)
  failPublication = true
  const failed = await requestSession(original)
  const preserved = await browserGrant(failed)
  assert.equal(failed.status, 503)
  assert.equal(preserved.grant.refreshToken, 'pending-rt2')
  failPublication = false
  if (recovery === 'missing') redisValues.delete(latestCredentialKey())
  if (recovery === 'revoked') redisValues.set(revokedCredentialKey(), '1')
  if (recovery === 'winner') {
    const winner = await unsealData(redisValues.get(latestCredentialKey()), { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 })
    redisValues.set(latestCredentialKey(), await sealData({ ...winner, accessToken: 'winner-access', refreshToken: 'pending-winner', expiresAt: Date.now() + 3600_000 }, { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 }))
  }
  const repaired = await requestSession(preserved.request)
  assert.equal(repaired.status, 200)
  const current = handledRequests.get(repaired).session
  if (recovery === 'missing') {
    assert.equal(current.refreshToken, 'pending-rt3')
    assert.equal(used.at(-1), 'pending-rt2', 'missing predecessor requires a fresh provider exchange, even with live access')
  } else if (recovery === 'winner') {
    assert.equal(current.refreshToken, 'pending-winner')
    assert.equal(used.length, 2)
  } else {
    assert.deepEqual(current, {})
    assert.match(repaired.headers.get('set-cookie'), /Max-Age=0/)
    assert.equal(used.length, 2)
  }
})

test('pending successor survives a delayed bootstrap of its consumed predecessor with one-hour tokens', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  const trail = []
  for (const level of ['info', 'error']) t.mock.method(console, level, (line) => trail.push(line))
  const used = []
  let live = 'late-bootstrap-seed'
  let phase = 'seed'
  let entered, release
  const publishing = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  mockRefreshNetwork(t, (options) => {
    const token = options.body.get('refresh_token')
    used.push(token)
    if (token !== live) return Response.json({ error: 'invalid_grant' }, { status: 400 })
    live = `late-bootstrap-rt${used.length - 1}`
    return Response.json(tokenResponse({ refresh_token: live, expires_in: 3600 }))
  }, async (options) => {
    if (redisScript(options).includes('auth-credential:publish')) {
      const command = JSON.parse(options.body)
      const args = Array.isArray(command[0]) ? command[0] : command
      const candidate = await unsealData(args[4 + Number(args[2])], { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 })
      if (phase === 'first-outage' || (phase === 'second-outage' && candidate.refreshToken === 'late-bootstrap-rt2')) {
        throw new Error('Synthetic publication outage')
      }
      if (phase === 'hold-bootstrap' && candidate.refreshToken === 'late-bootstrap-rt1') { entered(); await gate }
    }
    return redisRest(options)
  })
  const seeded = await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: live })))
  const original = (await browserGrant(seeded)).request
  t.mock.timers.setTime(Date.now() + 2 * 3600_000)
  phase = 'first-outage'
  const first = await requestSession(original)
  assert.equal(first.status, 503)
  const pendingFirst = await browserGrant(first)
  assert.equal(pendingFirst.grant.refreshToken, 'late-bootstrap-rt1')
  redisValues.delete(latestCredentialKey())
  phase = 'hold-bootstrap'
  const delayed = requestSession(new NextRequest(original.url, { headers: original.headers }))
  t.after(async () => { release(); await delayed })
  await publishing
  phase = 'second-outage'
  const second = await requestSession(pendingFirst.request)
  assert.equal(second.status, 503)
  const pendingSecond = await browserGrant(second)
  assert.equal(pendingSecond.grant.refreshToken, 'late-bootstrap-rt2')
  phase = 'repair'
  release()
  await delayed
  const predecessor = await unsealData(redisValues.get(latestCredentialKey()), { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 })
  assert.equal(predecessor.refreshToken, 'late-bootstrap-rt1')
  const repaired = await requestSession(pendingSecond.request)
  assert.equal(repaired.status, 200)
  assert.equal(handledRequests.get(repaired)?.session.refreshToken, 'late-bootstrap-rt2')
  assert.equal((await browserGrant(repaired)).grant.credentialPublication, undefined)
  const durable = await unsealData(redisValues.get(latestCredentialKey()), { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 })
  assert.equal(durable.refreshToken, 'late-bootstrap-rt2')
  assert.equal(redisExpirations.get(latestCredentialKey()), pendingSecond.grant.credentialPublication.validUntil)
  assert.deepEqual(used, ['late-bootstrap-seed', 'late-bootstrap-rt0', 'late-bootstrap-rt1'])
  assert.equal(trail.join('\n').includes(pendingSecond.grant.credentialPublication.previousToken), false, 'internal token commitments must not enter logs')
})

for (const race of ['stored', 'resealed', 'exhausted', 'winner', 'revoked']) test(`pending predecessor repair handles ${race} without losing its live successor`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  const used = []
  let live = `repair-seed-${race}`
  let failPublication = false
  let interleave = false
  let repairCalls = 0
  let predecessor
  mockRefreshNetwork(t, (options) => {
    const token = options.body.get('refresh_token')
    used.push(token)
    if (token !== live) return Response.json({ error: 'invalid_grant' }, { status: 400 })
    live = `repair-rt${used.length}`
    return Response.json(tokenResponse({ refresh_token: live }))
  }, async (options) => {
    if (redisScript(options).includes('auth-credential:publish')) {
      if (failPublication) throw new Error('Synthetic publication outage')
      if (interleave) {
        repairCalls++
        if (race === 'exhausted' || (race === 'resealed' && repairCalls === 1)) {
          redisValues.set(latestCredentialKey(), await sealData(predecessor, { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 }))
        }
        if (race === 'winner') {
          redisValues.set(latestCredentialKey(), await sealData({ ...predecessor, refreshToken: 'repair-durable-winner', accessToken: 'winner-access', expiresAt: Date.now() + 3600_000 }, { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 }))
        }
        if (race === 'revoked') redisValues.set(revokedCredentialKey(), '1')
      }
    }
    return redisRest(options)
  })
  const source = await requestWithSession('/api/prompt', session({ refreshToken: live }))
  await requestSession(source)
  const raw = redisValues.get(latestCredentialKey())
  predecessor = await unsealData(raw, { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 })
  t.mock.timers.setTime(Date.now() + 2 * 3600_000)
  failPublication = true
  const failed = await requestSession(source)
  assert.equal(failed.status, 503)
  const pending = await browserGrant(failed)
  failPublication = false
  const resealed = await sealData(predecessor, { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 })
  assert.notEqual(resealed, raw)
  redisValues.set(latestCredentialKey(), resealed)
  t.mock.timers.setTime(Date.now() + 3 * 60_000)
  interleave = true
  const repaired = await requestSession(pending.request)
  assert.equal(used.length, 2, 'retry must not exchange the already-spent durable predecessor')
  if (race === 'exhausted') {
    assert.equal(repairCalls, 2, 'CAS contention has a fixed retry bound')
    assert.equal(repaired.status, 503)
    assert.equal(handledRequests.has(repaired), false)
    const preserved = await browserGrant(repaired)
    assert.equal(preserved.grant.refreshToken, live)
    assert.deepEqual(preserved.grant.credentialPublication, pending.grant.credentialPublication)
    interleave = false
    const later = await requestSession(preserved.request)
    assert.equal(later.status, 200)
    assert.equal(handledRequests.get(later).session.refreshToken, live)
    assert.equal(redisExpirations.get(latestCredentialKey()), pending.grant.credentialPublication.validUntil)
  } else if (race === 'revoked') {
    assert.deepEqual(handledRequests.get(repaired).session, {})
    assert.match(repaired.headers.get('set-cookie'), /Max-Age=0/)
  } else {
    const expected = race === 'winner' ? 'repair-durable-winner' : live
    assert.equal(repaired.status, 200)
    assert.equal(handledRequests.get(repaired).session.refreshToken, expected)
    assert.equal((await browserGrant(repaired)).grant.credentialPublication, undefined)
    assert.equal(repairCalls, race === 'resealed' ? 2 : 1)
    const durable = await unsealData(redisValues.get(latestCredentialKey()), { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 })
    assert.equal(durable.refreshToken, expected)
    if (race !== 'winner') assert.equal(redisExpirations.get(latestCredentialKey()), pending.grant.credentialPublication.validUntil)
  }
})

for (const recovery of ['exact', 'published', 'ambiguous', 'missing', 'invalid']) test(`legacy pending metadata handles ${recovery} without guessing which token is newer`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  const used = []
  let failPublication = false
  mockRefreshNetwork(t, (options) => {
    used.push(options.body.get('refresh_token'))
    return Response.json(tokenResponse({ refresh_token: `legacy-pending-rt${used.length}` }))
  }, (options) => {
    if (failPublication && redisScript(options).includes('auth-credential:publish')) throw new Error('Synthetic publication outage')
    return redisRest(options)
  })
  const source = await requestWithSession('/api/prompt', session({ refreshToken: `legacy-pending-seed-${recovery}` }))
  await requestSession(source)
  const predecessor = await unsealData(redisValues.get(latestCredentialKey()), { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 })
  t.mock.timers.setTime(Date.now() + 2 * 3600_000)
  failPublication = true
  const pending = await browserGrant(await requestSession(source))
  failPublication = false
  delete pending.grant.credentialPublication.previousToken
  if (recovery === 'invalid') pending.grant.credentialPublication.previousToken = 'invalid-marker'
  if (recovery === 'ambiguous') redisValues.set(latestCredentialKey(), await sealData(predecessor, { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 }))
  if (recovery === 'missing') redisValues.delete(latestCredentialKey())
  if (recovery === 'published') {
    redisValues.set(latestCredentialKey(), await sealData({ ...predecessor, accessToken: pending.grant.accessToken, refreshToken: pending.grant.refreshToken, expiresAt: pending.grant.expiresAt, validUntil: pending.grant.credentialPublication.validUntil }, { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 }))
  }
  const before = redisValues.get(latestCredentialKey())
  const request = await requestWithSession('/api/prompt', pending.grant)
  const repaired = await requestSession(request)
  assert.equal(used.length, 2)
  if (recovery === 'exact' || recovery === 'published') {
    assert.equal(repaired.status, 200)
    assert.equal(handledRequests.get(repaired).session.refreshToken, pending.grant.refreshToken)
    assert.equal((await browserGrant(repaired)).grant.credentialPublication, undefined)
  } else {
    assert.equal(repaired.status, 503)
    assert.equal(handledRequests.has(repaired), false)
    assert.equal(redisValues.get(latestCredentialKey()), before)
    if (recovery === 'invalid') assert.equal(repaired.headers.get('set-cookie'), null)
    else {
      const preserved = await browserGrant(repaired)
      assert.equal(preserved.grant.refreshToken, pending.grant.refreshToken)
      assert.deepEqual(preserved.grant.credentialPublication, pending.grant.credentialPublication)
    }
  }
})

test('logout during rotation atomically fences publication and cannot resurrect the login', async (t) => {
  mockRefreshNetwork(t, () => {
    redisValues.set(revokedCredentialKey(), '1')
    return Response.json(tokenResponse({ refresh_token: 'revoked-successor' }))
  })
  const source = await requestWithSession('/api/prompt', session({ refreshToken: 'logout-race-refresh' }))
  const response = await requestSession(source)
  assert.equal(redisValues.has(latestCredentialKey()), false)
  assert.deepEqual(handledRequests.get(response).session, {})
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal(redisExpirations.has(revokedCredentialKey()), false, 'logout tombstone has no expiry')
  const replay = await requestSession(new NextRequest(source.url, { headers: source.headers }))
  assert.equal(replay.status, 200, await replay.text())
  assert.deepEqual(handledRequests.get(replay).session, {})
})

test('latest seals bind key, user, login and issuance and never own identity or selected team', async (t) => {
  const used = mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const original = session({ refreshToken: 'sealed-binding-refresh' })
  await requestSession(await requestWithSession('/api/prompt', original))
  const raw = redisValues.get(latestCredentialKey())
  const data = await unsealData(raw, { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 })
  assert.deepEqual(Object.keys(data).sort(), ['key', 'userId', 'loginId', 'loginAt', 'accessToken', 'refreshToken', 'expiresAt', 'validUntil'].sort())
  assert.doesNotMatch(raw, /rotated-refresh|rotated-access|verified-sub/)
  for (const field of ['key', 'userId', 'loginId', 'loginAt', 'validUntil']) {
    const bad = { ...data, [field]: typeof data[field] === 'number' ? 1 : 'different-binding' }
    redisValues.set(latestCredentialKey(), await sealData(bad, { password: process.env.SESSION_SECRET, ttl: 30 * 24 * 3600 }))
    const response = await requestSession(await requestWithSession('/api/prompt', original))
    assert.equal(response.status, 503, field)
    assert.equal(handledRequests.has(response), false, field)
    assert.equal(response.headers.get('set-cookie'), null, field)
  }
  redisValues.set(latestCredentialKey(), `${raw.slice(0, -8)}tampered`)
  const corrupted = await requestSession(await requestWithSession('/api/prompt', original))
  assert.equal(corrupted.status, 503)
  assert.equal(handledRequests.has(corrupted), false)
  assert.equal(corrupted.headers.get('set-cookie'), null)
  redisValues.set(latestCredentialKey(), raw)
  const changed = await requestSession(await requestWithSession('/api/prompt', { ...original, name: 'Cookie name', teamId: 'team_cookie_owner' }))
  assert.equal(handledRequests.get(changed).session.name, 'Cookie name')
  assert.equal(handledRequests.get(changed).session.teamId, 'team_cookie_owner')
  assert.equal(used(), 1)
})

test('record reads do not extend 30-day retention; an inactive expired record falls back to provider rejection', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  let exchanges = 0
  mockRefreshNetwork(t, () => ++exchanges === 1 ? Response.json(tokenResponse()) : Response.json({ error: 'invalid_grant' }, { status: 400 }))
  const source = await requestWithSession('/api/prompt', session({ refreshToken: 'retention-original-refresh' }))
  await requestSession(source)
  const until = redisExpirations.get(latestCredentialKey())
  t.mock.timers.setTime(Date.now() + 10 * 60_000)
  await requestSession(source)
  assert.equal(redisExpirations.get(latestCredentialKey()), until)
  t.mock.timers.setTime(until + 1)
  const inactive = await requestSession(source)
  assert.deepEqual(handledRequests.get(inactive).session, {})
  assert.equal(redisValues.has(latestCredentialKey()), false)
  assert.equal(exchanges, 2)
})

test('profile endpoint renews its credential in the handler without middleware', async (t) => {
  const exchanges = mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const response = await me(await requestWithSession('/api/auth/me', session({ refreshToken: 'handler-profile-refresh' })))
  assert.equal(response.status, 200)
  assert.equal(exchanges(), 1)
  assert.equal((await response.json()).user.id, 'verified-sub')
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(secure.grantCookieName(session().loginId) + '='))
  assert.ok(cookie, 'renewal must reach the browser on the profile response')
  const updated = await secure.getSessionFromRequest(new NextRequest('https://fx0.example/api/auth/me', {
    headers: { cookie: `${secure.SESSION_COOKIE_NAME}=${session().loginId}; ${cookie.split(';')[0]}` },
  }))
  assert.equal(updated.accessToken, 'rotated-access')
  assert.equal(updated.refreshToken, 'rotated-refresh')
})

test('profile endpoint refuses expired credentials when renewal is unavailable without middleware', async (t) => {
  t.mock.method(console, 'error', () => {})
  mockRefreshNetwork(t, () => Response.json({ error: 'invalid_client' }, { status: 401 }))
  const response = await me(await requestWithSession('/api/auth/me', session({
    refreshToken: 'handler-profile-unavailable', expiresAt: Date.now() - 1000,
  })))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '5')
  assert.ok(!('user' in await response.json()))
})

test('protected handler receives renewed credentials and its body while the event stream remains open', { timeout: 3000 }, async (t) => {
  mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const source = await requestWithSession('/api/prompt', session({ refreshToken: 'handler-stream-refresh' }), { origin: process.env.APP_URL })
  const abort = new AbortController()
  let forwardedSignal
  let stream
  t.after(() => { try { stream?.close() } catch {} })
  const handle = withUserRoute(async (request, { session: current }) => {
    assert.equal(current.accessToken, 'rotated-access')
    assert.equal(current.teamId, 'team_granted')
    assert.equal(request.method, 'POST')
    assert.equal(request.url, source.url)
    assert.equal(request.headers.get('origin'), process.env.APP_URL)
    forwardedSignal = request.signal
    assert.deepEqual(await request.json(), { text: 'keep the request body' })
    assert.match(request.headers.get('cookie'), /theme=dark/)
    return new Response(new ReadableStream({ start(controller) {
      stream = controller
      controller.enqueue(new TextEncoder().encode('data: first event\n\n'))
    } }), { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'handler-cookie=kept; Path=/' } })
  })
  const response = await handle(new Request(source.url, { method: 'POST', headers: source.headers, body: JSON.stringify({ text: 'keep the request body' }), signal: abort.signal }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith('handler-cookie=kept;')))
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith(secure.grantCookieName(session().loginId) + '=')))
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first event\n\n')
  await reader.cancel()
  abort.abort()
  assert.equal(forwardedSignal.aborted, true, 'forwarding must preserve request cancellation')
})

test('chat routes renew an expiring grant and return the rotated cookie', async (t) => {
  mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const request = await requestWithSession('/api/warm?session=chat-1', session({ refreshToken: 'chat-route-refresh' }), { origin: process.env.APP_URL })
  // The guest-claim step reads next/headers cookies(), which has no request scope here,
  // so the handler fails; renewal still runs first and its cookie survives the failure.
  const response = await withChatRoute(async () => new Response(null, { status: 204 }))(
    new Request(request.url, { method: 'POST', headers: request.headers }))
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith(secure.grantCookieName(session().loginId) + '=')))
})

test('renewed browser cookies survive protected-handler errors without exposing the error or credentials', async (t) => {
  mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  for (const [failure, status] of [[new AuthError(409, 'Chat is busy'), 409], [new Error('private failure detail'), 503]]) {
    const request = await requestWithSession('/api/events', session({ refreshToken: 'handler-error-refresh-' + status }))
    const response = await withUserRoute(async () => { throw failure })(request)
    assert.equal(response.status, status)
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(secure.grantCookieName(session().loginId) + '='))
    assert.ok(cookie, 'the browser must retain the rotated refresh token even when the handler fails')
    const current = await secure.getSessionFromRequest(new NextRequest(request.url, {
      headers: { cookie: `${secure.SESSION_COOKIE_NAME}=${session().loginId}; ${cookie.split(';')[0]}` },
    }))
    assert.equal(current.refreshToken, 'rotated-refresh')
    assert.doesNotMatch(await response.text(), /private failure detail|rotated-access|rotated-refresh/)
  }
})

test('request renewal updates browser and handler cookies in the same API request, preserving the granted team', async (t) => {
  const calls = mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const response = await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'proxy-success-refresh' })))
  assert.equal(calls(), 1)
  assert.match(response.headers.get('set-cookie'), /Max-Age=7776000/i)
  assert.match(forwardedRequest(response).headers.get('cookie'), /theme=dark/)
  const incoming = await secure.getSessionFromRequest(forwardedRequest(response))
  assert.equal(incoming.accessToken, 'rotated-access')
  assert.equal(incoming.refreshToken, 'rotated-refresh')
  assert.equal(incoming.teamId, 'team_granted')
  assert.equal(incoming.userId, 'verified-sub')
  assert.equal(response.headers.get('cookie'), null) // Not a browser-visible request header.
})

test('terminal invalid_grant clears current request and browser, without dropping unrelated cookies', async (t) => {
  mockRefreshNetwork(t, () => Response.json({ error: 'invalid_grant' }, { status: 400 }))
  const response = await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'proxy-terminal-refresh' })))
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/i)
  assert.equal(forwardedRequest(response).headers.get('cookie'), `theme=dark; ${secure.SESSION_COOKIE_NAME}=${session().loginId}`)
  assert.ok(response.headers.getSetCookie().every((cookie) => !cookie.startsWith(`${secure.SESSION_COOKIE_NAME}=`)))
  assert.deepEqual(await secure.getSessionFromRequest(forwardedRequest(response)), {})
  assert.ok(handledRequests.has(response))
})

test('renewal logs retain safe token correlation while stale cookies recover without exchanging again', async (t) => {
  const tag = (value) => expectedLogTag('refresh', value)
  const logged = []
  for (const level of ['info', 'error']) t.mock.method(console, level, (line) => logged.push(JSON.parse(line)))
  const results = [() => Response.json(tokenResponse()), () => Response.json({ error: 'invalid_grant' }, { status: 400 })]
  mockRefreshNetwork(t, () => results.shift()())
  await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'trail-refresh' })))
  await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'rotated-refresh' })))
  const trail = logged.filter(({ event }) => ['auth:refresh:exchanged', 'auth:session:renewed', 'auth:session:ended'].includes(event))
    .map(({ at, sessionAgeS, accessExpiresInS, ...rest }) => rest)
  const ids = { user: expectedLogTag('user', 'verified-sub'), login: expectedLogTag('login', session().loginId) }
  assert.deepEqual(trail, [
    { event: 'auth:refresh:exchanged', rt: tag('trail-refresh'), next: tag('rotated-refresh'), expiresIn: tokenResponse().expires_in },
    { event: 'auth:session:renewed', ...ids, rt: tag('trail-refresh') },
    { event: 'auth:session:renewed', ...ids, rt: tag('rotated-refresh') },
  ])
  assert.doesNotMatch(JSON.stringify(logged), /trail-refresh|rotated-refresh|rotated-access|verified-sub|user@example/)
})

test('request traces distinguish cookie preparation, browser adoption and a later stale-cookie replay', async (t) => {
  const logged = []
  for (const level of ['info', 'error']) t.mock.method(console, level, (line) => logged.push(JSON.parse(line)))
  const tag = (value) => expectedLogTag('refresh', value)
  const page = 'd1b4ae9a-a824-4e2a-b39e-b795dadc0692'
  const context = { 'x-fx0-auth-page': page, 'x-fx0-auth-prerender': '1', 'x-fx0-auth-visibility': 'hidden',
    purpose: 'prefetch', 'sec-purpose': 'Prefetch; Prerender', authorization: 'Bearer do-not-log-authorization' }
  const calls = mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const original = await requestWithSession('/api/prompt?access_token=do-not-log-query', session({ refreshToken: 'trace-original-refresh' }), context)
  const first = await requestSession(original)
  const { request: adopted, cookie } = await browserGrant(first)
  for (const [name, value] of Object.entries(context)) adopted.headers.set(name, value)
  await requestSession(adopted)
  await requestSession(new NextRequest(original.url, { headers: original.headers }))
  const received = logged.filter(({ event }) => event === 'auth:request:received')
  const responses = logged.filter(({ event }) => event === 'auth:request:response')
  assert.equal(calls(), 1)
  assert.equal(received.length, 3)
  assert.equal(responses.length, 3)
  assert.equal(new Set(received.map(({ request }) => request)).size, 3)
  for (const [i, entry] of received.entries()) {
    assert.equal(entry.request, responses[i].request)
    assert.equal(entry.page, expectedLogTag('page', page))
    assert.equal(entry.purpose, 'prefetch')
    assert.equal(entry.secPurpose, 'prefetch;prerender')
    assert.equal(entry.prerender, true)
    assert.equal(entry.visibility, 'hidden')
  }
  assert.equal(responses[0].grantCookieAction, 'set')
  assert.equal(responses[0].preparedRt, tag('rotated-refresh'))
  assert.equal(responses[0].preparedGrantCookie, expectedLogTag('cookie', cookie.split(';')[0].split('=')[1]))
  assert.equal(responses[0].preparedGrantCookie, received[1].grantCookie)
  assert.equal(responses[0].preparedRt, received[1].rt, 'a later request proves the new generation returned')
  assert.equal(responses[1].outcome, 'unchanged')
  assert.equal(responses[1].grantCookieAction, 'none')
  assert.equal(received[2].rt, tag('trace-original-refresh'), 'the old generation returned after adoption')
  assert.equal(responses[2].selectedRt, tag('rotated-refresh'))
  assert.ok(logged.some(({ event, request, source, cookieRt, rt }) => event === 'auth:credential:selected' &&
    request === received[2].request && source === 'latest' && cookieRt === received[2].rt && rt === responses[2].selectedRt))
  const text = JSON.stringify(logged)
  for (const secret of [page, cookie.split(';')[0].split('=')[1], 'trace-original-refresh', 'rotated-refresh', 'rotated-access',
    'verified-sub', 'user@example.com', 'do-not-log-query', 'do-not-log-authorization']) assert.ok(!text.includes(secret), secret)
})

for (const failure of ['read', 'publish', 'handler']) test(`request traces identify ${failure} failures without logging exception details`, async (t) => {
  const logged = []
  for (const level of ['info', 'error']) t.mock.method(console, level, (line) => logged.push(JSON.parse(line)))
  const secret = 'do-not-log-private-failure'
  mockRefreshNetwork(t, () => Response.json(tokenResponse()), (options) => {
    if (redisScript(options).includes(`auth-credential:${failure}`)) throw new Error(secret)
    return redisRest(options)
  })
  const source = await requestWithSession('/api/prompt', session({ refreshToken: `trace-failure-${failure}` }), {
    purpose: `Bearer ${secret}`, 'sec-purpose': secret, 'x-fx0-auth-page': secret,
    'x-fx0-auth-visibility': secret, 'x-fx0-auth-prerender': secret,
  })
  const response = await withRequestSession(() => {
    if (failure === 'handler') throw new Error(secret)
    return Response.json({ ok: true })
  })(source)
  assert.equal(response.status, 503)
  const prepared = logged.find(({ event }) => event === 'auth:request:response')
  assert.equal(prepared.purpose, 'other')
  assert.equal(prepared.secPurpose, 'other')
  assert.equal(prepared.prerender, null)
  assert.equal(prepared.visibility, 'unknown')
  assert.equal(prepared.handlerDispatched, failure === 'handler')
  assert.equal(prepared.grantCookieAction, failure === 'read' ? 'none' : 'set')
  assert.equal(prepared.preparedRt, failure === 'read' ? null : expectedLogTag('refresh', 'rotated-refresh'))
  if (failure === 'publish') {
    assert.equal(prepared.outcome, 'unavailable')
    assert.ok(logged.some(({ event, request }) => event === 'auth:credential:publish_failed' && request === prepared.request))
  } else {
    assert.equal(prepared.outcome, 'error')
    assert.ok(logged.some(({ event, stage, request }) => event === 'auth:request:failed' && request === prepared.request &&
      stage === (failure === 'read' ? 'renewal' : 'handler')))
  }
  assert.doesNotMatch(JSON.stringify(logged), /do-not-log-private-failure|rotated-refresh|rotated-access|verified-sub|user@example/)
})

for (const renew of [false, true]) test(`response tracing inspects final grant headers, including ${renew ? 'duplicate' : 'handler-owned'} cookies`, async (t) => {
  const logged = []
  for (const level of ['info', 'error']) t.mock.method(console, level, (line) => logged.push(JSON.parse(line)))
  mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const data = session({ expiresAt: Date.now() + (renew ? 60_000 : 3600_000) })
  const cookie = `${secure.grantCookieName(data.loginId)}=do-not-log-handler-cookie; Path=/; HttpOnly`
  const response = await withRequestSession(() => new Response(null, { headers: { 'set-cookie': cookie } }))(
    await requestWithSession('/api/prompt', data))
  assert.equal(response.status, 200)
  const prepared = logged.find(({ event }) => event === 'auth:request:response')
  assert.equal(prepared.grantCookieAction, renew ? 'multiple' : 'set')
  assert.equal(prepared.grantCookieCount, renew ? 2 : 1)
  assert.equal(prepared.preparedRt, null, 'do not claim a token generation when the final header is ambiguous or handler-owned')
  assert.doesNotMatch(JSON.stringify(logged), /do-not-log-handler-cookie/)
})

test('request traces record missing and invalid grants without exposing cookie or selector values', async (t) => {
  const logged = []
  for (const level of ['info', 'error']) t.mock.method(console, level, (line) => logged.push(JSON.parse(line)))
  t.mock.method(globalThis, 'fetch', async () => assert.fail('invalid grants make no external requests'))
  const id = session().loginId
  for (const cookie of ['', `${secure.SESSION_COOKIE_NAME}=do-not-log-invalid-selector`, `${secure.SESSION_COOKIE_NAME}=${id}`,
    `${secure.SESSION_COOKIE_NAME}=${id}; ${secure.grantCookieName(id)}=do-not-log-invalid-grant`]) {
    await requestSession(new NextRequest('https://fx0.example/api/prompt', { headers: { cookie } }))
  }
  const received = logged.filter(({ event }) => event === 'auth:request:received')
  assert.deepEqual(received.map(({ selector, authenticated, grantCookie }) => [selector, authenticated, grantCookie !== null]), [
    ['missing', false, false], ['invalid', false, false], ['valid', false, false], ['valid', false, true],
  ])
  assert.doesNotMatch(JSON.stringify(logged), /do-not-log-invalid-selector|do-not-log-invalid-grant/)
})

test('transient refresh preserves cookie; known-expired credentials do not reach the handler', async (t) => {
  mockRefreshNetwork(t, () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }))
  const live = await requestSession(await requestWithSession('/api/prompt', session({ refreshToken: 'proxy-transient-live' })))
  assert.equal(live.headers.get('set-cookie'), null)
  assert.ok(handledRequests.has(live))
  const expired = await requestSession(await requestWithSession('/api/prompt', session({ expiresAt: Date.now() - 1000, refreshToken: 'proxy-transient-expired' })))
  assert.equal(expired.status, 503)
  assert.equal(expired.headers.get('set-cookie'), null)
  assert.equal(handledRequests.has(expired), false)
  assert.equal(expired.headers.get('cache-control'), 'no-store')
})

test('page identity reads do not renew expired grants', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('pages only read cookie identity'))
  const expired = session({ expiresAt: Date.now() - 1000 })
  for (const accept of ['text/html', 'text/x-component']) {
    const request = await requestWithSession('/', expired, { accept })
    assert.equal((await secure.getSessionFromRequest(request)).userId, 'verified-sub')
  }
})

test('after a page load, the parallel first API requests share one renewal', async (t) => {
  const calls = mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const data = session({ refreshToken: 'proxy-parallel-refresh' })
  await secure.getSessionFromRequest(await requestWithSession('/', data, { accept: 'text/html' }))
  const paths = ['/api/credits', '/api/teams', '/api/events?session=x', '/api/model?session=x']
  const responses = await Promise.all(paths.map(async (path) => requestSession(await requestWithSession(path, data))))
  assert.equal(calls(), 1)
  for (const [i, response] of responses.entries()) {
    assert.ok(handledRequests.has(response))
    assert.equal((await secure.getGrantFromRequest(forwardedRequest(response, paths[i]))).accessToken, 'rotated-access')
  }
})

test('renewal reseals the grant as stored, without the in-app team choice', async (t) => {
  mockRefreshNetwork(t, () => Response.json(tokenResponse()))
  const data = session({ refreshToken: 'proxy-team-choice-refresh' })
  const choice = await secure.teamCookie(data.loginId, { teamId: 'team_chosen', teamSlug: 'chosen' })
  const grant = await secure.sealSessionCookie(data)
  const response = await requestSession(new NextRequest('https://fx0.example/api/prompt', { headers: {
    cookie: `${protocol.SESSION_COOKIE_NAME}=${data.loginId}; ${grant.cookieName}=${grant.value}; ${choice.cookieName}=${choice.value}`,
  } }))
  const forwarded = forwardedRequest(response)
  assert.equal((await secure.getGrantFromRequest(forwarded)).teamId, 'team_granted')
  assert.equal((await secure.getGrantFromRequest(forwarded)).accessToken, 'rotated-access')
  assert.equal((await secure.getSessionFromRequest(forwarded)).teamId, 'team_chosen')
})

test('an expired latest access token refreshes the current refresh token, not the stale cookie token', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const used = []
  const calls = mockRefreshNetwork(t, (options) => {
    used.push(options.body.get('refresh_token'))
    return Response.json(tokenResponse({ expires_in: 60 }))
  })
  const request = await requestWithSession('/api/prompt', session({ refreshToken: 'proxy-short-lived-refresh' }))
  const first = await requestSession(request)
  assert.ok(handledRequests.has(first))
  t.mock.timers.setTime(Date.now() + 70_000)
  const second = await requestSession(request)
  assert.equal(calls(), 2)
  assert.deepEqual(used, ['proxy-short-lived-refresh', 'rotated-refresh'])
  assert.equal(second.status, 200)
  assert.equal(handledRequests.has(second), true)
  const cookie = second.headers.getSetCookie().find((value) => value.startsWith(`${secure.grantCookieName(session().loginId)}=`))
  const next = new NextRequest('https://fx0.example', { headers: {
    cookie: `${secure.SESSION_COOKIE_NAME}=${session().loginId}; ${cookie.split(';')[0]}`,
  } })
  assert.equal((await secure.getSessionFromRequest(next)).refreshToken, 'rotated-refresh')
})

test('signin uses trusted APP_URL, required scopes and PKCE, and one encrypted short-lived flow cookie', async () => {
  const response = await signin(new NextRequest('https://attacker.example/api/auth/signin?reauth=true'))
  const url = new URL(response.headers.get('location'))
  assert.equal(url.searchParams.get('redirect_uri'), 'https://fx0.example/api/auth/callback')
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('teamSelection'), 'single-team')
  const cookie = response.cookies.get(protocol.FLOW_COOKIE_NAME)
  assert.ok(cookie)
  const flow = await unsealData(cookie.value, { password: process.env.SESSION_SECRET, ttl: protocol.FLOW_TTL_SECONDS })
  assert.equal(flow.state, url.searchParams.get('state'))
  assert.equal(flow.nonce, url.searchParams.get('nonce'))
  assert.equal(createHash('sha256').update(flow.codeVerifier).digest('base64url'), url.searchParams.get('code_challenge'))
  assert.ok(!cookie.value.includes(flow.codeVerifier))
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i)
  assert.match(response.headers.get('set-cookie'), /Max-Age=600/i)
  assert.equal(protocol.validOAuthFlow(flow, flow.state), true)
  assert.equal(protocol.validOAuthFlow(flow, 'wrong-state'), false)
  assert.equal(protocol.validOAuthFlow(flow, flow.state, flow.createdAt + 600_000), false)
})

test('jose verifies signature, issuer, audience, expiration and nonce before exposing stable sub', async () => {
  const pair = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'auth-test-key', alg: 'RS256' }
  const keys = createLocalJWKSet({ keys: [jwk] })
  const sign = (claims = {}, key = pair.privateKey) => new SignJWT({ sub: 'stable-sub', email: 'user@example.com', nonce: 'expected-nonce', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://vercel.com')
    .setAudience('auth-test-client').setExpirationTime('5m').sign(key)
  const params = { clientId: 'auth-test-client', nonce: 'expected-nonce' }
  assert.equal((await protocol.verifyVercelIdToken(await sign(), params, keys)).userId, 'stable-sub')
  await assert.rejects(protocol.verifyVercelIdToken(await sign({ nonce: 'wrong' }), params, keys))
  await assert.rejects(protocol.verifyVercelIdToken(await sign(), { ...params, clientId: 'wrong-client' }, keys))
  const wrongIssuer = await new SignJWT({ sub: 's', email: 'e', nonce: 'expected-nonce' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer('https://attacker.example').setAudience(params.clientId).setExpirationTime('5m').sign(pair.privateKey)
  await assert.rejects(protocol.verifyVercelIdToken(wrongIssuer, params, keys))
  const expired = await new SignJWT({ sub: 's', email: 'e', nonce: 'expected-nonce' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer('https://vercel.com').setAudience(params.clientId).setExpirationTime(Math.floor(Date.now() / 1000) - 1).sign(pair.privateKey)
  await assert.rejects(protocol.verifyVercelIdToken(expired, params, keys))
  await assert.rejects(protocol.verifyVercelIdToken(await sign({}, (await generateKeyPair('RS256')).privateKey), params, keys))
  await assert.rejects(protocol.verifyVercelIdToken(await sign({ sub: '' }), params, keys))
})

test('team selection probes Gateway permissions, never returns unapproved membership or owner default', async (t) => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push(String(url))
    assert.equal(options.headers.Authorization, 'Bearer user-token')
    if (String(url).startsWith('https://api.vercel.com/v2/teams')) return Response.json({ teams: [
      { id: 'user_not_a_team' }, { id: 'team_denied', slug: 'denied' }, { id: 'team_allowed', slug: 'allowed' },
    ] })
    return String(url).includes('team_denied') ? Response.json({}, { status: 403 }) : Response.json({ balance: '0' })
  })
  assert.deepEqual(await auth.getGrantedTeam('user-token'), { teamId: 'team_allowed', teamSlug: 'allowed' })
  assert.equal(seen.length, 3)
  t.mock.method(globalThis, 'fetch', async (url) => String(url).startsWith('https://api.vercel.com')
    ? Response.json({ teams: [{ id: 'team_denied' }] }) : Response.json({}, { status: 401 }))
  await assert.rejects(auth.getGrantedTeam('user-token'), (error) => error.status === 403)
  t.mock.method(globalThis, 'fetch', async (url) => String(url).startsWith('https://api.vercel.com')
    ? Response.json({ teams: [{ id: 'team_denied' }, { id: 'team_other' }] }) : Response.json({}, { status: 503 }))
  await assert.rejects(auth.getGrantedTeam('user-token'), (error) => error.status === 503)
})

test('one throttled or failing team probe hides only that team', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith('https://api.vercel.com')) return Response.json({ teams: [{ id: 'team_throttled' }, { id: 'team_down' }, { id: 'team_ok', slug: 'ok' }] })
    if (String(url).includes('team_throttled')) return Response.json({}, { status: 429 })
    if (String(url).includes('team_down')) throw new TypeError('fetch failed')
    return Response.json({ balance: '12.5' })
  })
  assert.deepEqual(await auth.listGatewayTeams('user-token'), [{ teamId: 'team_ok', teamSlug: 'ok', balance: 12.5 }])
  assert.deepEqual(await auth.getGrantedTeam('user-token'), { teamId: 'team_ok', teamSlug: 'ok' })
})

test('sign-in that cannot start lands on the login page, relative to the requested host', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const prior = process.env.VERCEL_OAUTH_CLIENT_SECRET
  delete process.env.VERCEL_OAUTH_CLIENT_SECRET
  try {
    const response = await signin(new NextRequest('https://untrusted.example/api/auth/signin'))
    assert.equal(response.status, 307)
    assert.equal(response.headers.get('location'), '/login?error=signin_unavailable')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    // The cause is in the server log, not in the response.
    assert.match(logged.mock.calls[0].arguments[0], /"event":"auth:signin:unavailable".*OAuth is not configured/)
  } finally { process.env.VERCEL_OAUTH_CLIENT_SECRET = prior }
})

test('logout rejects cross-origin or missing Origin; same-origin clears both cookies even if revocation fails', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++
    assert.equal(options.body.get('token'), 'old-access')
    throw new Error('revoke temporarily unavailable')
  })
  for (const origin of [undefined, 'https://attacker.example']) {
    const request = new NextRequest('https://fx0.example/api/auth/signout', { method: 'POST', headers: origin ? { origin } : {} })
    assert.equal((await signout(request)).status, 403)
  }
  assert.equal(calls, 0)
  const request = await requestWithSession('/api/auth/signout', session(), { origin: 'https://fx0.example' })
  const response = await signout(request)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('clear-site-data'), null, 'cached previews revalidate against the session instead')
  await globalThis.__signoutAfter
  assert.equal(calls, 1)
  const cookies = response.headers.getSetCookie()
  assert.ok(cookies.some((value) => value.startsWith(`${secure.SESSION_COOKIE_NAME}=`) && value.includes('Max-Age=0')))
  assert.ok(cookies.some((value) => value.startsWith(`${secure.grantCookieName(session().loginId)}=`) && value.includes('Max-Age=0')))
  assert.ok(cookies.some((value) => value.startsWith(`${protocol.FLOW_COOKIE_NAME}=`) && value.includes('Max-Age=0')))
  assert.ok(cookies.some((value) => value.startsWith('fx0-signed-in=;') && value.includes('Max-Age=0')))
  assert.equal(globalThis.__signedOutUser, 'verified-sub')
})

test('preview deployments trust only their own deployment and branch hosts', () => {
  const saved = { env: process.env.VERCEL_ENV, url: process.env.VERCEL_URL, branch: process.env.VERCEL_BRANCH_URL }
  Object.assign(process.env, { VERCEL_ENV: 'preview', VERCEL_URL: 'fx0-abc.example.dev', VERCEL_BRANCH_URL: 'fx0-git-branch.example.dev' })
  try {
    const request = (host, origin) => ({ headers: new Headers({ host, ...(origin ? { origin } : {}) }) })
    assert.equal(protocol.requestOrigin(request('fx0-git-branch.example.dev'), ''), 'https://fx0-git-branch.example.dev')
    assert.equal(protocol.requestOrigin(request('fx0-abc.example.dev'), ''), 'https://fx0-abc.example.dev')
    assert.throws(() => protocol.requestOrigin(request('evil.example'), ''), /APP_URL is required/)
    assert.doesNotThrow(() => protocol.assertSameOrigin(request('x', 'https://fx0-abc.example.dev'), ''))
    assert.throws(() => protocol.assertSameOrigin(request('x', 'https://evil.example'), ''), /Cross-origin/)
    // A configured APP_URL always wins.
    assert.equal(protocol.requestOrigin(request('fx0-abc.example.dev'), 'https://fx0.vercel.dev'), 'https://fx0.vercel.dev')
  } finally {
    for (const [key, value] of [['VERCEL_ENV', saved.env], ['VERCEL_URL', saved.url], ['VERCEL_BRANCH_URL', saved.branch]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('API auth leaves the readable signed-in hint to login, logout and account bootstrap', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('a fresh session needs no network'))
  const hint = (response) => response.headers.getSetCookie().find((value) => value.startsWith(`${protocol.SIGNED_IN_HINT_COOKIE}=`))
  const steady = await requestWithSession('/api/sessions', session({ expiresAt: Date.now() + 3600_000 }))
  steady.cookies.set(protocol.SIGNED_IN_HINT_COOKIE, '1')
  assert.equal(hint(await requestSession(steady)), undefined)
  const visitor = new NextRequest('https://fx0.example/api/sessions', { headers: { cookie: `${protocol.SIGNED_IN_HINT_COOKIE}=1` } })
  assert.equal(hint(await requestSession(visitor)), undefined)
  assert.equal(hint(await requestSession(await requestWithSession('/api/sessions', session({ expiresAt: Date.now() + 3600_000 })))), undefined)
})
