import { sealData, unsealData, type SessionOptions } from 'iron-session'
import { cookies } from 'next/headers.js'
import { cache } from 'react'
import { NextResponse, type NextRequest } from 'next/server.js'
// @ts-expect-error Node strip-types tests require the source extension.
import { grantCookieName, isLoginId, SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from './auth-protocol.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { SIGN_OUT_PENDING_COOKIE } from './session-cookies.ts'

export { grantCookieName, SESSION_COOKIE_NAME, SESSION_TTL_SECONDS }

export interface SessionData {
  loginId: string // New random selector for every completed OAuth login.
  loginAt: number // Login issuance in milliseconds; refresh never changes it.
  userId: string // Only the signature-verified OIDC sub; never email or a team ID.
  email: string
  name?: string
  picture?: string
  accessToken: string
  refreshToken?: string
  // Only present when a provider rotation has not yet reached durable storage.
  credentialPublication?: { previous: string; previousToken?: string; validUntil: number }
  expiresAt: number
  teamId?: string
  teamSlug?: string
  isLoggedIn: boolean
}

export function getSessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET
  if (!password || password.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters')
  return {
    password,
    cookieName: SESSION_COOKIE_NAME,
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_TTL_SECONDS,
      path: '/',
    },
  }
}

// The billing team the user picked in the app. It lives apart from the grant so
// choosing a team never reseals tokens another request may be rotating.
export const TEAM_COOKIE_NAME = 'fx0_team'
interface TeamChoice { loginId: string; teamId: string; teamSlug: string }

async function readSession(store: { get(name: string): { value: string } | undefined }, withTeamChoice = true, forSignOut = false): Promise<Partial<SessionData>> {
  if (!forSignOut && store.get(SIGN_OUT_PENDING_COOKIE)?.value === '1') return {}
  const loginId = store.get(SESSION_COOKIE_NAME)?.value
  if (!isLoginId(loginId)) return {}
  const value = store.get(grantCookieName(loginId))?.value
  if (!value) return {}
  const { password, ttl } = getSessionOptions()
  const session = await unsealData<Partial<SessionData>>(value, { password, ttl })
  // The unsigned pointer confers no authority: the selected seal must agree.
  if (!isAuthenticatedSession(session) || session.loginId !== loginId) return {}
  const sealedChoice = withTeamChoice ? store.get(TEAM_COOKIE_NAME)?.value : undefined
  if (!sealedChoice) return session
  const choice = await unsealData<Partial<TeamChoice>>(sealedChoice, { password, ttl }).catch(() => ({} as Partial<TeamChoice>))
  // A choice from another login (or a forged one) is ignored, never trusted.
  return choice.loginId === loginId && choice.teamId?.startsWith('team_') && typeof choice.teamSlug === 'string'
    ? { ...session, teamId: choice.teamId, teamSlug: choice.teamSlug }
    : session
}

// Read-only payloads, not IronSession.save(): hot-path readers cannot overwrite
// a rotated token. React deduplicates only within an RSC render, never globally.
export const getSession = cache(async (): Promise<Partial<SessionData>> => readSession(await cookies()))

export async function getSessionFromRequest(request: NextRequest): Promise<Partial<SessionData>> {
  return readSession(request.cookies)
}

// The grant as sealed, without the team choice: what renewal must reseal.
export async function getGrantFromRequest(request: NextRequest): Promise<Partial<SessionData>> {
  return readSession(request.cookies, false)
}

// Logout still needs the sealed grant to revoke it after the browser has
// synchronously marked the session as unavailable to normal readers.
export async function getSessionForSignOut(request: NextRequest): Promise<Partial<SessionData>> {
  return readSession(request.cookies, false, true)
}

export function isAuthenticatedSession(session: Partial<SessionData>): session is SessionData {
  return session.isLoggedIn === true && isLoginId(session.loginId) &&
    typeof session.loginAt === 'number' && Number.isSafeInteger(session.loginAt) && session.loginAt > 0 &&
    typeof session.userId === 'string' && !!session.userId && session.userId.length <= 256 &&
    typeof session.email === 'string' && !!session.email &&
    typeof session.accessToken === 'string' && !!session.accessToken &&
    typeof session.expiresAt === 'number' && Number.isFinite(session.expiresAt) && session.expiresAt > 0 &&
    (['name', 'picture', 'refreshToken', 'teamId', 'teamSlug'] as const)
      .every((field) => session[field] === undefined || typeof session[field] === 'string')
}

export interface SessionCookie { cookieName: string; value: string; setCookie: string }

function cookieHeader(cookieName: string, value: string, maxAge: number): SessionCookie {
  const carrier = NextResponse.next()
  carrier.cookies.set(cookieName, value, { ...getSessionOptions().cookieOptions, maxAge })
  const setCookie = carrier.headers.get('set-cookie')!
  if (Buffer.byteLength(setCookie) > 4096) throw new Error('Session cookie exceeds browser size limit')
  return { cookieName, value, setCookie }
}

// Callback and sign-out only. Refresh never renews or removes the selector.
export function selectorCookie(loginId: string | null): SessionCookie {
  if (loginId !== null && !isLoginId(loginId)) throw new Error('Invalid login ID')
  return cookieHeader(SESSION_COOKIE_NAME, loginId ?? '', loginId ? SESSION_TTL_SECONDS : 0)
}

// A clear must explicitly name the old grant; it must never clear the selector.
export async function sealSessionCookie(data: SessionData | null, loginId = data?.loginId): Promise<SessionCookie> {
  const cookieName = grantCookieName(loginId ?? '')
  if (data && (!isAuthenticatedSession(data) || data.loginId !== loginId)) throw new Error('Invalid session payload')
  const options = getSessionOptions()
  const value = data ? await sealData(data, { password: options.password, ttl: options.ttl }) : ''
  return cookieHeader(cookieName, value, data ? SESSION_TTL_SECONDS : 0)
}

// Callers must have verified, with the user's own token, that Gateway accepts the team.
export async function teamCookie(loginId: string, team: { teamId: string; teamSlug: string }): Promise<SessionCookie> {
  const options = getSessionOptions()
  const value = await sealData({ loginId, ...team } satisfies TeamChoice, { password: options.password, ttl: options.ttl })
  return cookieHeader(TEAM_COOKIE_NAME, value, SESSION_TTL_SECONDS)
}
