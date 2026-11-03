import { sealData, unsealData } from 'iron-session'
// @ts-expect-error Node strip-types tests require the source extension.
import { authRedis, needsTokenRefresh, refreshAccessToken, sessionWithRefresh } from './auth.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { hashHandle, logTag } from './auth-crypto.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { logAuth } from './auth-protocol.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { getSessionOptions, type SessionData } from './secure-session.ts'

// Vercel refresh tokens expire after 30 days of inactivity. Only a successful
// provider exchange starts a new retention window; reads and repairs never do.
const RETENTION_SECONDS = 30 * 24 * 60 * 60
interface Credential {
  key: string
  userId: string
  loginId: string
  loginAt: number
  accessToken: string
  refreshToken: string
  expiresAt: number
  validUntil: number
}
interface Latest { raw: string | null; credential: Credential | null }
type Renewal = { status: 'ok' | 'unavailable'; session: SessionData } | { status: 'terminal' | 'transient' }

export async function renewSessionCredential(grant: SessionData, requestId: string): Promise<Renewal> {
  const prefix = process.env.FX0_REDIS_PREFIX?.trim() || 'fx0:v1'
  const key = `${prefix}:auth:credential:${grant.loginId}`
  // The same permanent tombstone owned by turn-credential/logout. Both reads
  // and writes are fenced atomically, so an in-flight rotation cannot resurrect it.
  const revokedKey = `${prefix}:revoked-login:${grant.loginId}`
  const password = getSessionOptions().password
  const { credentialPublication: _, ...original } = grant
  async function latest(): Promise<Latest | 'revoked'> {
    const raw = await authRedis().eval<[], string | null | -1>(`
      -- auth-credential:read
      if redis.call('GET', KEYS[2]) then return -1 end
      return redis.call('GET', KEYS[1])
    `, [key, revokedKey], []).catch(() => {
      logAuth('auth:credential:read_failed', { request: requestId }, 'error')
      throw new Error('Login credential store unavailable')
    })
    if (raw === -1 || raw === null) {
      logAuth('auth:credential:read', { request: requestId, state: raw === -1 ? 'revoked' : 'missing', rt: null })
      return raw === -1 ? 'revoked' : { raw: null, credential: null }
    }
    const credential = await unsealData<Credential>(raw, { password, ttl: RETENTION_SECONDS })
    if (credential.key !== key || credential.userId !== grant.userId || credential.loginId !== grant.loginId ||
        credential.loginAt !== grant.loginAt || typeof credential.accessToken !== 'string' || !credential.accessToken ||
        typeof credential.refreshToken !== 'string' || !credential.refreshToken || !Number.isFinite(credential.expiresAt) ||
        credential.expiresAt <= 0 || !Number.isFinite(credential.validUntil) || credential.validUntil <= Date.now()) {
      logAuth('auth:credential:invalid', { request: requestId }, 'error')
      throw new Error('Invalid latest login credential')
    }
    logAuth('auth:credential:read', {
      request: requestId, state: 'present', rt: logTag('refresh', credential.refreshToken),
      accessExpiresInS: Math.round((credential.expiresAt - Date.now()) / 1000),
    })
    return { raw, credential }
  }
  function apply(credential: Credential): SessionData {
    return { ...original, accessToken: credential.accessToken, refreshToken: credential.refreshToken, expiresAt: credential.expiresAt }
  }
  async function publish(previous: string | null, session: SessionData, validUntil: number): Promise<number> {
    const ttl = Math.floor((validUntil - Date.now()) / 1000)
    if (ttl <= 0) throw new Error('Credential retention expired')
    const credential: Credential = { key, userId: grant.userId, loginId: grant.loginId, loginAt: grant.loginAt,
      accessToken: session.accessToken, refreshToken: session.refreshToken!, expiresAt: session.expiresAt, validUntil }
    const raw = await sealData(credential, { password, ttl })
    const result = await authRedis().eval<[string, string, number], number>(`
      -- auth-credential:publish
      if redis.call('GET', KEYS[2]) then return -1 end
      local current = redis.call('GET', KEYS[1]) or ''
      if current ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
      return 1
    `, [key, revokedKey], [previous ?? '', raw, ttl])
    logAuth('auth:credential:publish', {
      request: requestId, rt: logTag('refresh', session.refreshToken!),
      result: result === 1 ? 'stored' : result === -1 ? 'revoked' : 'changed',
      pending: !!grant.credentialPublication,
    })
    return result
  }

  let state = await latest()
  if (state === 'revoked') return { status: 'terminal' }
  const pending = grant.credentialPublication
  let forceRefresh = false
  if (pending) {
    if (!/^[a-f0-9]{64}$/.test(pending.previous) || !Number.isFinite(pending.validUntil) ||
        pending.validUntil <= Date.now() || pending.validUntil > Date.now() + RETENTION_SECONDS * 1000) {
      throw new Error('Invalid pending credential publication')
    }
    if (hashHandle(state.raw ?? '') === pending.previous) {
      try {
        const saved = await publish(state.raw, grant, pending.validUntil)
        if (saved === -1) return { status: 'terminal' }
        if (saved === 1) {
          // This request only repairs publication. Expired access stays blocked;
          // the next request renews it through the same coordinator.
          return { status: 'ok', session: original }
        }
      } catch {
        logAuth('auth:credential:publish_failed', { request: requestId, pending: true, rt: logTag('refresh', grant.refreshToken!) }, 'error')
        return { status: 'unavailable', session: grant }
      }
      state = await latest()
      if (state === 'revoked') return { status: 'terminal' }
    }
    // A different durable state wins. If the predecessor disappeared, prove
    // the cookie's successor is still live with a fresh exchange before bootstrap.
    forceRefresh = !state.credential
  }
  const current = state.credential ? apply(state.credential) : original
  logAuth('auth:credential:selected', {
    request: requestId, source: state.credential ? 'latest' : 'cookie',
    cookieRt: logTag('refresh', grant.refreshToken!), rt: logTag('refresh', current.refreshToken!),
  })
  if (!forceRefresh && !needsTokenRefresh(current)) return { status: 'ok', session: current }
  const result = await refreshAccessToken(current.refreshToken!)
  if (result.status === 'transient') {
    // If latest rescued a different credential, forward that state even when the
    // provider is temporarily unavailable; expired access is blocked by the wrapper.
    return state.credential ? { status: 'ok', session: current } : result
  }
  if (result.status === 'terminal') {
    // A stale exchange may lose to a concurrent successful publication.
    const winner = await latest()
    if (winner === 'revoked') return { status: 'terminal' }
    return winner.raw !== state.raw && winner.credential
      ? { status: 'ok', session: apply(winner.credential) } : result
  }
  const rotated = sessionWithRefresh(current, result)
  const validUntil = result.expiresAt - result.tokens.expires_in * 1000 + RETENTION_SECONDS * 1000
  let previous = state.raw
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved = await publish(previous, rotated, validUntil)
      if (saved === -1) return { status: 'terminal' }
      if (saved === 1) return { status: 'ok', session: rotated }
      const winner = await latest()
      if (winner === 'revoked') return { status: 'terminal' }
      if (!winner.credential) break
      if (winner.credential.refreshToken !== current.refreshToken) return { status: 'ok', session: apply(winner.credential) }
      // During legacy bootstrap another request can publish the very token this
      // exchange just consumed. Advance that exact state once, not a token chain.
      previous = winner.raw
    }
  } catch {
    // The provider consumed the old token: preserve its successor below.
    logAuth('auth:credential:publish_failed', { request: requestId, pending: false, rt: logTag('refresh', rotated.refreshToken!) }, 'error')
  }
  return { status: 'unavailable', session: { ...rotated,
    credentialPublication: { previous: hashHandle(previous ?? ''), validUntil } } }
}
