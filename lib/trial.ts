import { createHmac, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { sealData, unsealData } from 'iron-session'
import { cookies } from 'next/headers.js'
// @ts-expect-error Node strip-types tests require the source extension.
import { AuthError, type AccountUser } from './accounts.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { getSessionOptions } from './secure-session.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { prefixed, redis } from './journal.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { FREE_PROMPTS } from './trial-policy.ts'

export const GUEST_COOKIE = 'fx0_guest'
const GUEST_TTL = 30 * 24 * 60 * 60

export interface GuestSession {
  kind: 'guest'
  userId: string
  loginId: string
  loginAt: number
  expiresAt: number
}

// A worker receives proof of sponsored admission, never the deployment key.
export interface TrialCredential {
  kind: 'trial'
  userId: string
  loginId: string
  expiresAt: number
  teamId?: never
  accessToken?: never
}

export function trialEnabled(): boolean {
  return process.env.FX0_FREE_PROMPTS === '1' && !!process.env.AI_GATEWAY_API_KEY
}

export function newGuestSession(): GuestSession {
  const loginId = randomBytes(16).toString('hex')
  const loginAt = Date.now()
  return { kind: 'guest', userId: `guest:${loginId}`, loginId, loginAt, expiresAt: loginAt + GUEST_TTL * 1000 }
}

export function guestUser(session: GuestSession): AccountUser {
  return { id: session.userId, name: 'You', email: null, picture: null, guest: true }
}

export async function sealGuestSession(session: GuestSession): Promise<string> {
  return sealData(session, { password: getSessionOptions().password, ttl: GUEST_TTL })
}

export async function readGuestSession(value?: string): Promise<GuestSession | null> {
  if (!value) return null
  try {
    const session = await unsealData<Partial<GuestSession>>(value, { password: getSessionOptions().password, ttl: GUEST_TTL })
    return session.kind === 'guest' && typeof session.loginId === 'string' && /^[0-9a-f]{32}$/.test(session.loginId) &&
      session.userId === `guest:${session.loginId}` && typeof session.loginAt === 'number' && session.loginAt > 0 &&
      typeof session.expiresAt === 'number' && Number.isFinite(session.expiresAt) && session.expiresAt > Date.now()
      ? { kind: 'guest', userId: session.userId, loginId: session.loginId, loginAt: session.loginAt, expiresAt: session.expiresAt }
      : null
  } catch { return null }
}

export async function getGuestSession(): Promise<GuestSession | null> {
  return readGuestSession((await cookies()).get(GUEST_COOKIE)?.value)
}

export async function createGuestSession(): Promise<GuestSession> {
  if (!trialEnabled()) throw new AuthError()
  const session = newGuestSession()
  ;(await cookies()).set(GUEST_COOKIE, await sealGuestSession(session), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: GUEST_TTL,
  })
  return session
}

// Once a signed-in request has claimed the guest's chats, the guest cookie has no use left
// (the free prompt allowance is counted per IP, not per guest), so it is dropped.
export async function clearGuestSession(): Promise<void> {
  ;(await cookies()).delete(GUEST_COOKIE)
}

// Vercel overwrites this header. Outside Vercel, only local development is
// supported; accepting a caller's forwarded IP there would reset the allowance.
export function trialIpHash(headers: Headers): string {
  const raw = process.env.VERCEL === '1' ? headers.get('x-forwarded-for')?.trim()
    : process.env.NODE_ENV === 'development' ? '127.0.0.1' : null
  if (!raw || !isIP(raw)) throw new AuthError(503, 'Unable to verify the free prompt allowance')
  return createHmac('sha256', getSessionOptions().password as string).update(`fx0-trial:${allowanceAddress(raw)}`).digest('hex')
}

// One IPv6 user controls a whole /64, so the prefix, not the address, shares an allowance.
export function allowanceAddress(address: string): string {
  if (isIP(address) !== 6) return address
  const [head, tail = ''] = new URL(`http://[${address}]/`).hostname.slice(1, -1).split('::')
  const side = (part: string) => part ? part.split(':') : []
  const groups = [...side(head), ...Array(8 - side(head).length - side(tail).length).fill('0'), ...side(tail)]
  const mapped = groups.slice(0, 5).every((group) => Number.parseInt(group, 16) === 0) && groups[5] === 'ffff'
  if (mapped) return [groups[6], groups[7]].flatMap((group) => [Number.parseInt(group, 16) >> 8, Number.parseInt(group, 16) & 255]).join('.')
  return `${groups.slice(0, 4).map((group) => group.padStart(4, '0')).join(':')}::/64`
}

export interface TrialReservation { bucket: string; clientId: string; token: string; remaining: number }
interface TrialRedis {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>
}

// The bucket and its at-most-five admitted IDs have no periodic reset. Clearing
// cookies or creating more chats cannot grant another five prompts.
const RESERVE = `
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then return -2 end
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[3]) then return -1 end
redis.call('INCR', KEYS[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
return tonumber(ARGV[3]) - used - 1
`
const SETTLE = `
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
if ARGV[3] == 'commit' then
  redis.call('HSET', KEYS[2], ARGV[1], 'accepted')
else
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('DECR', KEYS[1])
end
return 1
`

export function createTrialStore(client: TrialRedis, prefix: string) {
  const keys = (bucket: string) => [`${prefix}:${bucket}:used`, `${prefix}:${bucket}:admissions`]
  return {
    async remaining(bucket: string): Promise<number> {
      const used = Number(await client.eval("return tonumber(redis.call('GET', KEYS[1]) or '0')", [keys(bucket)[0]], []))
      if (!Number.isSafeInteger(used) || used < 0 || used > FREE_PROMPTS) throw new Error('Invalid trial allowance')
      return FREE_PROMPTS - used
    },
    async reserve(bucket: string, clientId: string): Promise<TrialReservation | null> {
      const token = randomBytes(16).toString('hex')
      const remaining = Number(await client.eval(RESERVE, keys(bucket), [clientId, token, FREE_PROMPTS]))
      if (remaining === -2) throw new AuthError(409, 'This prompt was already submitted')
      if (remaining === -1) return null
      if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining >= FREE_PROMPTS) throw new Error('Invalid trial allowance')
      return { bucket, clientId, token, remaining }
    },
    async commit(reservation: TrialReservation): Promise<void> {
      const result = await client.eval(SETTLE, keys(reservation.bucket), [reservation.clientId, reservation.token, 'commit'])
      if (Number(result) !== 1) throw new Error('Trial admission was not reserved')
    },
    async release(reservation: TrialReservation): Promise<void> {
      await client.eval(SETTLE, keys(reservation.bucket), [reservation.clientId, reservation.token, 'release'])
    },
  }
}

export function trialStore() {
  return createTrialStore(redis(), prefixed('trial'))
}

export async function remainingFreePrompts(headers: Headers): Promise<number | null> {
  return trialEnabled() ? trialStore().remaining(trialIpHash(headers)) : null
}
