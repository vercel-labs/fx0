import { Redis } from '@upstash/redis'
import { sealData, unsealData } from 'iron-session'
// @ts-expect-error Node strip-types tests require the source extension.
import { AuthError, type AccountUser } from './accounts.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { hashHandle, logTag, randomHandle } from './auth-crypto.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { getSession, getSessionOptions, isAuthenticatedSession, type SessionData } from './secure-session.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { logAuth, MIN_GATEWAY_VALIDITY_MS, TOKEN_ENDPOINT, validOAuthTokens, type OAuthTokens } from './auth-protocol.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { loginRevoked } from './turn-credential.ts'

// Pages read identity here. A signed-out login's grant is no session, even
// replayed from a copy: sign-out records the revocation before it answers.
export async function requireUserSession(): Promise<SessionData> {
  const session = await getSession()
  if (!isAuthenticatedSession(session) || await loginRevoked(session.loginId)) throw new AuthError()
  return session
}

export function publicUser(session: SessionData): AccountUser {
  return { id: session.userId, name: session.name || session.email, email: session.email, picture: session.picture || null }
}

export interface GrantedTeam { teamId: string; teamSlug: string }
// The probe is the team's credits endpoint, so its balance comes for free. Never
// sealed into a cookie: only the GrantedTeam fields are.
export interface GatewayTeam extends GrantedTeam { balance: number | null }

// Membership does not prove Gateway authorization; probe every returned team and
// never substitute a default team, user ID, or owner's token.
export async function listGatewayTeams(accessToken: string): Promise<GatewayTeam[]> {
  let cursor: number | undefined
  const seen = new Set<string>()
  const granted: GatewayTeam[] = []
  let failedProbes = 0
  for (let page = 0; page < 10; page++) {
    const url = new URL('https://api.vercel.com/v2/teams')
    url.searchParams.set('limit', '100')
    if (cursor !== undefined) url.searchParams.set('until', String(cursor))
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store', signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new AuthError(response.status === 401 || response.status === 403 ? 403 : 503, 'Unable to verify team access')
    const data = await response.json() as { teams?: { id?: string; slug?: string }[]; pagination?: { next?: number | null } }
    const candidates = (data.teams ?? []).filter((team): team is { id: string; slug?: string } =>
      typeof team.id === 'string' && team.id.startsWith('team_') && !seen.has(team.id))
    for (const team of candidates) seen.add(team.id)
    const probes = await Promise.all(candidates.map(async (team) => {
      try {
        const probe = await fetch(`https://ai-gateway.vercel.sh/v1/credits?teamId=${encodeURIComponent(team.id)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          cache: 'no-store', signal: AbortSignal.timeout(10_000),
        })
        if (probe.status === 401 || probe.status === 403) return null
        if (!probe.ok) return 'failed' as const
        const { balance } = await probe.json().catch(() => ({})) as { balance?: string }
        const amount = Number(balance)
        return { teamId: team.id, teamSlug: team.slug || team.id, balance: balance != null && Number.isFinite(amount) ? amount : null }
      } catch {
        return 'failed' as const
      }
    }))
    for (const team of probes) {
      if (team === 'failed') failedProbes++
      else if (team) granted.push(team)
    }
    const next = data.pagination?.next
    if (typeof next !== 'number' || !Number.isFinite(next) || next === cursor) break
    cursor = next
  }
  // One throttled or failing probe hides that team only. With nothing verified and
  // some probes unanswered, access is unknown rather than denied.
  if (!granted.length && failedProbes) throw new AuthError(503, 'Unable to verify team access')
  return granted
}

// Callback default only: the first team Gateway accepts. Users with several can
// pick another in the account menu (POST /api/teams).
export async function getGrantedTeam(accessToken: string): Promise<GrantedTeam> {
  const [first] = await listGatewayTeams(accessToken)
  if (!first) throw new AuthError(403, 'Grant a Vercel team with AI Gateway access')
  return { teamId: first.teamId, teamSlug: first.teamSlug }
}

// Read-only and network-free. A rejected/missing grant requires new consent;
// resealing a corrected team here could overwrite a concurrently renewed token.
export async function resolveGrantedTeam(session: Pick<SessionData, 'teamId' | 'teamSlug'>): Promise<GrantedTeam> {
  if (!session.teamId?.startsWith('team_')) throw new AuthError(403, 'Grant a Vercel team with AI Gateway access')
  return { teamId: session.teamId, teamSlug: session.teamSlug || session.teamId }
}

export async function revokeAccessToken(accessToken: string): Promise<void> {
  const clientId = process.env.VERCEL_OAUTH_CLIENT_ID
  const secret = process.env.VERCEL_OAUTH_CLIENT_SECRET
  if (!accessToken || !clientId || !secret) return
  try {
    await fetch(`${TOKEN_ENDPOINT}/revoke`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: accessToken }),
    })
  } catch { /* Best effort: neither provider bodies nor credentials enter logs. */ }
}

export type RefreshResult =
  | { status: 'ok'; tokens: OAuthTokens; expiresAt: number }
  | { status: 'terminal' }
  | { status: 'transient' }

const REFRESH_LEASE_SECONDS = 30
const REFRESH_RESULT_SECONDS = 120
const REFRESH_WAIT_MS = 11_000

// This is the only injected test boundary. Values crossing it are iron-sealed;
// keys contain SHA256(old refresh token), never plaintext credentials.
export interface RefreshCache {
  get(key: string): Promise<string | null>
  acquire(key: string, owner: string, ttl: number): Promise<boolean>
  publish(key: string, owner: string, value: string, ttl: number): Promise<boolean>
  release(key: string, owner: string): Promise<void>
}

export function needsTokenRefresh(session: Partial<SessionData>, now = Date.now()): boolean {
  return isAuthenticatedSession(session) && !!session.refreshToken && session.expiresAt <= now + MIN_GATEWAY_VALIDITY_MS
}

export function sessionWithRefresh(session: SessionData, result: Extract<RefreshResult, { status: 'ok' }>): SessionData {
  return { ...session, accessToken: result.tokens.access_token,
    refreshToken: result.tokens.refresh_token ?? session.refreshToken, expiresAt: result.expiresAt }
}

export function createRefreshCoordinator(boundary: { fetch: typeof fetch; cache: RefreshCache }) {
  const inFlight = new Map<string, Promise<RefreshResult>>()

  async function exchange(refreshToken: string): Promise<RefreshResult> {
    const clientId = process.env.VERCEL_OAUTH_CLIENT_ID
    const clientSecret = process.env.VERCEL_OAUTH_CLIENT_SECRET
    const rt = logTag('refresh', refreshToken)
    if (!clientId || !clientSecret) {
      logAuth('auth:refresh:unconfigured', {}, 'error')
      return { status: 'transient' }
    }
    try {
      const response = await boundary.fetch(TOKEN_ENDPOINT, {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error.slice(0, 64) : null
        logAuth('auth:refresh:rejected', { rt, status: response.status, error: code }, 'error')
        return code === 'invalid_grant' && response.status === 400 ? { status: 'terminal' } : { status: 'transient' }
      }
      if (!validOAuthTokens(body)) {
        logAuth('auth:refresh:malformed', { rt, status: response.status }, 'error')
        return { status: 'transient' }
      }
      // ID tokens are not needed by refresh and must not inflate cached results.
      const tokens = { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in }
      // rt -> next links a later rejection of rt to this exchange (a replayed token).
      logAuth('auth:refresh:exchanged', { rt, next: logTag('refresh', tokens.refresh_token ?? refreshToken), expiresIn: tokens.expires_in })
      return { status: 'ok', tokens, expiresAt: Date.now() + tokens.expires_in * 1000 }
    } catch (error) {
      logAuth('auth:refresh:error', { rt, error: (error as Error)?.name ?? 'Error' }, 'error')
      return { status: 'transient' }
    }
  }

  async function coordinated(refreshToken: string, key: string): Promise<RefreshResult> {
    const rt = logTag('refresh', refreshToken)
    try {
      const password = getSessionOptions().password
      async function cached(): Promise<RefreshResult | null> {
        const value = await boundary.cache.get(key)
        if (!value) return null
        const entry = await unsealData<{ key: string; result: RefreshResult; expiresAt: number }>(value, { password, ttl: REFRESH_RESULT_SECONDS })
        if (entry.key !== key || !(entry.expiresAt > Date.now()) || !entry.result ||
            !['ok', 'terminal', 'transient'].includes(entry.result.status) ||
            (entry.result.status === 'ok' && (!validOAuthTokens(entry.result.tokens) || !Number.isFinite(entry.result.expiresAt)))) {
          throw new Error('Invalid refresh cache result')
        }
        // Older builds cached transient failures; one blip must not be replayed.
        if (entry.result.status === 'transient') return null
        logAuth('auth:refresh:reused', { rt, status: entry.result.status })
        return entry.result
      }
      const prior = await cached()
      if (prior) return prior
      const owner = randomHandle()
      if (!await boundary.cache.acquire(key, owner, REFRESH_LEASE_SECONDS)) {
        const deadline = Date.now() + REFRESH_WAIT_MS
        do {
          await new Promise((resolve) => setTimeout(resolve, 100))
          const result = await cached()
          if (result) return result
        } while (Date.now() < deadline)
        // Do not exchange a stale token while another instance owns its lease.
        logAuth('auth:refresh:wait_timeout', { rt }, 'error')
        return { status: 'transient' }
      }
      // Another owner may have published between our first read and acquire.
      const raced = await cached()
      if (raced) return raced
      const result = await exchange(refreshToken)
      if (result.status === 'transient') {
        // Not published: the refresh token is still unused, so the next request on
        // any instance exchanges it again instead of replaying this failure.
        await boundary.cache.release(key, owner).catch(() => {})
        return result
      }
      const value = await sealData({ key, result, expiresAt: Date.now() + REFRESH_RESULT_SECONDS * 1000 }, { password, ttl: REFRESH_RESULT_SECONDS })
      // A rotation already succeeded: still persist it in this browser rather
      // than discard its only live refresh token. The unreleased lease expires.
      // Unpublished, other instances holding rt will exchange it again and fail.
      const published = await boundary.cache.publish(key, owner, value, REFRESH_RESULT_SECONDS)
        .catch((error) => (error as Error)?.name ?? 'Error')
      if (published !== true) {
        logAuth('auth:refresh:unpublished', { rt, status: result.status, error: published || 'lease_lost' }, 'error')
      }
      return result
    } catch (error) {
      logAuth('auth:refresh:unavailable', { rt, error: (error as Error)?.name ?? 'Error' }, 'error')
      return { status: 'transient' }
    }
  }

  return function refresh(refreshToken: string): Promise<RefreshResult> {
    const prefix = process.env.FX0_REDIS_PREFIX?.trim() || 'fx0:v1'
    const key = `${prefix}:auth:refresh:${hashHandle(refreshToken)}`
    const active = inFlight.get(key)
    if (active) return active
    if (!refreshToken || inFlight.size >= 256) return Promise.resolve({ status: 'transient' })
    const pending = coordinated(refreshToken, key).finally(() => { inFlight.delete(key) })
    inFlight.set(key, pending)
    return pending
  }
}

let refreshRedis: Redis | undefined
export function authRedis(): Redis {
  if (!refreshRedis) {
    const url = process.env.KV_REST_API_URL
    const token = process.env.KV_REST_API_TOKEN
    if (!url || !token) throw new Error('Refresh coordination requires configured Redis')
    refreshRedis = new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(2000) })
  }
  return refreshRedis
}

export const refreshAccessToken = createRefreshCoordinator({
  fetch: (...args) => fetch(...args),
  cache: {
    get: (key) => authRedis().get<string>(`${key}:result`),
    acquire: async (key, owner, ttl) => await authRedis().set(`${key}:lock`, owner, { nx: true, ex: ttl }) === 'OK',
    publish: async (key, owner, value, ttl) => await authRedis().eval<[string, string, number], number>(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
      redis.call('DEL', KEYS[1])
      return 1
    `, [`${key}:lock`, `${key}:result`], [owner, value, ttl]) === 1,
    release: async (key, owner) => {
      await authRedis().eval<[string], number>(`
        if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
        return 0
      `, [`${key}:lock`], [owner])
    },
  },
})
