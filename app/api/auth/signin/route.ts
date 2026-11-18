import { sealData } from 'iron-session'
import { NextResponse, type NextRequest } from 'next/server'
import { randomHandle, pkceChallenge } from '@/lib/auth-crypto'
import { getSessionOptions } from '@/lib/secure-session'
import { logAuthFailure, requestOrigin, SIGN_IN_UNAVAILABLE_PATH, FLOW_COOKIE_NAME, FLOW_COOKIE_OPTIONS, FLOW_TTL_SECONDS, type OAuthFlow } from '@/lib/auth-protocol'

export async function GET(request: NextRequest) {
  // Read first: request data keeps this handler out of the build's prerender.
  const reauth = request.nextUrl.searchParams.get('reauth') === 'true'
  try {
    const clientId = process.env.VERCEL_OAUTH_CLIENT_ID
    if (!clientId || !process.env.VERCEL_OAUTH_CLIENT_SECRET) throw new Error('OAuth is not configured')
    const origin = requestOrigin(request)
    const flow: OAuthFlow = { purpose: 'oauth', state: randomHandle(), nonce: randomHandle(), codeVerifier: randomHandle(), createdAt: Date.now() }
    const url = new URL('https://vercel.com/oauth/authorize')
    url.search = new URLSearchParams({
      client_id: clientId, redirect_uri: `${origin}/api/auth/callback`, response_type: 'code',
      scope: 'openid profile email offline_access', state: flow.state, nonce: flow.nonce,
      code_challenge: pkceChallenge(flow.codeVerifier), code_challenge_method: 'S256',
      // Each sign-in grants one team; more teams come from another consent.
      teamSelection: 'single-team',
      ...(reauth ? { prompt: 'consent' } : {}),
    }).toString()
    const response = NextResponse.redirect(url)
    const value = await sealData(flow, { password: getSessionOptions().password, ttl: FLOW_TTL_SECONDS })
    response.cookies.set(FLOW_COOKIE_NAME, value, FLOW_COOKIE_OPTIONS)
    response.headers.set('Cache-Control', 'no-store')
    return response
  } catch (error) {
    logAuthFailure('auth:signin:unavailable', error)
    return new NextResponse(null, { status: 307, headers: { Location: SIGN_IN_UNAVAILABLE_PATH, 'Cache-Control': 'no-store' } })
  }
}
