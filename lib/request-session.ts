import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server.js'
// @ts-expect-error Node strip-types tests require the source extension.
import { SIGN_OUT_PENDING_COOKIE } from './session-cookies.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { needsTokenRefresh } from './auth.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { renewSessionCredential } from './auth-credential.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { forwardSessionCookie, grantCookieName, GRANT_COOKIE_PREFIX, isLoginId, logAuth, SESSION_COOKIE_NAME } from './auth-protocol.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { logTag } from './auth-crypto.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { getGrantFromRequest, getSessionFromRequest, isAuthenticatedSession, sealSessionCookie, type SessionCookie, type SessionData } from './secure-session.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { loginRevoked } from './turn-credential.ts'

type SessionHandler = (request: Request, session: Partial<SessionData>) => Response | Promise<Response>

// Purpose headers are untrusted: log only known directives, never arbitrary values.
function requestPurpose(value: string | null): string | null {
  if (value === null) return null
  const parts = value.toLowerCase().split(';').map((part) => part.trim())
  return value.length <= 80 && parts.length <= 3 && parts.every((part) =>
    ['prefetch', 'prerender', 'anonymous-client-ip'].includes(part)) ? parts.join(';') : 'other'
}

// Renewal belongs to the API request that consumes the credential. Pages only
// read identity, and login/logout own selector changes.
export function withRequestSession(body: SessionHandler) {
  return async (request: Request): Promise<Response> => {
    const cookies: SessionCookie[] = []
    const requestId = randomUUID()
    const startedAt = Date.now()
    // Page context is client-provided diagnostics, never authentication evidence.
    const page = request.headers.get('x-fx0-auth-page')
    const visibility = request.headers.get('x-fx0-auth-visibility')
    const prerender = request.headers.get('x-fx0-auth-prerender')
    const context: Record<string, unknown> = {
      request: requestId,
      page: page ? logTag('page', page) : null,
      purpose: requestPurpose(request.headers.get('purpose')),
      secPurpose: requestPurpose(request.headers.get('sec-purpose')),
      visibility: visibility === 'visible' || visibility === 'hidden' ? visibility : 'unknown',
      prerender: prerender === '1' ? true : prerender === '0' ? false : null,
    }
    let selectedName: string | undefined
    let incomingRt: string | null = null
    let selectedRt: string | null = null
    let preparedRt: string | null = null
    let preparedValue: string | undefined
    let outcome = 'anonymous'
    let stage = 'cookie-read'
    let handlerDispatched = false
    let response: Response
    try {
      const incoming = request instanceof NextRequest ? request : new NextRequest(request.url, { headers: request.headers })
      const selector = incoming.cookies.get(SESSION_COOKIE_NAME)?.value
      selectedName = isLoginId(selector) ? grantCookieName(selector) : undefined
      const incomingValue = selectedName ? incoming.cookies.get(selectedName)?.value : undefined
      Object.assign(context, {
        login: isLoginId(selector) ? logTag('login', selector) : null,
        selector: selector === undefined ? 'missing' : isLoginId(selector) ? 'valid' : 'invalid',
        grantCookie: incomingValue ? logTag('cookie', incomingValue) : null,
        signoutPending: incoming.cookies.get(SIGN_OUT_PENDING_COOKIE)?.value === '1',
      })
      const obsolete = incoming.cookies.getAll()
        .filter(({ name }) => name.startsWith(GRANT_COOKIE_PREFIX) && name !== selectedName &&
          isLoginId(name.slice(GRANT_COOKIE_PREFIX.length)))
        .slice(0, 8)
      cookies.push(...await Promise.all(obsolete.map(({ name }) => sealSessionCookie(null, name.slice(GRANT_COOKIE_PREFIX.length)))))

      const grant = await getGrantFromRequest(incoming)
      incomingRt = grant.refreshToken ? logTag('refresh', grant.refreshToken) : null
      selectedRt = incomingRt
      Object.assign(context, {
        user: isAuthenticatedSession(grant) ? logTag('user', grant.userId) : null,
        authenticated: isAuthenticatedSession(grant),
        publicationPending: !!grant.credentialPublication,
      })
      logAuth('auth:request:received', { ...context, rt: incomingRt })
      outcome = isAuthenticatedSession(grant) ? 'unchanged' : 'anonymous'
      stage = 'revocation'
      // A signed-out login's grant is no session, even replayed from a copy: the
      // request runs signed out, its grant cookie is cleared, and it never refreshes.
      const revoked = isAuthenticatedSession(grant) && await loginRevoked(grant.loginId)
      if (revoked) {
        cookies.push(await sealSessionCookie(null, grant.loginId))
        selectedRt = null
        outcome = 'revoked'
      }
      let sealed: SessionCookie | undefined
      let expiresAt = grant.expiresAt ?? 0
      let unavailable = false
      if (!revoked && isAuthenticatedSession(grant) && (needsTokenRefresh(grant) || grant.credentialPublication)) {
        stage = 'renewal'
        const result = await renewSessionCredential(grant, requestId)
        outcome = result.status
        unavailable = result.status === 'unavailable'
        stage = 'cookie-seal'
        if (result.status === 'terminal') {
          selectedRt = null
          sealed = await sealSessionCookie(null, grant.loginId)
        } else if (result.status === 'ok' || result.status === 'unavailable') {
          selectedRt = result.session.refreshToken ? logTag('refresh', result.session.refreshToken) : null
          expiresAt = result.session.expiresAt
          sealed = await sealSessionCookie(result.session)
          preparedRt = selectedRt
          preparedValue = sealed.value
        }
        if (sealed) cookies.push(sealed)
        if (result.status === 'ok' || result.status === 'terminal') {
          // Session age separates a token that outlived its grant from a recent
          // login whose rotated cookie never reached this browser.
          const now = Date.now()
          logAuth(result.status === 'ok' ? 'auth:session:renewed' : 'auth:session:ended', {
            user: logTag('user', grant.userId), login: logTag('login', grant.loginId), rt: logTag('refresh', grant.refreshToken!),
            sessionAgeS: Math.round((now - grant.loginAt) / 1000), accessExpiresInS: Math.round((grant.expiresAt - now) / 1000),
          }, result.status === 'ok' ? 'info' : 'error')
        }
      }

      if (unavailable || (!revoked && isAuthenticatedSession(grant) && expiresAt <= Date.now() && sealed?.value !== '')) {
        response = Response.json({ error: 'Authentication temporarily unavailable. Retry shortly.' }, {
          status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
        })
      } else {
        let forwarded = request
        let sessionRequest = incoming
        if (cookies.length) {
          let headers = new Headers(incoming.headers)
          for (const cookie of cookies) headers = forwardSessionCookie(headers, cookie.cookieName, cookie.value || null)
          // Next wraps route requests in a Proxy, which native Request cannot
          // clone. Rebuild from the URL; NextRequest handles streaming duplex.
          sessionRequest = new NextRequest(request.url, {
            method: request.method, headers, body: request.body, signal: request.signal,
          })
          forwarded = sessionRequest
        }
        stage = 'handler-session'
        const current = await getSessionFromRequest(sessionRequest)
        selectedRt = current.refreshToken ? logTag('refresh', current.refreshToken) : null
        stage = 'handler'
        handlerDispatched = true
        response = await body(forwarded, current)
      }
    } catch {
      outcome = 'error'
      logAuth('auth:request:failed', { ...context, rt: incomingRt, stage }, 'error')
      response = Response.json({ error: 'Request failed' }, { status: 503, headers: { 'cache-control': 'private, no-store' } })
    }

    // Keep rotation on errors and streams too. Rewrap headers without reading or
    // buffering the response body, which may already be an open event stream.
    const headers = new Headers(response.headers)
    for (const cookie of cookies) headers.append('set-cookie', cookie.setCookie)
    const outgoing = new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    const selectedCookies = selectedName ? outgoing.headers.getSetCookie()
      .filter((cookie) => cookie.startsWith(`${selectedName}=`)) : []
    const value = selectedCookies.length === 1 ? selectedCookies[0].slice(selectedName!.length + 1).split(';')[0] : undefined
    // This proves header preparation, not network delivery or browser acceptance.
    logAuth('auth:request:response', {
      ...context, incomingRt, selectedRt, outcome, handlerDispatched,
      status: outgoing.status, durationMs: Date.now() - startedAt,
      grantCookieAction: !selectedCookies.length ? 'none' : selectedCookies.length > 1 ? 'multiple' : value ? 'set' : 'clear',
      grantCookieCount: selectedCookies.length,
      preparedGrantCookie: value ? logTag('cookie', value) : null,
      preparedRt: value && value === preparedValue ? preparedRt : null,
    })
    return outgoing
  }
}
