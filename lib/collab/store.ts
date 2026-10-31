import { randomBytes } from 'node:crypto'
// @ts-expect-error Node strip-types tests require the source extension.
import { AuthError } from '../accounts.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { hashHandle, randomHandle } from '../auth-crypto.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { DAILY_LIMIT_MESSAGE, HOURLY_MESSAGE_LIMIT_MESSAGE, HOURLY_ROOM_LIMIT_MESSAGE, ROOM_FULL_MESSAGE, type HourlyUse } from './limits.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { InputsChangedError } from './input-batch.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { isBoundedText, MAX_MEMBER_NAME_LENGTH, MAX_MESSAGE_LENGTH, MAX_ROOM_TITLE_LENGTH, type AgentActivity, type AgentSeat, type Member, type Message, type Revision, type RoomSnapshot, type RoomStatus, type RoomSummary, type SeatSession } from './types.ts'

/** The batch must use one READ COMMITTED transaction, not separate HTTP BEGIN/query calls. */
export type RoomQuery = ((text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>) & {
  transaction(statements: { text: string; values?: unknown[] }[]): Promise<Record<string, unknown>[][]>
}

export interface RunGuard { runner: string; throughId?: number }
export class LeaseLostError extends Error {
  constructor() {
    super('Room run lease lost')
    this.name = 'LeaseLostError'
  }
}

const DB_NOW = '(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)'
const COORDINATION_LOCK = { text: 'SELECT id FROM ampersand_coordination WHERE id = 1 FOR UPDATE' }
const roomLock = (id: string) => ({ text: 'SELECT id FROM ampersand_rooms WHERE id = $1 FOR UPDATE', values: [id] })

const opaqueId = () => randomBytes(16).toString('base64url')
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value)
/** Browser tokens and invites both come from randomHandle(): 32 random bytes as base64url. */
export const isHandle = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
const notFound = () => new AuthError(404, 'Room not found')
const HOUR_MS = 60 * 60 * 1000
// The newest of a join time and room r's newest message, revision and agent activity.
const lastActivity = (joined: string) => `GREATEST(${joined},
  COALESCE((SELECT MAX(created_at) FROM ampersand_messages WHERE room_id = r.id), 0),
  COALESCE((SELECT MAX(created_at) FROM ampersand_revisions WHERE room_id = r.id), 0),
  COALESCE((SELECT MAX(created_at) FROM ampersand_activity WHERE room_id = r.id), 0))`
// The sidebar orders rooms by the viewer's own join; expiry counts anyone's.
const VIEWER_ACTIVITY = lastActivity('m.joined_at')
const ROOM_ACTIVITY = lastActivity('COALESCE((SELECT MAX(joined_at) FROM ampersand_members WHERE room_id = r.id), 0)')
// Settles nothing on its own: newer human messages than the room has processed.
const NEWEST_PENDING = `COALESCE((SELECT MAX(p.id) FROM ampersand_messages p WHERE p.room_id = r.id AND p.role = 'user' AND p.id > r.processed_through), 0)`
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)
// Bumps the room's version when the statement's change happened.
const bumpWhen = (id: string, changed: string) => `UPDATE ampersand_rooms SET version = version + 1 WHERE id = ${id} AND EXISTS (SELECT 1 FROM ${changed})`

function boundedText(value: unknown, label: string, max: number): string {
  if (!isBoundedText(value, max)) throw new AuthError(400, `${label} must contain 1–${max} characters`)
  return value.trim()
}

const SNAPSHOT = `SELECT r.id, r.title, r.review, r.status, r.error, r.version,
  COALESCE((SELECT json_agg(json_build_object('id', m.id, 'name', m.name, 'joinedAt', m.joined_at) ORDER BY m.joined_at, m.seq)
    FROM ampersand_members m WHERE m.room_id = r.id), '[]'::json) AS members,
  COALESCE((SELECT json_agg(json_build_object('id', x.id, 'authorId', x.author_id, 'author', x.author, 'role', x.role, 'text', x.text, 'createdAt', x.created_at) ORDER BY x.id)
    FROM ampersand_messages x WHERE x.room_id = r.id), '[]'::json) AS messages,
  COALESCE((SELECT json_agg(json_build_object('id', v.id, 'createdAt', v.created_at) ORDER BY v.id)
    FROM ampersand_revisions v WHERE v.room_id = r.id), '[]'::json) AS revisions,
  COALESCE((SELECT json_agg(json_build_object('id', a.id, 'agent', a.agent, 'kind', a.kind, 'text', a.text, 'revision', a.revision, 'createdAt', a.created_at) ORDER BY a.id)
    FROM (SELECT * FROM ampersand_activity WHERE room_id = r.id ORDER BY id DESC LIMIT 32) a), '[]'::json) AS activity
  FROM ampersand_rooms r WHERE r.id = $1`

const MESSAGE_COLUMNS = `id, author_id AS "authorId", author, role, text, created_at AS "createdAt"`

/** Shared Postgres persistence. Locks and their dependent reads use separate batch statements. */
export function createRoomStore(query: RoomQuery, close: () => void | Promise<void> = () => {}) {
  async function roomExists(id: string): Promise<void> {
    if (!validId(id) || !(await query('SELECT 1 FROM ampersand_rooms WHERE id = $1', [id])).length) throw notFound()
  }

  async function requireMember(id: string, token: string): Promise<Member> {
    if (!validId(id) || !isHandle(token)) throw notFound()
    const [member] = await query('SELECT id, name, joined_at AS "joinedAt" FROM ampersand_members WHERE room_id = $1 AND token_hash = $2', [id, hashHandle(token)])
    if (!member) throw notFound()
    return member as unknown as Member
  }

  async function messages(id: string, after = 0, usersOnly = false): Promise<Message[]> {
    return await query(`SELECT ${MESSAGE_COLUMNS} FROM ampersand_messages WHERE room_id = $1 AND id > $2 ${usersOnly ? "AND role = 'user'" : ''} ORDER BY id`, [id, after]) as unknown as Message[]
  }

  async function readSnapshot(id: string, viewerId: string): Promise<RoomSnapshot> {
    if (!validId(id)) throw notFound()
    const [room] = await query(SNAPSHOT, [id])
    if (!room) throw notFound()
    return {
      id: room.id as string,
      title: room.title as string,
      review: room.review as boolean,
      members: room.members as Member[],
      messages: room.messages as Message[],
      revisions: room.revisions as Revision[],
      activity: (room.activity as Array<AgentActivity & { revision: number | null }>).map((event) => ({ ...event, revision: event.revision ?? undefined })),
      status: room.status as RoomStatus,
      error: room.error as string | null,
      version: room.version as number,
      viewerId,
    }
  }

  // Serialize quota decisions, including absent counter rows, before taking a room lock.
  // No external I/O occurs inside these short, non-interactive transactions.
  async function admission(id: string | null, uses: HourlyUse[], dailyLimit: number | null,
    build: (param: (value: unknown) => string) => { context: string; effect: string; bump?: boolean; after?: string },
    hourlyMessage = HOURLY_MESSAGE_LIMIT_MESSAGE) {
    const values: unknown[] = []
    const param = (value: unknown) => { values.push(value); return `$${values.length}` }
    const { context, effect, bump, after = '' } = build(param)
    const now = Date.now()
    const hour = param(Math.floor(now / HOUR_MS))
    const day = param(utcDay(now))
    const limit = param(dailyLimit)
    // A repeated key reserves just one unit, subject to its strictest limit.
    const limits = new Map<string, number>()
    for (const use of uses) limits.set(use.key, Math.min(limits.get(use.key) ?? Infinity, use.limit))
    const hourly = param(JSON.stringify([...limits].map(([key, limit]) => ({ key, limit }))))
    const room = bump ? param(id) : ''
    const results = await query.transaction([
      COORDINATION_LOCK,
      ...(id === null ? [] : [roomLock(id)]),
      { text: `WITH context AS (${context}), decision AS (
          SELECT context.*, CASE WHEN reason IS NOT NULL THEN reason WHEN duplicate THEN NULL
            WHEN ${limit}::int IS NOT NULL AND COALESCE((SELECT units FROM ampersand_usage WHERE day = ${day}), 0) >= ${limit}::int THEN 'daily'
            WHEN EXISTS (SELECT 1 FROM jsonb_to_recordset(${hourly}::jsonb) AS u(key text, "limit" int)
              LEFT JOIN ampersand_hourly h ON h.key = u.key AND h.hour = ${hour}
              WHERE COALESCE(h.count, 0) >= u."limit") THEN 'hourly' END AS refusal
          FROM context),
        effect AS (${effect}) ${after},
        daily AS (INSERT INTO ampersand_usage (day, units)
          SELECT ${day}, 1 WHERE ${limit}::int IS NOT NULL AND EXISTS (SELECT 1 FROM effect)
          ON CONFLICT (day) DO UPDATE SET units = ampersand_usage.units + 1),
        hourly AS (INSERT INTO ampersand_hourly (key, hour, count)
          SELECT u.key, ${hour}, 1 FROM jsonb_to_recordset(${hourly}::jsonb) AS u(key text, "limit" int)
          WHERE EXISTS (SELECT 1 FROM effect)
          ON CONFLICT (key, hour) DO UPDATE SET count = ampersand_hourly.count + 1),
        expired AS (DELETE FROM ampersand_hourly WHERE hour < ${hour} AND EXISTS (SELECT 1 FROM effect))
        ${bump ? `, bump AS (${bumpWhen(`${room}::text`, 'effect')})` : ''}
        SELECT decision.*, COALESCE((SELECT json_agg(effect) FROM effect), '[]'::json) AS result
        FROM decision`, values },
    ])
    const [row] = results.at(-1)!
    if (!row || row.refusal === 'missing') throw notFound()
    if (row.refusal === 'cleanup') throw new AuthError(409, 'Room cleanup is in progress. Please try again later.')
    if (row.refusal === 'conflict') throw new AuthError(409, 'Message request ID already used')
    if (row.refusal === 'full') throw new AuthError(403, ROOM_FULL_MESSAGE)
    if (row.refusal === 'daily') throw new AuthError(429, DAILY_LIMIT_MESSAGE)
    if (row.refusal === 'hourly') throw new AuthError(429, hourlyMessage)
    return row as Record<string, unknown> & { result: Record<string, unknown>[] }
  }

  /** Check ownership and write under the same room lock; never trust a JS lease cache. */
  async function guarded(id: string, guard: RunGuard | undefined,
    mutation: (allowed: string) => { text: string; values: unknown[] }, bump = false) {
    if (!validId(id)) throw guard ? new LeaseLostError() : notFound()
    const { text, values } = mutation('(SELECT owner_ok AND inputs_ok FROM fence)')
    const runner = `$${values.length + 1}`
    const through = `$${values.length + 2}`
    const room = `$${values.length + 3}`
    const results = await query.transaction([roomLock(id), {
      text: `WITH fence AS MATERIALIZED (SELECT
          (${runner}::text IS NULL OR (r.runner = ${runner} AND r.runner_until > ${DB_NOW} AND r.cleanup_owner IS NULL)) AS owner_ok,
          (${through}::int IS NULL OR ${NEWEST_PENDING} <= ${through}::int) AS inputs_ok
          FROM ampersand_rooms r WHERE r.id = ${room}),
        effect AS (${text})
        ${bump ? `, bump AS (${bumpWhen(room, 'effect')})` : ''}
        SELECT fence.*, COALESCE((SELECT json_agg(effect) FROM effect), '[]'::json) AS result FROM fence`,
      values: [...values, guard?.runner ?? null, guard?.throughId ?? null, id],
    }])
    const [row] = results.at(-1)!
    if (!row) throw guard ? new LeaseLostError() : notFound()
    if (!row.owner_ok) throw new LeaseLostError()
    if (!row.inputs_ok) throw new InputsChangedError()
    return row.result as Record<string, unknown>[]
  }

  return {
    close,
    async createRoom(input: { name: string; title: string; token: string; hourlyUses?: HourlyUse[] }): Promise<{ room: RoomSnapshot; invite: string; memberId: string }> {
      const name = boundedText(input.name, 'Name', MAX_MEMBER_NAME_LENGTH)
      const title = boundedText(input.title, 'Room title', MAX_ROOM_TITLE_LENGTH)
      if (!isHandle(input.token)) throw new AuthError(400, 'Invalid browser token')
      const id = opaqueId()
      const memberId = opaqueId()
      const invite = randomHandle()
      await admission(null, input.hourlyUses ?? [], null, (p) => ({
        context: 'SELECT NULL::text AS reason, false AS duplicate',
        effect: `INSERT INTO ampersand_rooms (id, title) SELECT ${p(id)}, ${p(title)} FROM decision WHERE refusal IS NULL RETURNING id`,
        after: `, invite AS (INSERT INTO ampersand_invites (room_id, invite_hash) SELECT id, ${p(hashHandle(invite))} FROM effect),
          member AS (INSERT INTO ampersand_members (id, room_id, name, token_hash, joined_at)
            SELECT ${p(memberId)}, id, ${p(name)}, ${p(hashHandle(input.token))}, ${p(Date.now())} FROM effect)`,
      }), HOURLY_ROOM_LIMIT_MESSAGE)
      return { room: await readSnapshot(id, memberId), invite, memberId }
    },
    async joinRoom(input: { id: string; invite: string; name: string; token: string; maxMembers: number | null; hourlyUses?: HourlyUse[] }): Promise<{ room: RoomSnapshot; memberId: string }> {
      if (!validId(input.id) || !isHandle(input.invite) || !isHandle(input.token)) throw notFound()
      const name = boundedText(input.name, 'Name', MAX_MEMBER_NAME_LENGTH)
      const memberId = opaqueId()
      const row = await admission(input.id, input.hourlyUses ?? [], null, (p) => {
        const id = p(input.id), token = p(hashHandle(input.token)), invite = p(hashHandle(input.invite)), max = p(input.maxMembers)
        const prior = `(SELECT id FROM ampersand_members WHERE room_id = r.id AND token_hash = ${token})`
        return {
          context: `SELECT ${prior} AS prior, ${prior} IS NOT NULL AS duplicate, CASE
            WHEN NOT EXISTS (SELECT 1 FROM ampersand_invites WHERE room_id = r.id AND invite_hash = ${invite}) THEN 'missing'
            WHEN r.cleanup_owner IS NOT NULL THEN 'cleanup'
            WHEN ${prior} IS NULL AND ${max}::int IS NOT NULL AND (SELECT COUNT(*) FROM ampersand_members WHERE room_id = r.id) >= ${max}::int THEN 'full'
            END AS reason FROM ampersand_rooms r WHERE r.id = ${id}`,
          effect: `INSERT INTO ampersand_members (id, room_id, name, token_hash, joined_at)
            SELECT ${p(memberId)}, ${id}, ${p(name)}, ${token}, ${p(Date.now())} FROM decision WHERE refusal IS NULL AND NOT duplicate RETURNING id`,
          bump: true,
        }
      }, HOURLY_ROOM_LIMIT_MESSAGE)
      const joinedId = (row.prior ?? row.result[0]?.id) as string
      return { room: await readSnapshot(input.id, joinedId), memberId: joinedId }
    },
    async snapshot(id: string, token: string): Promise<RoomSnapshot> {
      return readSnapshot(id, (await requireMember(id, token)).id)
    },
    /** One revision's HTML, for a member of its room. */
    async revisionHtml(id: string, token: string, revisionId: number): Promise<string> {
      await requireMember(id, token)
      const [row] = await query('SELECT html FROM ampersand_revisions WHERE room_id = $1 AND id = $2', [id, revisionId])
      if (!row) throw new AuthError(404, 'Design not found')
      return row.html as string
    },
    /**
     * A member's poll: the room's version, which changes whenever the snapshot does, and whether accepted work has no live runner.
     * A queue is stalled once its newest message is older than `stallMs` and no lease covers it, as when an invocation ended mid-run.
     */
    async poll(id: string, token: string, now: number, stallMs: number): Promise<{ version: number; stalled: boolean }> {
      if (!validId(id) || !isHandle(token)) throw notFound()
      const [row] = await query(`SELECT r.version, r.status <> 'error' AND NOT r.cleanup_blocked AND r.cleanup_owner IS NULL AND (r.runner IS NULL OR r.runner_until <= ${DB_NOW})
          AND COALESCE((SELECT MAX(created_at) FROM ampersand_messages p WHERE p.room_id = r.id AND p.role = 'user' AND p.id > r.processed_through), $3) < $3 - $4 AS stalled
        FROM ampersand_rooms r JOIN ampersand_members m ON m.room_id = r.id WHERE r.id = $1 AND m.token_hash = $2`, [id, hashHandle(token), now, stallMs])
      if (!row) throw notFound()
      return { version: row.version as number, stalled: row.stalled as boolean }
    },
    async listRooms(token: string): Promise<RoomSummary[]> {
      if (!isHandle(token)) return []
      return await query(`SELECT r.id, r.title, r.status = 'working' AS busy, ${VIEWER_ACTIVITY} AS "lastActivity"
        FROM ampersand_rooms r JOIN ampersand_members m ON m.room_id = r.id
        WHERE m.token_hash = $1 ORDER BY "lastActivity" DESC, r.id COLLATE "C"`, [hashHandle(token)]) as unknown as RoomSummary[]
    },
    /** Any member can switch review on or off; the change applies from the room's next batch. */
    async setReview(id: string, token: string, review: boolean): Promise<RoomSnapshot> {
      if (!validId(id) || !isHandle(token)) throw notFound()
      const row = await admission(id, [], null, (p) => {
        const room = p(id), hash = p(hashHandle(token))
        return {
          context: `SELECT m.id AS member, false AS duplicate, CASE WHEN r.cleanup_owner IS NOT NULL THEN 'cleanup' END AS reason
            FROM ampersand_rooms r JOIN ampersand_members m ON m.room_id = r.id AND m.token_hash = ${hash} WHERE r.id = ${room}`,
          effect: `UPDATE ampersand_rooms SET review = ${p(review)}, version = version + 1
            WHERE id = ${room} AND EXISTS (SELECT 1 FROM decision WHERE refusal IS NULL) RETURNING id`,
        }
      })
      return readSnapshot(id, row.member as string)
    },
    /** A member can mint a new share link without invalidating existing links. */
    async createInvite(id: string, token: string): Promise<string> {
      if (!validId(id) || !isHandle(token)) throw notFound()
      const invite = randomHandle()
      await admission(id, [], null, (p) => {
        const room = p(id), hash = p(hashHandle(token))
        return {
          context: `SELECT false AS duplicate, CASE WHEN r.cleanup_owner IS NOT NULL THEN 'cleanup' END AS reason
            FROM ampersand_rooms r JOIN ampersand_members m ON m.room_id = r.id AND m.token_hash = ${hash} WHERE r.id = ${room}`,
          effect: `INSERT INTO ampersand_invites (room_id, invite_hash)
            SELECT ${room}, ${p(hashHandle(invite))} FROM decision WHERE refusal IS NULL RETURNING room_id`,
        }
      })
      return invite
    },
    /** Deduplication, quota reservation and the message commit share one locked transaction. */
    async appendMessage(id: string, token: string, input: { text: string; requestId: string; dailyLimit: number | null; hourlyUses?: HourlyUse[] }): Promise<{ room: RoomSnapshot; inserted: boolean }> {
      if (!validId(id) || !isHandle(token)) throw notFound()
      const text = boundedText(input.text, 'Message', MAX_MESSAGE_LENGTH)
      if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) throw new AuthError(400, 'Invalid message request ID')
      const row = await admission(id, input.hourlyUses ?? [], input.dailyLimit, (p) => {
        const room = p(id), hash = p(hashHandle(token)), request = p(input.requestId), body = p(text)
        return {
          context: `SELECT m.id AS member, m.name, prior.id IS NOT NULL AS duplicate, CASE
            WHEN r.cleanup_owner IS NOT NULL THEN 'cleanup'
            WHEN prior.id IS NOT NULL AND prior.text <> ${body} THEN 'conflict' END AS reason
            FROM ampersand_rooms r JOIN ampersand_members m ON m.room_id = r.id AND m.token_hash = ${hash}
            LEFT JOIN ampersand_messages prior ON prior.room_id = r.id AND prior.author_id = m.id AND prior.request_id = ${request}
            WHERE r.id = ${room}`,
          effect: `INSERT INTO ampersand_messages (room_id, author_id, author, role, text, created_at, request_id)
            SELECT ${room}, member, name, 'user', ${body}, ${p(Date.now())}, ${request} FROM decision
            WHERE refusal IS NULL AND NOT duplicate RETURNING id`,
          bump: true,
        }
      })
      return { room: await readSnapshot(id, row.member as string), inserted: row.result.length > 0 }
    },
    /** Only the winning explicit retry clears the durable cleanup barrier and reserves quota. */
    async retryRoom(id: string, token: string, dailyLimit: number | null, hourlyUses: HourlyUse[] = []): Promise<{ room: RoomSnapshot; started: boolean }> {
      if (!validId(id) || !isHandle(token)) throw notFound()
      const row = await admission(id, hourlyUses, dailyLimit, (p) => {
        const room = p(id), hash = p(hashHandle(token))
        return {
          context: `SELECT m.id AS member, NOT (r.status = 'error' AND ${NEWEST_PENDING} > 0
              AND (r.runner IS NULL OR r.runner_until <= ${DB_NOW})) AS duplicate,
            CASE WHEN r.cleanup_owner IS NOT NULL THEN 'cleanup' END AS reason
            FROM ampersand_rooms r JOIN ampersand_members m ON m.room_id = r.id AND m.token_hash = ${hash} WHERE r.id = ${room}`,
          effect: `UPDATE ampersand_rooms SET status = 'idle', error = NULL, cleanup_blocked = false, version = version + 1
            WHERE id = ${room} AND EXISTS (SELECT 1 FROM decision WHERE refusal IS NULL AND NOT duplicate) RETURNING id`,
        }
      })
      return { room: await readSnapshot(id, row.member as string), started: row.result.length > 0 }
    },
    // Trusted server-runner methods below; never expose them as routes. Their callers already bound every value.
    async snapshotInternal(id: string): Promise<RoomSnapshot> {
      return readSnapshot(id, '')
    },
    /** The latest page and its room-local revision number; 0 and empty before the first publish. */
    async latestDesign(id: string): Promise<{ html: string; revision: number }> {
      if (!validId(id)) throw notFound()
      const [row] = await query(`SELECT (SELECT html FROM ampersand_revisions WHERE room_id = r.id ORDER BY id DESC LIMIT 1) AS html,
        (SELECT COUNT(*)::int FROM ampersand_revisions WHERE room_id = r.id) AS revision FROM ampersand_rooms r WHERE r.id = $1`, [id])
      if (!row) throw notFound()
      return { html: (row.html as string | null) ?? '', revision: row.revision as number }
    },
    async pendingMessages(id: string): Promise<Message[]> {
      if (!validId(id)) throw notFound()
      const [room] = await query('SELECT processed_through FROM ampersand_rooms WHERE id = $1', [id])
      if (!room) throw notFound()
      return messages(id, room.processed_through as number, true)
    },
    /** The newest unsettled human message's id, or 0; one read, as runs check it before every visible effect. */
    async newestPendingId(id: string): Promise<number> {
      if (!validId(id)) throw notFound()
      const [row] = await query(`SELECT ${NEWEST_PENDING} AS newest FROM ampersand_rooms r WHERE r.id = $1`, [id])
      if (!row) throw notFound()
      return row.newest as number
    },
    async assertRun(id: string, guard: RunGuard): Promise<void> {
      await guarded(id, guard, (allowed) => ({ text: `SELECT 1 WHERE ${allowed}`, values: [] }))
    },
    /** Settle the batch and its visible success state in the same fenced effect. */
    async markProcessed(id: string, throughId: number, guard?: RunGuard): Promise<void> {
      await guarded(id, guard, (allowed) => ({
        text: `UPDATE ampersand_rooms SET processed_through = GREATEST(processed_through, $2), status = 'idle', error = NULL, version = version + 1
          WHERE id = $1 AND ${allowed} RETURNING id`, values: [id, throughId],
      }))
    },
    async setStatus(id: string, status: RoomStatus, error: string | null = null, guard?: RunGuard, cleanupBlocked?: boolean, failedThroughId?: number): Promise<void> {
      // A failure belongs to the attempted batch even if newer input needs a separate
      // handoff. A later queue-read failure must not reclassify already settled work.
      const statusGuard = status === 'error' && guard ? { runner: guard.runner } : guard
      await guarded(id, statusGuard, (allowed) => ({
        text: `UPDATE ampersand_rooms r SET status = $2, error = $3, cleanup_blocked = COALESCE($4::boolean, cleanup_blocked),
          failed_through = CASE WHEN $2 = 'error' THEN COALESCE($5::int, ${NEWEST_PENDING}) ELSE failed_through END, version = version + 1
          WHERE id = $1 AND ${allowed}
            AND ($2 <> 'error' OR $5::int IS NULL OR processed_through < $5::int)
          RETURNING id`, values: [id, status, error, cleanupBlocked ?? null, failedThroughId ?? null],
      }))
    },
    /** Only uncertain cancellation may persist a barrier for the same owner after lease expiry. */
    async blockRunCleanup(id: string, runner: string, error: string, failedThroughId: number): Promise<boolean> {
      if (!validId(id)) return false
      const results = await query.transaction([roomLock(id), {
        text: `UPDATE ampersand_rooms SET status = 'error', error = $3, cleanup_blocked = true,
          failed_through = GREATEST(failed_through, $4::int), version = version + 1
          WHERE id = $1 AND runner = $2 AND cleanup_owner IS NULL RETURNING id`, values: [id, runner, error, failedThroughId],
      }])
      return results[1].length > 0
    },
    async appendAssistant(id: string, text: string, guard?: RunGuard): Promise<void> {
      await guarded(id, guard, (allowed) => ({
        text: `INSERT INTO ampersand_messages (room_id, author_id, author, role, text, created_at)
          SELECT $1, 'assistant', 'Assistant', 'assistant', $2, $3 WHERE ${allowed} RETURNING id`,
        values: [id, text.trim(), Date.now()],
      }), true)
    },
    async publishDesign(id: string, html: string, guard?: RunGuard): Promise<Revision> {
      const [revision] = await guarded(id, guard, (allowed) => ({
        text: `INSERT INTO ampersand_revisions (room_id, html, created_at)
          SELECT $1, $2, $3 WHERE ${allowed} RETURNING id, created_at AS "createdAt"`, values: [id, html, Date.now()],
      }), true)
      return revision as unknown as Revision
    },
    async recordActivity(id: string, event: Omit<AgentActivity, 'id' | 'createdAt'>, guard?: RunGuard): Promise<void> {
      await guarded(id, guard, (allowed) => ({
        text: `INSERT INTO ampersand_activity (room_id, agent, kind, text, revision, created_at)
          SELECT $1, $2, $3, $4, $5, $6 WHERE ${allowed} RETURNING id`,
        values: [id, event.agent, event.kind, event.text.trim(), event.revision ?? null, Date.now()],
      }), true)
    },
    async agentSessions(id: string): Promise<Partial<Record<AgentSeat, SeatSession>>> {
      await roomExists(id)
      const rows = await query('SELECT seat, session_id AS "sessionId", delivered_through AS "deliveredThrough" FROM ampersand_sessions WHERE room_id = $1', [id]) as unknown as Array<SeatSession & { seat: AgentSeat }>
      return Object.fromEntries(rows.map(({ seat, sessionId, deliveredThrough }) => [seat, { sessionId, deliveredThrough }]))
    },
    /** Records a seat's session, replacing any earlier one, and the newest room message it has been sent. */
    async saveAgentSession(id: string, seat: AgentSeat, session: SeatSession, guard?: RunGuard): Promise<void> {
      await guarded(id, guard && { runner: guard.runner }, (allowed) => ({
        text: `INSERT INTO ampersand_sessions (room_id, seat, session_id, delivered_through)
          SELECT $1, $2, $3, $4 WHERE ${allowed}
          ON CONFLICT (room_id, seat) DO UPDATE SET session_id = excluded.session_id, delivered_through = excluded.delivered_through RETURNING room_id`,
        values: [id, seat, session.sessionId, session.deliveredThrough],
      }))
    },
    /**
     * Allocates `until - now` milliseconds from the DB clock, not a JS absolute deadline.
     * A live holder may extend its lease. An expired holder must use a new runner token.
     * The global cap counts DB-live leases after the separate coordination lock statement.
     */
    async claimRun(id: string, runner: string, now: number, until: number, maxRunning: number | null): Promise<boolean> {
      const durationMs = until - now
      if (!validId(id) || !Number.isFinite(durationMs) || durationMs <= 0) return false
      const results = await query.transaction([COORDINATION_LOCK, roomLock(id), {
        text: `UPDATE ampersand_rooms r SET runner = $2, runner_until = ${DB_NOW} + $3::double precision
          WHERE r.id = $1 AND NOT r.cleanup_blocked AND r.cleanup_owner IS NULL
            AND (r.status <> 'error' OR ${NEWEST_PENDING} > r.failed_through)
            AND (r.runner IS NULL OR (r.runner = $2 AND r.runner_until > ${DB_NOW})
              OR (r.runner <> $2 AND r.runner_until <= ${DB_NOW}))
            AND ($4::int IS NULL OR (SELECT COUNT(*) FROM ampersand_rooms o WHERE o.id <> $1 AND o.runner IS NOT NULL AND o.runner_until > ${DB_NOW}) < $4::int)
          RETURNING r.id`, values: [id, runner, durationMs, maxRunning],
      }])
      return results[2].length > 0
    },
    /** Extends an unexpired held lease by durationMs from DB time; never resurrects ownership. */
    async renewRun(id: string, runner: string, durationMs: number): Promise<boolean> {
      if (!Number.isFinite(durationMs) || durationMs <= 0) return false
      const results = await query.transaction([roomLock(id), {
        text: `UPDATE ampersand_rooms SET runner_until = ${DB_NOW} + $3::double precision WHERE id = $1 AND runner = $2
          AND runner_until > ${DB_NOW} AND cleanup_owner IS NULL AND NOT cleanup_blocked RETURNING id`, values: [id, runner, durationMs],
      }])
      return results[1].length > 0
    },
    async releaseRun(id: string, runner: string): Promise<void> {
      await query('UPDATE ampersand_rooms SET runner = NULL, runner_until = NULL WHERE id = $1 AND runner = $2', [id, runner])
    },
    /** Candidates only: claimCleanup rechecks after acquiring the admission lock. */
    async idleRooms(cutoff: number, limit: number, skip: string[]): Promise<string[]> {
      return (await query(`SELECT r.id FROM ampersand_rooms r
        WHERE ${ROOM_ACTIVITY} < $1 AND NOT (r.id = ANY($2::text[])) AND ${NEWEST_PENDING} = 0
          AND (r.runner IS NULL OR r.runner_until <= ${DB_NOW})
          AND (r.cleanup_owner IS NULL OR r.cleanup_until <= ${DB_NOW})
        ORDER BY ${ROOM_ACTIVITY}, r.id COLLATE "C" LIMIT $3`, [cutoff, skip, limit])).map((row) => row.id as string)
    },
    /** DB-clock duration. Expiry permits takeover, never admissions, until explicit release/delete. */
    async claimCleanup(id: string, runner: string, cutoff: number, durationMs: number): Promise<boolean> {
      if (!validId(id) || !Number.isFinite(durationMs) || durationMs <= 0) return false
      const results = await query.transaction([roomLock(id), {
        text: `UPDATE ampersand_rooms r SET cleanup_owner = $2, cleanup_until = ${DB_NOW} + $4::double precision
          WHERE r.id = $1 AND ${ROOM_ACTIVITY} < $3 AND ${NEWEST_PENDING} = 0
            AND (r.runner IS NULL OR r.runner_until <= ${DB_NOW})
            AND (r.cleanup_owner IS NULL OR r.cleanup_owner = $2 OR r.cleanup_until <= ${DB_NOW})
          RETURNING r.id`, values: [id, runner, cutoff, durationMs],
      }])
      return results[1].length > 0
    },
    async assertCleanup(id: string, runner: string): Promise<void> {
      const results = await query.transaction([roomLock(id), {
        text: `SELECT id FROM ampersand_rooms WHERE id = $1 AND cleanup_owner = $2 AND cleanup_until > ${DB_NOW}`, values: [id, runner],
      }])
      if (!results[1].length) throw new LeaseLostError()
    },
    /** Call only after all external sessions are known retired, including on a kept room. */
    async releaseCleanup(id: string, runner: string): Promise<void> {
      await query('UPDATE ampersand_rooms SET cleanup_owner = NULL, cleanup_until = NULL WHERE id = $1 AND cleanup_owner = $2', [id, runner])
    },
    async deleteIdleRoom(id: string, cutoff: number, cleanupRunner?: string): Promise<boolean> {
      const results = await query.transaction([roomLock(id), {
        text: `DELETE FROM ampersand_rooms r WHERE r.id = $1 AND ${ROOM_ACTIVITY} < $2 AND ${NEWEST_PENDING} = 0
          AND (r.runner IS NULL OR r.runner_until <= ${DB_NOW})
          AND r.cleanup_owner = $3::text AND r.cleanup_until > ${DB_NOW}
          RETURNING r.id`, values: [id, cutoff, cleanupRunner ?? null],
      }])
      return results[1].length > 0
    },
  }
}

export type RoomStore = ReturnType<typeof createRoomStore>
