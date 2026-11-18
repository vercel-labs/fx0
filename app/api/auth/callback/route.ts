import { randomBytes } from 'node:crypto'
import { unsealData } from 'iron-session'
import { NextResponse, type NextRequest } from 'next/server'
import { AuthError, upsertAccount } from '@/lib/accounts'
import { getGrantedTeam, publicUser, type TeamProbe } from '@/lib/auth'
import { logTag } from '@/lib/auth-crypto'
import { getSessionOptions, sealSessionCookie, selectorCookie, type SessionData } from '@/lib/secure-session'
import { signedInHintCookie, signOutPendingCookie } from '@/lib/session-cookies'
import {
  logAuth, logAuthFailure, requestOrigin, SIGN_IN_UNAVAILABLE_PATH, FLOW_COOKIE_NAME, FLOW_COOKIE_OPTIONS, FLOW_TTL_SECONDS, TOKEN_ENDPOINT,
  isLoginId, SESSION_COOKIE_NAME, validOAuthFlow, validOAuthTokens, verifyVercelIdToken, type OAuthFlow,
} from '@/lib/auth-protocol'

export async function GET(request: NextRequest) {
  // Read first: request data keeps this handler out of the build's prerender.
  const params = request.nextUrl.searchParams
  let response: NextResponse
  let origin: string | undefined
  let consentRetry = false
  const sessionCookies: string[] = []
  try {
    origin = requestOrigin(request)
    const clientId = process.env.VERCEL_OAUTH_CLIENT_ID
    const clientSecret = process.env.VERCEL_OAUTH_CLIENT_SECRET
    if (!clientId || !clientSecret) throw new Error('OAuth is not configured')
    const sealedFlow = request.cookies.get(FLOW_COOKIE_NAME)?.value
    if (params.has('error') || !params.get('code') || !sealedFlow) throw new AuthError(400, 'Sign in failed')
    const flow = await unsealData<Partial<OAuthFlow>>(sealedFlow, { password: getSessionOptions().password, ttl: FLOW_TTL_SECONDS })
    if (!validOAuthFlow(flow, params.get('state'))) throw new AuthError(400, 'Sign in failed')

    const exchanged = await fetch(TOKEN_ENDPOINT, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
        client_secret: clientSecret, code: params.get('code')!, code_verifier: flow.codeVerifier,
        redirect_uri: `${origin}/api/auth/callback` }),
    })
    if (!exchanged.ok) throw new AuthError(401, 'Sign in failed')
    const tokens: unknown = await exchanged.json()
    if (!validOAuthTokens(tokens) || typeof tokens.id_token !== 'string' || !tokens.refresh_token) {
      throw new AuthError(401, 'Sign in failed')
    }
    const expiresAt = Date.now() + tokens.expires_in * 1000
    const identity = await verifyVercelIdToken(tokens.id_token, { clientId, nonce: flow.nonce })
    const probes: TeamProbe[] = []
    const team = await getGrantedTeam(tokens.access_token, probes).catch((error: unknown) => {
      if (!(error instanceof AuthError) || error.status !== 403) throw error
      // Vercel skips its consent page for an app the user already authorized, so
      // a team that needs a fresh SSO or Gateway grant is never offered again and
      // every probe is refused. Forcing the consent page once lets the user grant
      // it; a sign-in that already forced it shows the error.
      consentRetry = flow.consent !== true
      const statuses: Record<string, number> = {}
      for (const { status } of probes) statuses[status] = (statuses[status] ?? 0) + 1
      logAuth('auth:callback:no-gateway-team', { user: logTag('user', identity.userId), consent: flow.consent === true,
        retry: consentRetry, teams: probes.length, statuses, probes: probes.slice(0, 20) }, 'error')
      throw error
    })
    const session: SessionData = { ...identity, ...team, loginId: randomBytes(16).toString('hex'), loginAt: Date.now(),
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt, isLoggedIn: true }
    // Parent-owned account persistence receives identity only, never credentials.
    await upsertAccount(publicUser(session))
    const cookie = await sealSessionCookie(session)
    response = NextResponse.redirect(new URL('/', origin))
    // Clearing the prior cookie is best effort; never revoke an ongoing grant.
    // A late refresh can recreate it, but cannot change this new selector.
    const previous = request.cookies.get(SESSION_COOKIE_NAME)?.value
    if (request.nextUrl.origin === origin && isLoginId(previous) && previous !== session.loginId) {
      sessionCookies.push((await sealSessionCookie(null, previous)).setCookie)
    }
    sessionCookies.push(selectorCookie(session.loginId).setCookie, cookie.setCookie,
      signedInHintCookie(true, process.env.NODE_ENV === 'production'),
      signOutPendingCookie(false, process.env.NODE_ENV === 'production'))
    logAuth('auth:login', { user: logTag('user', session.userId), login: logTag('login', session.loginId), rt: logTag('refresh', tokens.refresh_token),
      replaced: isLoginId(previous) && previous !== session.loginId ? logTag('login', previous) : null })
  } catch (error) {
    logAuthFailure('auth:callback:failed', error)
    response = !origin
      ? new NextResponse(null, { status: 307, headers: { Location: SIGN_IN_UNAVAILABLE_PATH } })
      : consentRetry
        ? NextResponse.redirect(new URL('/api/auth/signin?reauth=true', origin))
        : NextResponse.redirect(new URL(`/login?error=${error instanceof AuthError && error.status === 403 ? 'team_access' : 'signin_failed'}`, origin))
  }
  // All exits, including provider denial, malformed state, and config errors.
  response.cookies.set(FLOW_COOKIE_NAME, '', { ...FLOW_COOKIE_OPTIONS, maxAge: 0 })
  for (const cookie of sessionCookies) response.headers.append('set-cookie', cookie)
  response.headers.set('Cache-Control', 'no-store')
  return response
}
