import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { sealData } from 'iron-session'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { NextRequest } from 'next/server.js'

// Inject only the parent-owned persistence contract, not OAuth/session code.
// Callback tests cannot need Neon credentials or write real accounts.
const writes = []
globalThis.__authCallbackAccountWrites = writes
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/lib/turn-credential' && context.parentURL?.endsWith('/api/auth/signout/route.ts')) return { url: 'data:text/javascript,export async function revokeLoginCredentials() {}', shortCircuit: true }
    // No login is signed out here; tests/auth.test.mjs covers revoked grants.
    if (specifier === './turn-credential.ts' && /\/lib\/(auth|request-session)\.ts$/.test(context.parentURL ?? '')) {
      return { url: 'data:text/javascript,export async function loginRevoked() { return false }', shortCircuit: true }
    }
    if (specifier === '@/lib/accounts' && context.parentURL.endsWith('/api/auth/callback/route.ts')) {
      return { url: 'auth-test:account-boundary', shortCircuit: true }
    }
    if (specifier === '@/lib/agent') return { url: 'data:text/javascript,export async function cancelUserRuntime(id) { globalThis.__signedOutUser = id }', shortCircuit: true }
    if (specifier.startsWith('@/lib/')) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context)
    // after() needs a Next request scope; the sign-out's follow-up runs at once and tests await it.
    if (specifier === 'next/server' && context.parentURL?.endsWith('/api/auth/signout/route.ts')) {
      return { url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(import.meta.resolve('next/server.js'))}; export function after(work) { globalThis.__signoutAfter = Promise.resolve().then(work) }`)}`, shortCircuit: true }
    }
    if (specifier === 'next/server') return next('next/server.js', context)
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'auth-test:account-boundary') return { format: 'module', shortCircuit: true, source: `
      export { AuthError } from ${JSON.stringify(new URL('../lib/accounts.ts', import.meta.url).href)};
      export async function upsertAccount(user) { globalThis.__authCallbackAccountWrites.push(user); }
    ` }
    return next(url, context)
  },
})
process.env.SESSION_SECRET = 'callback-test-secret-at-least-32-characters'
process.env.VERCEL_OAUTH_CLIENT_ID = 'callback-test-client'
process.env.VERCEL_OAUTH_CLIENT_SECRET = 'callback-test-secret'
process.env.APP_URL = 'https://fx0.example'
process.env.KV_REST_API_URL = 'https://callback-redis.example'
process.env.KV_REST_API_TOKEN = 'test-only-redis-token'

const { withRequestSession } = await import('../lib/request-session.ts')
const requestSession = withRequestSession(() => new Response(null))
const { POST: signout } = await import('../app/api/auth/signout/route.ts')
const { GET } = await import('../app/api/auth/callback/route.ts')
const protocol = await import('../lib/auth-protocol.ts')
const secure = await import('../lib/secure-session.ts')
const pair = await generateKeyPair('RS256')
const jwk = { ...await exportJWK(pair.publicKey), alg: 'RS256', kid: 'callback-test-key' }
const flow = () => ({ purpose: 'oauth', state: 'test-state', nonce: 'test-nonce', codeVerifier: 'x'.repeat(43), createdAt: Date.now() })

async function callbackRequest(query = '?code=test-code&state=test-state', data = flow(), cookies = '', origin = 'https://untrusted-host.example') {
  const value = await sealData(data, { password: process.env.SESSION_SECRET, ttl: protocol.FLOW_TTL_SECONDS })
  return new NextRequest(`${origin}/api/auth/callback${query}`, {
    headers: { cookie: `${cookies ? `${cookies}; ` : ''}${protocol.FLOW_COOKIE_NAME}=${value}` },
  })
}

// Browser-like application of real Set-Cookie headers in deliberately reversed
// response order. No auth functions or cookie names are rewritten by this jar.
function browserCookies(initial) {
  const values = new Map(initial.split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)))
  return {
    header: () => [...values].map(([name, value]) => `${name}=${value}`).join('; '),
    get: (name) => values.get(name),
    apply(response) {
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';')
        const equal = pair.indexOf('=')
        const name = pair.slice(0, equal)
        if (/;\s*Max-Age=0(?:;|$)/i.test(cookie)) values.delete(name)
        else values.set(name, pair.slice(equal + 1))
      }
    },
  }
}

const encodeRedisResult = (value) => typeof value === 'string' && value !== 'OK' ? Buffer.from(value).toString('base64') : value
const redisValues = new Map()
test.beforeEach(() => { redisValues.clear() })
function redisResponse(options) {
  const execute = ([command, ...args]) => {
    switch (command.toUpperCase()) {
      case 'GET': return redisValues.get(args[0]) ?? null
      case 'SET':
        if (args.includes('NX') && redisValues.has(args[0])) return null
        redisValues.set(args[0], args[1]); return 'OK'
      case 'EVAL': {
        const [script, count, ...items] = args
        const keys = items.slice(0, Number(count))
        const argv = items.slice(Number(count))
        if (script.includes('auth-credential:read')) return redisValues.has(keys[1]) ? -1 : redisValues.get(keys[0]) ?? null
        if (script.includes('auth-credential:publish')) {
          if (redisValues.has(keys[1])) return -1
          if ((redisValues.get(keys[0]) ?? '') !== argv[0]) return 0
          redisValues.set(keys[0], argv[1]); return 1
        }
        if (redisValues.get(keys[0]) !== argv[0]) return 0
        if (keys.length > 1) redisValues.set(keys[1], argv[1])
        redisValues.delete(keys[0]); return 1
      }
      default: assert.fail('Unexpected Redis command')
    }
  }
  const body = JSON.parse(options.body)
  return Response.json(Array.isArray(body[0]) ? body.map((args) => ({ result: encodeRedisResult(execute(args)) })) : { result: encodeRedisResult(execute(body)) })
}

function assertFlowCleared(response) {
  assert.ok(response.headers.getSetCookie().some((value) => value.startsWith(`${protocol.FLOW_COOKIE_NAME}=`) && value.includes('Max-Age=0')))
  assert.equal(response.headers.get('cache-control'), 'no-store')
}

async function identityToken(nonce = 'test-nonce') {
  return new SignJWT({ sub: 'signature-verified-sub', email: 'verified@example.com', name: 'Verified User', picture: 'https://example.com/picture', nonce })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://vercel.com')
    .setAudience(process.env.VERCEL_OAUTH_CLIENT_ID).setExpirationTime('5m').sign(pair.privateKey)
}

function mockOAuth(t, token, refresh) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://callback-redis.example')) return redisResponse(options)
    if (String(url) === 'https://vercel.com/.well-known/jwks') return Response.json({ keys: [jwk] })
    if (String(url) === `${protocol.TOKEN_ENDPOINT}/revoke`) return Response.json({})
    if (String(url) === protocol.TOKEN_ENDPOINT) {
      if (options.body.get('grant_type') === 'refresh_token') {
        assert.ok(refresh, 'Unexpected refresh exchange')
        return refresh(options)
      }
      assert.equal(options.body.get('redirect_uri'), 'https://fx0.example/api/auth/callback')
      assert.equal(options.body.get('code_verifier'), 'x'.repeat(43))
      assert.equal(options.body.get('grant_type'), 'authorization_code')
      return Response.json({ access_token: 'callback-access', refresh_token: 'callback-refresh', expires_in: 3600, id_token: token })
    }
    assert.equal(options.headers.Authorization, 'Bearer callback-access')
    if (String(url).startsWith('https://api.vercel.com/v2/teams')) return Response.json({ teams: [{ id: 'team_callback', slug: 'callback-team' }] })
    assert.equal(String(url), 'https://ai-gateway.vercel.sh/v1/credits?teamId=team_callback')
    return Response.json({ balance: '0' })
  })
}

test('callback verifies identity and grant, upserts only public identity, seals session, clears flow and trusts APP_URL', async (t) => {
  writes.length = 0
  mockOAuth(t, await identityToken())
  const response = await GET(await callbackRequest(undefined, undefined, 'fx0-signout-pending=1'))
  assert.equal(response.headers.get('location'), 'https://fx0.example/')
  assertFlowCleared(response)
  const selector = response.headers.getSetCookie().find((value) => value.startsWith(`${secure.SESSION_COOKIE_NAME}=`))
  assert.ok(selector, 'clearing the flow cookie must not overwrite the selector Set-Cookie')
  const jar = browserCookies('theme=dark; fx0-signout-pending=1')
  jar.apply(response)
  assert.equal(jar.get('fx0-signout-pending'), undefined, 'verified new login clears a previous logout intent')
  assert.equal(jar.get('fx0-signed-in'), '1', 'the redirect must reach the page with its UI hint already set')
  const hint = response.headers.getSetCookie().find((value) => value.startsWith('fx0-signed-in='))
  assert.match(hint, /Path=\/;.*Max-Age=7776000;.*SameSite=Lax/i)
  assert.doesNotMatch(hint, /HttpOnly|signature-verified-sub|callback-access|callback-refresh/)
  const request = new NextRequest('https://fx0.example', { headers: { cookie: jar.header() } })
  const session = await secure.getSessionFromRequest(request)
  assert.match(session.loginId, /^[a-f0-9]{32}$/)
  assert.equal(jar.get(secure.SESSION_COOKIE_NAME), session.loginId)
  assert.ok(jar.get(secure.grantCookieName(session.loginId)), 'callback writes the selected sealed grant')
  assert.ok(Number.isSafeInteger(session.loginAt) && Math.abs(session.loginAt - Date.now()) < 1000)
  assert.equal(session.userId, 'signature-verified-sub')
  assert.equal(session.teamId, 'team_callback')
  assert.equal(session.teamSlug, 'callback-team')
  assert.equal(session.accessToken, 'callback-access')
  assert.equal(session.refreshToken, 'callback-refresh')
  assert.deepEqual(writes, [{ id: 'signature-verified-sub', name: 'Verified User', email: 'verified@example.com', picture: 'https://example.com/picture' }])
})

test('provider denial, missing code, forged state, expired flow and malformed flow clear cookie without exchange', async (t) => {
  writes.length = 0
  t.mock.method(globalThis, 'fetch', async () => assert.fail('invalid flow must not reach provider'))
  for (const [query, data] of [
    ['?error=access_denied', flow()],
    ['?state=test-state', flow()],
    ['?code=test-code&state=forged-state', flow()],
    ['?code=test-code&state=test-state', { ...flow(), createdAt: Date.now() - 600_001 }],
    ['?code=test-code&state=test-state', { ...flow(), nonce: undefined }],
  ]) {
    const response = await GET(await callbackRequest(query, data))
    assert.equal(response.headers.get('location'), 'https://fx0.example/login?error=signin_failed')
    assertFlowCleared(response)
    assert.ok(!response.headers.getSetCookie().some((value) => value.startsWith(`${secure.SESSION_COOKIE_NAME}=`)))
    assert.ok(!response.headers.getSetCookie().some((value) => value.startsWith('fx0-signout-pending=')), 'failed login must preserve pending logout')
  }
  assert.deepEqual(writes, [])
})

test('wrong nonce never stores identity or session and still clears flow', async (t) => {
  writes.length = 0
  mockOAuth(t, await identityToken('wrong-nonce'))
  const response = await GET(await callbackRequest())
  assert.equal(response.headers.get('location'), 'https://fx0.example/login?error=signin_failed')
  assertFlowCleared(response)
  assert.deepEqual(writes, [])
})

test('Gateway permission denial surfaces one team-access error without an owner fallback', async (t) => {
  writes.length = 0
  const token = await identityToken()
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url) === protocol.TOKEN_ENDPOINT) return Response.json({ access_token: 'callback-access', refresh_token: 'callback-refresh', expires_in: 3600, id_token: token })
    if (String(url).startsWith('https://api.vercel.com/v2/teams')) return Response.json({ teams: [{ id: 'team_denied' }] })
    assert.ok(String(url).startsWith('https://ai-gateway.vercel.sh/v1/credits?teamId='))
    return Response.json({}, { status: 403 })
  })
  const response = await GET(await callbackRequest())
  assert.equal(response.headers.get('location'), 'https://fx0.example/login?error=team_access')
  assertFlowCleared(response)
  assert.deepEqual(writes, [])
})

const oldSession = (refreshToken) => ({
  loginId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', loginAt: 1_750_000_000_000,
  userId: 'old-user-sub', email: 'old@example.com', accessToken: 'old-user-access', refreshToken,
  teamId: 'team_old', teamSlug: 'old-team', expiresAt: Date.now() + 60_000, isLoggedIn: true,
})

for (const terminal of [false, true]) {
  const outcome = terminal ? 'terminal' : 'successful'
  test(`late ${outcome} old-user request-auth response cannot roll back a completed new-user callback`, async (t) => {
    const old = oldSession(`overlap-login-${outcome}`)
    const grant = await secure.sealSessionCookie(old)
    const jar = browserCookies(`theme=dark; ${secure.SESSION_COOKIE_NAME}=${old.loginId}; ${grant.cookieName}=${grant.value}`)
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    let exchanges = 0
    mockOAuth(t, await identityToken(), async (options) => {
      assert.equal(options.body.get('refresh_token'), old.refreshToken)
      exchanges++
      started.resolve()
      await release.promise
      return terminal ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json({ access_token: 'late-old-access', refresh_token: 'late-old-refresh', expires_in: 3600 })
    })
    const pending = requestSession(new NextRequest('https://fx0.example/api/prompt', { headers: { cookie: jar.header() } }))
    await started.promise
    let newId
    try {
      const login = await GET(await callbackRequest(undefined, undefined, jar.header(), process.env.APP_URL))
      assert.equal(login.headers.get('location'), 'https://fx0.example/')
      jar.apply(login)
      newId = jar.get(secure.SESSION_COOKIE_NAME)
      assert.match(newId, /^[a-f0-9]{32}$/)
      assert.notEqual(newId, old.loginId)
      assert.equal(jar.get(grant.cookieName), undefined, 'same-origin callback clears prior selected grant without revoking it')
    } finally { release.resolve() }
    const late = await pending
    assert.equal(exchanges, 1)
    assert.ok(late.headers.getSetCookie().every((cookie) => cookie.startsWith(`${grant.cookieName}=`)), 'request renewal writes only the received login grant, never selector')
    jar.apply(late)
    assert.equal(jar.get(secure.SESSION_COOKIE_NAME), newId)
    const currentRequest = new NextRequest('https://fx0.example/api/prompt', { headers: { cookie: jar.header() } })
    const current = await secure.getSessionFromRequest(currentRequest)
    assert.equal(current.userId, 'signature-verified-sub')
    assert.equal(current.teamId, 'team_callback')
    assert.equal(current.loginId, newId)
    assert.ok(current.loginAt > old.loginAt)
    assert.equal(current.accessToken, 'callback-access')
    const cleanup = await requestSession(currentRequest)
    jar.apply(cleanup)
    assert.equal(exchanges, 1, 'cleanup requires no additional identity/refresh network calls')
    assert.equal(jar.get(grant.cookieName), undefined, 'next request removes revived obsolete credentials')
    assert.equal(jar.get(secure.SESSION_COOKIE_NAME), newId)
    assert.equal(jar.get('theme'), 'dark')
  })

  test(`late ${outcome} old-user request-auth response cannot restore a logged-out selector`, async (t) => {
    const old = oldSession(`overlap-logout-${outcome}`)
    const grant = await secure.sealSessionCookie(old)
    const jar = browserCookies(`theme=dark; ${secure.SESSION_COOKIE_NAME}=${old.loginId}; ${grant.cookieName}=${grant.value}`)
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    let exchanges = 0
    mockOAuth(t, undefined, async () => {
      exchanges++
      started.resolve()
      await release.promise
      return terminal ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json({ access_token: 'late-old-access', refresh_token: 'late-old-refresh', expires_in: 3600 })
    })
    const pending = requestSession(new NextRequest('https://fx0.example/api/prompt', { headers: { cookie: jar.header() } }))
    await started.promise
    try {
      const logout = await signout(new NextRequest('https://fx0.example/api/auth/signout', {
        method: 'POST', headers: { cookie: jar.header(), origin: process.env.APP_URL },
      }))
      assert.equal(logout.status, 200)
      await globalThis.__signoutAfter
      assert.equal(globalThis.__signedOutUser, old.userId, 'parent runtime cancellation remains active')
      jar.apply(logout)
      assert.equal(jar.get(secure.SESSION_COOKIE_NAME), undefined)
      assert.equal(jar.get(grant.cookieName), undefined)
    } finally { release.resolve() }
    const late = await pending
    jar.apply(late)
    assert.ok(late.headers.getSetCookie().every((cookie) => cookie.startsWith(`${grant.cookieName}=`)))
    assert.equal(jar.get(secure.SESSION_COOKIE_NAME), undefined)
    const loggedOut = new NextRequest('https://fx0.example/api/prompt', { headers: { cookie: jar.header() } })
    assert.deepEqual(await secure.getSessionFromRequest(loggedOut), {})
    jar.apply(await requestSession(loggedOut))
    assert.equal(jar.get(grant.cookieName), undefined)
    assert.equal(jar.get(secure.SESSION_COOKIE_NAME), undefined)
    assert.equal(jar.get('theme'), 'dark')
    assert.equal(exchanges, 1)
  })
}

test('configuration error clears flow and lands on the login page without reflecting untrusted callback origin', async () => {
  const saved = process.env.APP_URL
  delete process.env.APP_URL
  try {
    const response = await GET(await callbackRequest())
    assert.equal(response.status, 307)
    // Relative: the browser stays on the host it asked for; no host is echoed back.
    assert.equal(response.headers.get('location'), '/login?error=signin_unavailable')
    assertFlowCleared(response)
  } finally { process.env.APP_URL = saved }
})
