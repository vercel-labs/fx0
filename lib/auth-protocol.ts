import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
// @ts-expect-error Node strip-types tests require the source extension.
import { equalSecret, redactSecrets } from './auth-crypto.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { AuthError } from './accounts.ts'

// Requests can run for 800s. Leave 100s for dispatch/clock overhead so a token
// accepted by the Gateway transport can cover an entire request.
export const MIN_GATEWAY_VALIDITY_MS = 15 * 60_000
export const SESSION_COOKIE_NAME = 'vercel_auth_session' // Selector, not credentials.
export const GRANT_COOKIE_PREFIX = 'vercel_auth_grant_'

// Sign-in failures reach the browser as a login-page message; the cause is
// logged here so a missing setting or provider error is visible in runtime logs.
export function logAuthFailure(event: string, error: unknown): void {
  const message = redactSecrets(String((error as Error)?.message ?? error)).slice(0, 200)
  console.error(JSON.stringify({ at: new Date().toISOString(), event, error: message }))
}

// Login, renewal and sign-out trail. Values are keyed logTag fingerprints,
// statuses and OAuth error codes, never credentials or provider bodies.
export function logAuth(event: string, detail: Record<string, unknown> = {}, level: 'info' | 'error' = 'info'): void {
  console[level](JSON.stringify({ at: new Date().toISOString(), event, ...detail }))
}

// Without a trusted origin there is nothing safe to put in an absolute URL, so the
// browser resolves this against the address it already requested.
export const SIGN_IN_UNAVAILABLE_PATH = '/login?error=signin_unavailable'

export function isLoginId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

export function grantCookieName(loginId: string): string {
  if (!isLoginId(loginId)) throw new Error('Invalid login ID')
  return `${GRANT_COOKIE_PREFIX}${loginId}`
}

// @ts-expect-error Node strip-types tests require the source extension.
export { SESSION_TTL_SECONDS, SIGNED_IN_HINT_COOKIE } from './session-cookies.ts'
export const FLOW_COOKIE_NAME = 'vercel_oauth_flow'
export const FLOW_TTL_SECONDS = 600
export const TOKEN_ENDPOINT = 'https://api.vercel.com/login/oauth/token'
export const FLOW_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/auth',
  maxAge: FLOW_TTL_SECONDS,
}

function appOrigin(appUrl = process.env.APP_URL): string {
  if (!appUrl) throw new Error('APP_URL is required')
  const url = new URL(appUrl)
  if (url.username || url.password || (url.protocol !== 'https:' &&
      !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:'))) {
    throw new Error('APP_URL must be a trusted HTTP(S) origin')
  }
  return url.origin
}

// A preview deployment has no fixed APP_URL: it answers on its deployment URL and
// its branch URL, both set by Vercel. Only those two hosts are trusted.
function previewOrigins(): string[] {
  if (process.env.VERCEL_ENV !== 'preview') return []
  return [process.env.VERCEL_BRANCH_URL, process.env.VERCEL_URL].filter((host): host is string => !!host).map((host) => `https://${host}`)
}

// The app's origin for this request: APP_URL when set, else the preview host the
// request came in on.
export function requestOrigin(request: Pick<Request, 'headers'>, appUrl = process.env.APP_URL): string {
  if (appUrl) return appOrigin(appUrl)
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const origin = previewOrigins().find((candidate) => host != null && candidate === `https://${host}`)
  return origin ?? appOrigin(appUrl)
}

export function assertSameOrigin(request: Pick<Request, 'headers'>, appUrl = process.env.APP_URL): void {
  const origin = request.headers.get('origin')
  const trusted = appUrl ? [appOrigin(appUrl)] : previewOrigins()
  if (!trusted.length) appOrigin(appUrl)
  if (!origin || !trusted.includes(origin)) throw new AuthError(403, 'Cross-origin request denied')
}

export interface OAuthFlow {
  purpose: 'oauth'
  state: string
  nonce: string
  codeVerifier: string
  createdAt: number
}

export function validOAuthFlow(flow: Partial<OAuthFlow>, state: string | null, now = Date.now()): flow is OAuthFlow {
  return flow.purpose === 'oauth' && equalSecret(state, flow.state) &&
    typeof flow.nonce === 'string' && flow.nonce.length > 0 &&
    typeof flow.codeVerifier === 'string' && flow.codeVerifier.length >= 43 &&
    typeof flow.createdAt === 'number' && flow.createdAt <= now &&
    now - flow.createdAt < FLOW_TTL_SECONDS * 1000
}

const vercelKeys = createRemoteJWKSet(new URL('https://vercel.com/.well-known/jwks'), { timeoutDuration: 10_000 })

export async function verifyVercelIdToken(token: string, params: { clientId: string; nonce: string }, keys: JWTVerifyGetKey = vercelKeys) {
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ['RS256'],
    issuer: 'https://vercel.com',
    audience: params.clientId,
    requiredClaims: ['sub', 'exp', 'nonce', 'email'],
  })
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 ||
      typeof payload.email !== 'string' || !payload.email ||
      typeof payload.nonce !== 'string' || !equalSecret(payload.nonce, params.nonce) ||
      (typeof payload.iat === 'number' && payload.iat > Math.floor(Date.now() / 1000))) {
    throw new AuthError(401, 'Invalid identity token')
  }
  return {
    userId: payload.sub,
    email: payload.email,
    name: typeof payload.name === 'string' ? payload.name :
      typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  }
}

export interface OAuthTokens {
  access_token: string
  refresh_token?: string
  expires_in: number
  id_token?: string
}

export function validOAuthTokens(value: unknown): value is OAuthTokens {
  if (!value || typeof value !== 'object') return false
  const tokens = value as Partial<OAuthTokens>
  return typeof tokens.access_token === 'string' && tokens.access_token.length > 0 &&
    typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 &&
    Number.isSafeInteger(Math.ceil(tokens.expires_in * 1000)) &&
    (tokens.refresh_token === undefined || (typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0))
}

// Refresh and cleanup may rewrite grants only, never the login selector.
export function forwardSessionCookie(headers: Headers, cookieName: string, value: string | null): Headers {
  if (!cookieName.startsWith(GRANT_COOKIE_PREFIX) || !isLoginId(cookieName.slice(GRANT_COOKIE_PREFIX.length))) {
    throw new Error('Only grant cookies may be forwarded')
  }
  const forwarded = new Headers(headers)
  const entries = (headers.get('cookie') ?? '').split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry.slice(0, entry.indexOf('=')) !== cookieName)
  if (value) entries.push(`${cookieName}=${value}`)
  if (entries.length) forwarded.set('cookie', entries.join('; '))
  else forwarded.delete('cookie')
  return forwarded
}
