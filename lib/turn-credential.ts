import { sealData, unsealData } from 'iron-session'
// @ts-expect-error Node strip-types tests require the source extension.
import { prefixed, redis } from './journal.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { loginCredentialKey } from './auth-protocol.ts'
import type { SessionData } from './secure-session'
// @ts-expect-error Node strip-types tests require the source extension.
import { trialEnabled, type TrialCredential } from './trial.ts'

// libfx runs a chat's turns in queue deliveries, with no user request to read a
// cookie from. So the prompt route leaves the sender's AI Gateway credential
// here, pinned to the turn its message starts, and the agent's fetch bills each
// model request to its turn's credential: the access token and team only,
// sealed with SESSION_SECRET and expiring with the token. This store never
// holds refresh tokens, and no credential is logged. Deleting this module,
// and the fetch that reads it, bills the deployment instead.
interface UserTurnCredential {
  userId: string
  loginId: string
  accessToken: string
  teamId: string
  expiresAt: number
}
export type TurnCredential = UserTurnCredential | TrialCredential

function password(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters')
  return secret
}

const credentialKey = (chatId: string) => prefixed(`credential:${chatId}`)
const fundingKey = (chatId: string) => prefixed(`funding:${chatId}`)
// Paid turns' funding records. The code before per-turn funding also reads
// `funding:`, and refuses a chat's unpinned paid turns once it holds any record.
// Kept apart, a rollback to that code bills paid chats as it always did.
const paidFundingKey = (chatId: string) => prefixed(`paid-funding:${chatId}`)
const turnCredentialKey = (chatId: string, turnId: number) => `${credentialKey(chatId)}:turn:${turnId}`
const loginKey = (loginId: string) => prefixed(`login-chats:${loginId}`)
const revokedLoginKey = (loginId: string) => prefixed(`revoked-login:${loginId}`)

// Whether sign-out has revoked this login. Session readers check it as well as
// credential reads and writes, so a copied grant is no session either.
export async function loginRevoked(loginId: string): Promise<boolean> {
  return await redis().get(revokedLoginKey(loginId)) !== null
}

// One durable write fences this login before sign-out succeeds. Do not expire or
// remove the marker: a delayed request can still rotate and reseal an old grant.
// It contains no token; a new sign-in gets a different random login id.
export async function revokeLoginCredentials(loginId: string): Promise<void> {
  await redis().set(revokedLoginKey(loginId), '1')
}

async function activeCredential<T extends TurnCredential>(credential: T | null): Promise<T | null> {
  return credential && !await loginRevoked(credential.loginId) ? credential : null
}

export interface FundingBinding { kind: 'trial' | 'user'; userId: string; loginId: string; teamId?: string }

// Pins the sender's credential to the turn its message starts, and keeps it as
// the chat's latest credential for token renewal. Every paid message is pinned;
// one whose credential can't be stored is not admitted.
export async function saveTurnCredential(chatId: string, session: SessionData, turnId: number): Promise<void> {
  const stored = userCredential(session)
  if (!stored) throw new Error('Sign in again to send this message')
  await storeCredential(chatId, stored.credential, stored.ttlSeconds, turnId)
}

// A renewed token for the chat's latest credential. It reaches the turns its
// login funded, each still billing its own team, and pins no turn. An expired
// token is not stored.
export async function renewLatestCredential(chatId: string, session: SessionData): Promise<void> {
  const stored = userCredential(session)
  if (stored) await storeCredential(chatId, stored.credential, stored.ttlSeconds)
}

function userCredential(session: SessionData): { credential: UserTurnCredential; ttlSeconds: number } | null {
  const ttlSeconds = Math.floor((session.expiresAt - Date.now()) / 1000)
  if (!session.accessToken || !session.teamId || !session.loginId || ttlSeconds <= 0) return null
  return {
    credential: {
      userId: session.userId,
      loginId: session.loginId,
      accessToken: session.accessToken,
      teamId: session.teamId,
      expiresAt: session.expiresAt,
    },
    ttlSeconds,
  }
}

export async function saveTrialCredential(chatId: string, credential: TrialCredential, turnId: number): Promise<void> {
  const ttlSeconds = Math.floor((credential.expiresAt - Date.now()) / 1000)
  if (!trialEnabled() || credential.kind !== 'trial' || !credential.userId || !credential.loginId || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Free prompts are temporarily unavailable')
  }
  await storeCredential(chatId, { kind: 'trial', userId: credential.userId, loginId: credential.loginId, expiresAt: credential.expiresAt }, ttlSeconds, turnId)
}

async function storeCredential(chatId: string, credential: TurnCredential, ttlSeconds: number, turnId?: number): Promise<void> {
  if (turnId !== undefined && (!Number.isSafeInteger(turnId) || turnId <= 0)) throw new Error('Invalid funding turn')
  if (await loginRevoked(credential.loginId)) throw new Error('Signed out. Sign in again.')
  const sealed = await sealData(credential, { password: password(), ttl: ttlSeconds })
  const pipeline = redis().pipeline()
  const sponsored = 'kind' in credential
  // The latest user credential serves token renewal, and the chats whose turns
  // predate funding records. A sponsored admission never replaces it.
  if (!sponsored) pipeline.set(credentialKey(chatId), sealed, { ex: ttlSeconds })
  if (turnId !== undefined) {
    const binding: FundingBinding = { kind: sponsored ? 'trial' : 'user', userId: credential.userId,
      loginId: credential.loginId, ...(!sponsored ? { teamId: credential.teamId } : {}) }
    pipeline.set(turnCredentialKey(chatId, turnId), sealed, { ex: ttlSeconds })
      // This non-secret marker survives expiry/revocation, so a missing trial
      // credential can never fall back to the customer's latest paid grant.
      .hset(sponsored ? fundingKey(chatId) : paidFundingKey(chatId), { [String(turnId)]: JSON.stringify(binding) })
  }
  await pipeline.sadd(loginKey(credential.loginId), chatId)
    // The index outlives no credential it lists: a login's tokens expire too.
    .expire(loginKey(credential.loginId), ttlSeconds, 'GT')
    .exec()
}

async function decodeCredential(sealed: unknown): Promise<TurnCredential | null> {
  if (typeof sealed !== 'string') return null
  if (!sealed) return null
  try {
    const credential = await unsealData<Partial<TurnCredential>>(sealed, { password: password() })
    if ('kind' in credential && credential.kind === 'trial') {
      return credential.userId && credential.loginId && typeof credential.expiresAt === 'number' && Number.isFinite(credential.expiresAt) && credential.expiresAt > Date.now()
        ? { kind: 'trial', userId: credential.userId, loginId: credential.loginId, expiresAt: credential.expiresAt }
        : null
    }
    if (!credential.accessToken || !credential.teamId || !credential.loginId || !credential.userId ||
        typeof credential.expiresAt !== 'number' || !Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now()) return null
    return credential as TurnCredential
  } catch {
    return null
  }
}

export async function readTurnCredential(chatId: string): Promise<UserTurnCredential | null> {
  const credential = await decodeCredential(await redis().get(credentialKey(chatId)))
  return activeCredential(credential && !('kind' in credential) ? credential : null)
}

function fundingBinding(value: unknown): FundingBinding | null {
  try {
    const binding = (typeof value === 'string' ? JSON.parse(value) : value) as Partial<FundingBinding> | null
    return binding && (binding.kind === 'trial' || binding.kind === 'user') && typeof binding.userId === 'string' && typeof binding.loginId === 'string' &&
      (binding.kind === 'trial' || typeof binding.teamId === 'string') ? binding as FundingBinding : null
  } catch { return null }
}

// Why a model request has no funding: the executing turn is unknown, it has no
// funding record in a chat that keeps them, its credential is gone, expired or
// no longer matches its record, or its login has signed out.
export type FundingRefusal = 'no-turn' | 'unbound-turn' | 'unusable' | 'revoked'
export type ExecutionFunding = { ok: true; credential: TurnCredential } | { ok: false; refused: FundingRefusal }

const refuse = (refused: FundingRefusal): ExecutionFunding => ({ ok: false, refused })

// What funds a turn's model request, from the chat's records alone. A turn with
// a funding record bills that record's user, login and team, or nothing: later
// messages and renewals can change only the token. A chat with no records at
// all predates per-turn funding and bills its latest user credential, and so
// does a turn older than the chat's first record (`firstFunded`): one that was
// already running or queued when per-turn funding shipped. Every message since
// is pinned before libfx sees it, so any other turn without a record bills nothing.
export function resolveFunding(
  records: number,
  turnId: number | null,
  binding: FundingBinding | null,
  exact: TurnCredential | null,
  latest: TurnCredential | null,
  firstFunded: number | null = null,
): ExecutionFunding {
  const latestUser = (): ExecutionFunding => latest && !('kind' in latest) ? { ok: true, credential: latest } : refuse('unusable')
  if (records === 0) return latestUser()
  if (turnId === null) return refuse('no-turn')
  if (!binding) return firstFunded !== null && turnId < firstFunded ? latestUser() : refuse('unbound-turn')
  const sameLogin = (credential: TurnCredential | null) =>
    credential?.userId === binding.userId && credential.loginId === binding.loginId
  if (binding.kind === 'trial') return exact && 'kind' in exact && sameLogin(exact) ? { ok: true, credential: exact } : refuse('unusable')
  // Rotation may change the selected team, but this turn retains the team its
  // admission selected. The refreshed OAuth token is usable only for that team.
  if (latest && !('kind' in latest) && sameLogin(latest)) return { ok: true, credential: { ...latest, teamId: binding.teamId! } }
  return exact && !('kind' in exact) && sameLogin(exact) && exact.teamId === binding.teamId
    ? { ok: true, credential: exact } : refuse('unusable')
}

// The SDK's actual executing message selects funding, including after a cold
// restore. Redis projection timing and later submitted messages confer no billing
// authority. A signed-out login's credential funds nothing: the check runs after
// selection, on every request, and is never cached.
export async function readExecutionFunding(chatId: string, turnId?: number): Promise<ExecutionFunding> {
  const turn = Number.isSafeInteger(turnId) && (turnId as number) > 0 ? turnId as number : null
  const pipeline = redis().pipeline().hlen(fundingKey(chatId)).hlen(paidFundingKey(chatId)).get(credentialKey(chatId))
  if (turn !== null) pipeline.hget(paidFundingKey(chatId), String(turn)).hget(fundingKey(chatId), String(turn)).get(turnCredentialKey(chatId, turn))
  const values: unknown[] = await pipeline.exec()
  const [count, paidCount, latestSeal, paidBinding, binding, turnSeal] = values
  const records = Number(count) + Number(paidCount)
  const bindingValue = paidBinding ?? binding
  const [latest, exact, firstFunded] = await Promise.all([
    decodeCredential(latestSeal),
    decodeCredential(turnSeal),
    // Only a turn with no record at all needs the chat's first record.
    records > 0 && turn !== null && bindingValue == null ? firstFundedTurn(chatId) : null,
  ])
  const funding = resolveFunding(records, turn, fundingBinding(bindingValue), exact, latest, firstFunded)
  return funding.ok && await loginRevoked(funding.credential.loginId) ? refuse('revoked') : funding
}

// The chat's first funded turn, across both kinds of record.
async function firstFundedTurn(chatId: string): Promise<number | null> {
  const [trial, paid] = await redis().pipeline().hkeys(fundingKey(chatId)).hkeys(paidFundingKey(chatId)).exec() as [unknown, unknown]
  const ids = [trial, paid].flatMap((keys) => Array.isArray(keys) ? keys.map(Number) : []).filter((id) => Number.isSafeInteger(id) && id > 0)
  return ids.length ? Math.min(...ids) : null
}

// A chat's funding records of both kinds, by turn.
function fundingRecords(trial: unknown, paid: unknown): Record<string, unknown> {
  return { ...(trial ?? {}) as Record<string, unknown>, ...(paid ?? {}) as Record<string, unknown> }
}

// What sign-out deletes in one chat, from what the chat held when read: the
// credentials of the turns this login funded, and the chat's latest credential
// if it was this login's, named by its exact sealed value. Funding records stay,
// so a turn whose credential is gone bills nothing rather than a fallback.
export interface SignOutCleanup { turnIds: number[]; latestSeal: string | null }

export function signOutCleanup(
  loginId: string,
  bindings: Record<string, unknown>,
  latestSeal: unknown,
  latest: TurnCredential | null,
): SignOutCleanup {
  const turnIds = Object.entries(bindings).filter(([, value]) => fundingBinding(value)?.loginId === loginId).map(([id]) => Number(id))
  const own = typeof latestSeal === 'string' && latest !== null && !('kind' in latest) && latest.loginId === loginId
  return { turnIds, latestSeal: own ? latestSeal : null }
}

// Deletes the turn credentials (KEYS[2..]), and the latest credential (KEYS[1])
// only while it still holds the sealed value the cleanup read (ARGV[1]): one
// another login stored since then survives. Returns {turns, latest} deleted.
export const DROP_LOGIN_CHAT = `
local turns = 0
for i = 2, #KEYS do turns = turns + redis.call('DEL', KEYS[i]) end
local latest = 0
if ARGV[1] ~= '' and redis.call('GET', KEYS[1]) == ARGV[1] then latest = redis.call('DEL', KEYS[1]) end
return {turns, latest}
`

// A chat a sign-out cleaned: how many turn credentials it deleted, and what
// became of the chat's latest credential.
export interface DroppedChat { chatId: string; turns: number; latest: 'deleted' | 'replaced' | 'not-this-login' }

// Sign-out: removes this login's OAuth head and chat credentials, but not one a
// later prompt from another login of the user has since replaced. Cancels
// nothing: a turn this login funded stops at its next model request.
export async function dropLoginCredentials(loginId: string): Promise<DroppedChat[]> {
  const chats = (await redis().smembers(loginKey(loginId))) ?? []
  // One round trip reads every chat's credential and funding; a second deletes,
  // with one compare-and-delete script per chat. The seal is decoded directly:
  // sign-out has already revoked this login.
  const reads = redis().pipeline()
  for (const chatId of chats) reads.get(credentialKey(chatId)).hgetall(fundingKey(chatId)).hgetall(paidFundingKey(chatId))
  const values: unknown[] = chats.length ? await reads.exec() : []
  const cleanups = await Promise.all(chats.map(async (chatId, index) => {
    const latestSeal = values[index * 3]
    const bindings = fundingRecords(values[index * 3 + 1], values[index * 3 + 2])
    return { chatId, ...signOutCleanup(loginId, bindings, latestSeal, await decodeCredential(latestSeal)) }
  }))
  const owned = cleanups.filter(({ turnIds, latestSeal }) => turnIds.length || latestSeal !== null)
  const deletes = redis().pipeline()
  for (const { chatId, turnIds, latestSeal } of owned) {
    deletes.eval(DROP_LOGIN_CHAT, [credentialKey(chatId), ...turnIds.map(id => turnCredentialKey(chatId, id))], [latestSeal ?? ''])
  }
  // Sign-out's permanent tombstone already fences every OAuth-head publication.
  deletes.del(loginKey(loginId), prefixed(loginCredentialKey(loginId)))
  const results = await deletes.exec() as unknown[]
  return owned.map(({ chatId, latestSeal }, index): DroppedChat => {
    const [turns, latest] = results[index] as [number, number]
    return { chatId, turns: Number(turns), latest: latestSeal === null ? 'not-this-login' : Number(latest) ? 'deleted' : 'replaced' }
  })
}

export async function dropChatCredential(chatId: string): Promise<void> {
  const [trial, paid] = await redis().pipeline().hgetall(fundingKey(chatId)).hgetall(paidFundingKey(chatId)).exec() as [unknown, unknown]
  const bindings = fundingRecords(trial, paid)
  await redis().del(credentialKey(chatId), fundingKey(chatId), paidFundingKey(chatId),
    ...Object.keys(bindings).map(id => turnCredentialKey(chatId, Number(id))))
}
