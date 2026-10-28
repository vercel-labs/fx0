import { after } from 'next/server'
import { AuthError } from '../../../lib/accounts'
import { hashHandle, randomHandle } from '../../../lib/auth-crypto'
import { clientAddress, PAUSED_MESSAGE, type HourlyUse } from '../../../lib/collab/limits'
import { collabConfiguration, collabRuntime, runRoom, sweepIdleRooms, type CollabRuntime } from '../../../lib/collab/runtime'
import { MISSING_API_KEY_MESSAGE } from '../../../lib/collab/types'
import { browserToken, identityCookie, privateJson, readCollabBody, requireBrowserToken, revisionId, stringField, withCollabRoute } from '../../../lib/collab/http'

export const maxDuration = 800

export const GET = withCollabRoute(async (request) => {
  const params = new URL(request.url).searchParams
  const id = params.get('room')
  // Every read builds the runtime, so health checks fail on an invalid limit.
  const runtime = collabRuntime()
  const { store, limits } = runtime
  if (!id) {
    const { configured, model } = collabConfiguration()
    const token = browserToken(request)
    // Health checks read this often, so idle rooms expire even when nobody creates one.
    if (limits.roomTtlDays !== null) after(() => sweepIdleRooms())
    return privateJson({ configured, model, rooms: token ? await store.listRooms(token) : [] })
  }
  const token = requireBrowserToken(request)
  const revision = params.get('revision')
  if (revision !== null) return privateJson({ html: await store.revisionHtml(id, token, revisionId(revision)) })
  const { version, stalled } = await store.poll(id, token, Date.now(), runtime.stallMs)
  // Accepted work whose invocation ended mid-run, or that waited for a running-room slot, resumes
  // from a member's poll. It was counted when accepted, and the lease lets only one runner take it.
  if (stalled && !limits.paused && collabConfiguration().configured) after(() => runRoom(id))
  const since = params.get('since')
  if (since !== null && version === Number(since)) return privateJson({ unchanged: true })
  return privateJson({ room: await store.snapshot(id, token) })
})

// One route for room actions: create and join issue the identity cookie; the rest require membership.
export const POST = withCollabRoute(async (request) => {
  const body = await readCollabBody(request)
  const action = stringField(body, 'action')
  const runtime = collabRuntime()
  const { store, limits } = runtime
  if (action === 'create') {
    const token = browserToken(request) ?? randomHandle()
    const result = await store.createRoom({ name: stringField(body, 'name'), title: stringField(body, 'title'), token, hourlyUses: roomUses(request, runtime) })
    return privateJson(result, 201, { 'set-cookie': identityCookie(token, request) })
  }
  if (action === 'join') {
    const token = browserToken(request) ?? randomHandle()
    const result = await store.joinRoom({ id: stringField(body, 'id'), invite: stringField(body, 'invite'), name: stringField(body, 'name'), token, maxMembers: limits.maxMembers, hourlyUses: roomUses(request, runtime) })
    return privateJson(result, 200, { 'set-cookie': identityCookie(token, request) })
  }
  const id = stringField(body, 'id')
  const token = requireBrowserToken(request)
  // Membership first, so a non-member gets 404 whatever the action or server configuration.
  const current = await store.snapshot(id, token)
  if (action === 'invite') return privateJson({ invite: await store.createInvite(id, token) })
  if (action === 'review') {
    if (typeof body.enabled !== 'boolean') throw new AuthError(400, 'enabled must be true or false')
    return privateJson({ room: await store.setReview(id, token, body.enabled) })
  }
  if (action === 'message') {
    const uses = spendUses(request, token, runtime)
    const { room, inserted } = await store.appendMessage(id, token, {
      text: stringField(body, 'text'), requestId: stringField(body, 'requestId'), dailyLimit: limits.dailyMessages,
      hourlyUses: uses,
    })
    // A repeat of a stored request starts nothing new: a room whose run failed waits for a counted retry.
    if (inserted) {
      after(() => runRoom(id))
    }
    return privateJson({ room })
  }
  if (action === 'retry') {
    if (current.status !== 'error') return privateJson({ room: current })
    // A single transaction admits one retry, reserves its quota and clears any
    // persistent cleanup barrier. Concurrent clicks cannot charge the retry twice.
    const result = await store.retryRoom(id, token, limits.dailyMessages, spendUses(request, token, runtime))
    if (result.started) after(() => runRoom(id))
    return privateJson({ room: result.room })
  }
  throw new AuthError(400, 'Unknown action')
})

// The store reserves these allowances atomically with each accepted action.
function spendUses(request: Request, token: string, runtime: CollabRuntime): HourlyUse[] {
  if (!collabConfiguration().configured) throw new AuthError(503, MISSING_API_KEY_MESSAGE)
  const { limits } = runtime
  if (limits.paused) throw new AuthError(503, PAUSED_MESSAGE)
  const uses: HourlyUse[] = []
  if (limits.hourlyMessages !== null) uses.push({ key: `browser:${hashHandle(token)}`, limit: limits.hourlyMessages })
  if (limits.addresses && limits.addresses.hourlyMessages !== null) {
    uses.push({ key: `address:${clientAddress(request, limits.addresses.trustedProxies)}`, limit: limits.addresses.hourlyMessages })
  }
  return uses
}

function roomUses(request: Request, runtime: CollabRuntime): HourlyUse[] {
  const addresses = runtime.limits.addresses
  if (!addresses || addresses.hourlyRooms === null) return []
  return [{ key: `room-address:${clientAddress(request, addresses.trustedProxies)}`, limit: addresses.hourlyRooms }]
}
