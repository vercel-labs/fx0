import { after, NextResponse, type NextRequest } from 'next/server'
import { AuthError } from '@/lib/accounts'
import { revokeAccessToken } from '@/lib/auth'
import { logTag } from '@/lib/auth-crypto'
import { assertSameOrigin, logAuth, FLOW_COOKIE_NAME, FLOW_COOKIE_OPTIONS, isLoginId, SESSION_COOKIE_NAME } from '@/lib/auth-protocol'
import { getSessionForSignOut, sealSessionCookie, selectorCookie } from '@/lib/secure-session'
import { signedInHintCookie, signOutPendingCookie } from '@/lib/session-cookies'
import { revokeLoginCredentials } from '@/lib/turn-credential'

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request)
  } catch (error) {
    return NextResponse.json({ error: 'Sign out denied' }, { status: error instanceof AuthError ? error.status : 503 })
  }
  const { userId, loginId: sessionLoginId, accessToken } = await getSessionForSignOut(request)
  // Fence every stored credential with one write, independent of chat count.
  // Keep cookies on failure so the user can retry without a false success.
  try {
    if (userId && sessionLoginId) await revokeLoginCredentials(sessionLoginId)
  } catch {
    return NextResponse.json({ error: 'Unable to sign out. Retry shortly.' }, {
      status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
    })
  }
  if (userId && sessionLoginId) logAuth('auth:signout', { user: logTag('user', userId), login: logTag('login', sessionLoginId) })
  // Workers reject the revoked login even if cleanup or provider revocation
  // fails after the response. Neither needs to delay the browser.
  after(() => Promise.all([
    userId && import('@/lib/agent').then(({ cancelUserRuntime }) =>
      // Only this login's work: the same user's other signed-in browsers keep running.
      cancelUserRuntime(userId, sessionLoginId)),
    accessToken && revokeAccessToken(accessToken),
  ]))
  const loginId = request.cookies.get(SESSION_COOKIE_NAME)?.value
  const cleared = isLoginId(loginId) ? await sealSessionCookie(null, loginId) : null
  // No Clear-Site-Data: Chrome scans its whole disk cache for it and stalls the page
  // for seconds. Cached previews revalidate against the session instead.
  const response = NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } })
  response.cookies.set(FLOW_COOKIE_NAME, '', { ...FLOW_COOKIE_OPTIONS, maxAge: 0 })
  if (cleared) response.headers.append('set-cookie', cleared.setCookie)
  response.headers.append('set-cookie', selectorCookie(null).setCookie)
  response.headers.append('set-cookie', signedInHintCookie(false, process.env.NODE_ENV === 'production'))
  response.headers.append('set-cookie', signOutPendingCookie(false, process.env.NODE_ENV === 'production'))
  return response
}
