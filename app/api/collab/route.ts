import { after } from 'next/server'
import { AuthError } from '../../../lib/accounts'
import { hashHandle, randomHandle } from '../../../lib/auth-crypto'
import { clientAddress, DAILY_LIMIT_MESSAGE, HOURLY_MESSAGE_LIMIT_MESSAGE, HOURLY_ROOM_LIMIT_MESSAGE, PAUSED_MESSAGE, type HourlyCounter, type HourlyUse } from '../../../lib/collab/limits'
import { collabConfiguration, collabRuntime, runRoom, sweepIdleRooms, type CollabRuntime } from '../../../lib/collab/runtime'
import { MISSING_API_KEY_MESSAGE } from '../../../lib/collab/types'
import { browserToken, identityCookie, privateJson, readCollabBody, requireBrowserToken, revisionId, stringField, withCollabRoute } from '../../../lib/collab/http'

export const maxDuration = 800

export const GET = withCollabRoute(async (request) => {
  const params = new URL(request.url).searchParams
  const id = params.get('room')
  // Every read builds the runtime, so health checks fail on an invalid limit or an unwritable database.
  const runtime = collabRuntime()
  const { store, limits } = runtime
  if (!id) {
    const { configured, model } = collabConfiguration()
    const token = browserToken(request)
    // Health checks read this often, so idle rooms expire even when nobody creates one.
    if (limits.roomTtlDays !== null) after(() => sweepIdleRooms())
    return privateJson({ configured, model, rooms: token ? store.listRooms(token) : [] })
  }
  const token = requireBrowserToken(request)
  const revision = params.get('revision')
  if (revision !== null) return privateJson({ html: store.revisionHtml(id, token, revisionId(revision)) })
  // A room waiting to resume always gets its full read, so an open tab can resume it, for example on the next UTC day.
  const since = params.get('since')
  if (since !== null && !runtime.resumable.has(id) && store.version(id, token) === Number(since)) return privateJson({ unchanged: true })
  const room = store.snapshot(id, token)
  // Only work an earlier server left unfinished resumes here, once per room and as one more unit of the day: later work starts from the request that queued it.
  if (runtime.resumable.has(id) && room.status === 'idle' && !limits.paused && collabConfiguration().configured) {
    // A later message's run may already have settled the queue.
    if (!store.pendingMessages(id).length) runtime.resumable.delete(id)
    else if (store.takeRunUnit(limits.dailyMessages)) {
      runtime.resumable.delete(id)
      after(() => runRoom(id))
    }
  }
  return privateJson({ room })
})

// One route for room actions: create and join issue the identity cookie; the rest require membership.
export const POST = withCollabRoute(async (request) => {
  const body = await readCollabBody(request)
  const action = stringField(body, 'action')
  const runtime = collabRuntime()
  const { store, limits } = runtime
  if (action === 'create') {
    const uses = roomUses(request, runtime)
    const token = browserToken(request) ?? randomHandle()
    const result = store.createRoom({ name: stringField(body, 'name'), title: stringField(body, 'title'), token })
    runtime.roomUsage.add(uses)
    return privateJson(result, 201, { 'set-cookie': identityCookie(token) })
  }
  if (action === 'join') {
    const uses = roomUses(request, runtime)
    const token = browserToken(request) ?? randomHandle()
    const result = store.joinRoom({ id: stringField(body, 'id'), invite: stringField(body, 'invite'), name: stringField(body, 'name'), token, maxMembers: limits.maxMembers })
    runtime.roomUsage.add(uses)
    return privateJson(result, 200, { 'set-cookie': identityCookie(token) })
  }
  const id = stringField(body, 'id')
  const token = requireBrowserToken(request)
  // Membership first, so a non-member gets 404 whatever the action or server configuration.
  const current = store.snapshot(id, token)
  if (action === 'invite') return privateJson({ invite: store.createInvite(id, token) })
  if (action === 'review') {
    if (typeof body.enabled !== 'boolean') throw new AuthError(400, 'enabled must be true or false')
    return privateJson({ room: store.setReview(id, token, body.enabled) })
  }
  if (action === 'message') {
    const uses = spendUses(request, token, runtime)
    const { room, inserted } = store.appendMessage(id, token, {
      text: stringField(body, 'text'), requestId: stringField(body, 'requestId'), dailyLimit: limits.dailyMessages,
      admit: () => assertHourly(runtime.messageUsage, uses, HOURLY_MESSAGE_LIMIT_MESSAGE),
    })
    // A repeat of a stored request starts nothing new: a room whose run failed waits for a counted retry.
    if (inserted) {
      runtime.messageUsage.add(uses)
      after(() => runRoom(id))
    }
    return privateJson({ room })
  }
  if (action === 'retry') {
    // Only a failed room with work left can run again; any other retry, such as a second member's click, costs nothing.
    if (current.status !== 'error' || !store.pendingMessages(id).length) return privateJson({ room: current })
    const uses = spendUses(request, token, runtime)
    assertHourly(runtime.messageUsage, uses, HOURLY_MESSAGE_LIMIT_MESSAGE)
    if (!store.takeRunUnit(limits.dailyMessages)) throw new AuthError(429, DAILY_LIMIT_MESSAGE)
    runtime.messageUsage.add(uses)
    after(() => runRoom(id))
    return privateJson({ room: store.snapshot(id, token) })
  }
  throw new AuthError(400, 'Unknown action')
})

// Messages and retries start paid agent work. Their hourly uses are checked just before the store accepts and counted after, with nothing awaited in between.
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
  const uses = [{ key: `address:${clientAddress(request, addresses.trustedProxies)}`, limit: addresses.hourlyRooms }]
  assertHourly(runtime.roomUsage, uses, HOURLY_ROOM_LIMIT_MESSAGE)
  return uses
}

function assertHourly(counter: HourlyCounter, uses: HourlyUse[], message: string): void {
  if (!counter.allows(uses)) throw new AuthError(429, message)
}
