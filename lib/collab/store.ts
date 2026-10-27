import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node strip-types tests require the source extension.
import { AuthError } from '../accounts.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { hashHandle, randomHandle } from '../auth-crypto.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { DAILY_LIMIT_MESSAGE, ROOM_FULL_MESSAGE } from './limits.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { isBoundedText, MAX_MEMBER_NAME_LENGTH, MAX_MESSAGE_LENGTH, MAX_ROOM_TITLE_LENGTH, type AgentActivity, type AgentSeat, type Member, type Message, type Revision, type RoomSnapshot, type RoomStatus, type RoomSummary, type SeatSession } from './types.ts'

const opaqueId = () => randomBytes(16).toString('base64url')
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value)
/** Browser tokens and invites both come from randomHandle(): 32 random bytes as base64url. */
export const isHandle = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
const notFound = () => new AuthError(404, 'Room not found')
// The newest of a join time and room r's newest message, revision and agent activity.
const lastActivity = (joined: string) => `MAX(${joined},
  COALESCE((SELECT MAX(created_at) FROM collab_messages WHERE room_id = r.id), 0),
  COALESCE((SELECT MAX(created_at) FROM collab_revisions WHERE room_id = r.id), 0),
  COALESCE((SELECT MAX(created_at) FROM collab_activity WHERE room_id = r.id), 0))`
// The sidebar orders rooms by the viewer's own join; expiry counts anyone's.
const VIEWER_ACTIVITY = lastActivity('m.joined_at')
const ROOM_ACTIVITY = lastActivity('COALESCE((SELECT MAX(joined_at) FROM collab_members WHERE room_id = r.id), 0)')
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)

function boundedText(value: unknown, label: string, max: number): string {
  if (!isBoundedText(value, max)) throw new AuthError(400, `${label} must contain 1–${max} characters`)
  return value.trim()
}

interface RoomRow {
  id: string
  title: string
  review: number
  status: RoomStatus
  error: string | null
  version: number
  processed_through: number
}

/** Local, single-process demo persistence. Calls are synchronous, so only multi-statement writes need a transaction. */
export function createRoomStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path, { timeout: 5000 })
  if (path !== ':memory:') chmodSync(path, 0o600)
  db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS collab_rooms (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        review INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'error')),
        error TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        processed_through INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS collab_invites (
        room_id TEXT NOT NULL REFERENCES collab_rooms(id),
        invite_hash TEXT NOT NULL,
        PRIMARY KEY (room_id, invite_hash)
      );
      CREATE TABLE IF NOT EXISTS collab_members (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES collab_rooms(id),
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        UNIQUE (room_id, token_hash)
      );
      CREATE TABLE IF NOT EXISTS collab_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL REFERENCES collab_rooms(id),
        author_id TEXT NOT NULL,
        author TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        request_id TEXT,
        UNIQUE (room_id, author_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS collab_messages_room ON collab_messages(room_id, id);
      CREATE TABLE IF NOT EXISTS collab_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL REFERENCES collab_rooms(id),
        html TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS collab_revisions_room ON collab_revisions(room_id, id);
      CREATE TABLE IF NOT EXISTS collab_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL REFERENCES collab_rooms(id),
        agent TEXT NOT NULL CHECK (agent IN ('Builder', 'Reviewer')),
        kind TEXT NOT NULL CHECK (kind IN ('message', 'publish', 'review')),
        text TEXT NOT NULL,
        revision INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS collab_activity_room ON collab_activity(room_id, id);
      CREATE TABLE IF NOT EXISTS collab_sessions (
        room_id TEXT NOT NULL REFERENCES collab_rooms(id),
        seat TEXT NOT NULL CHECK (seat IN ('Builder', 'Reviewer')),
        session_id TEXT NOT NULL,
        delivered_through INTEGER NOT NULL,
        PRIMARY KEY (room_id, seat)
      );
      CREATE TABLE IF NOT EXISTS collab_usage (
        day TEXT PRIMARY KEY,
        units INTEGER NOT NULL
      );
    `)
  // Rooms saved before review became optional ran with it on, so they keep it.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('collab_rooms') WHERE name = 'review'").get()) db.exec('ALTER TABLE collab_rooms ADD COLUMN review INTEGER NOT NULL DEFAULT 1')
  // A restart idles 'working' rooms but keeps their queue, and 'error' rooms keep their error. Every version moves, so open tabs read the room again and can resume it.
  db.prepare("UPDATE collab_rooms SET status = CASE status WHEN 'working' THEN 'idle' ELSE status END, version = version + 1").run()

  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function roomRow(id: string): RoomRow {
    if (!validId(id)) throw notFound()
    const room = db.prepare('SELECT * FROM collab_rooms WHERE id = ?').get(id) as unknown as RoomRow | undefined
    if (!room) throw notFound()
    return room
  }

  function requireMember(id: string, token: string): Member {
    if (!validId(id) || !isHandle(token)) throw notFound()
    const member = db.prepare('SELECT id, name, joined_at AS joinedAt FROM collab_members WHERE room_id = ? AND token_hash = ?')
      .get(id, hashHandle(token)) as unknown as Member | undefined
    if (!member) throw notFound()
    return member
  }

  // Counts one message, retry or resumed run against the day's limit; false once the limit is reached.
  function takeDailyUnit(limit: number | null): boolean {
    if (limit === null) return true
    const day = utcDay(Date.now())
    const used = (db.prepare('SELECT units FROM collab_usage WHERE day = ?').get(day) as { units: number } | undefined)?.units ?? 0
    if (used >= limit) return false
    db.prepare('INSERT INTO collab_usage (day, units) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET units = units + 1').run(day)
    return true
  }

  function bump(id: string): void {
    db.prepare('UPDATE collab_rooms SET version = version + 1 WHERE id = ?').run(id)
  }

  function messages(id: string, after = 0, usersOnly = false): Message[] {
    return db.prepare(`SELECT id, author_id AS authorId, author, role, text, created_at AS createdAt
      FROM collab_messages WHERE room_id = ? AND id > ? ${usersOnly ? "AND role = 'user'" : ''} ORDER BY id`)
      .all(id, after).map((row) => ({ ...row })) as unknown as Message[]
  }

  function readSnapshot(id: string, viewerId: string): RoomSnapshot {
    const room = roomRow(id)
    return {
      id: room.id,
      title: room.title,
      review: room.review === 1,
      members: db.prepare('SELECT id, name, joined_at AS joinedAt FROM collab_members WHERE room_id = ? ORDER BY joined_at, rowid').all(id).map((row) => ({ ...row })) as unknown as Member[],
      messages: messages(id),
      revisions: db.prepare('SELECT id, created_at AS createdAt FROM collab_revisions WHERE room_id = ? ORDER BY id').all(id).map((row) => ({ ...row })) as unknown as Revision[],
      activity: db.prepare(`SELECT id, agent, kind, text, revision, created_at AS createdAt FROM (
        SELECT * FROM collab_activity WHERE room_id = ? ORDER BY id DESC LIMIT 32
      ) ORDER BY id`).all(id).map((row) => ({ ...row, revision: row.revision ?? undefined })) as unknown as AgentActivity[],
      status: room.status,
      error: room.error,
      version: room.version,
      viewerId,
    }
  }

  return {
    close(): void {
      db.close()
    },
    createRoom(input: { name: string; title: string; token: string }): { room: RoomSnapshot; invite: string; memberId: string } {
      const name = boundedText(input.name, 'Name', MAX_MEMBER_NAME_LENGTH)
      const title = boundedText(input.title, 'Room title', MAX_ROOM_TITLE_LENGTH)
      if (!isHandle(input.token)) throw new AuthError(400, 'Invalid browser token')
      const id = opaqueId()
      const memberId = opaqueId()
      const invite = randomHandle()
      return transaction(() => {
        // Older databases may still have DEFAULT 1; new rooms always start with review off.
        db.prepare('INSERT INTO collab_rooms (id, title, review) VALUES (?, ?, 0)').run(id, title)
        db.prepare('INSERT INTO collab_invites (room_id, invite_hash) VALUES (?, ?)').run(id, hashHandle(invite))
        db.prepare('INSERT INTO collab_members (id, room_id, name, token_hash, joined_at) VALUES (?, ?, ?, ?, ?)')
          .run(memberId, id, name, hashHandle(input.token), Date.now())
        return { room: readSnapshot(id, memberId), invite, memberId }
      })
    },
    joinRoom(input: { id: string; invite: string; name: string; token: string; maxMembers: number | null }): { room: RoomSnapshot; memberId: string } {
      return transaction(() => {
        roomRow(input.id)
        if (!isHandle(input.invite) || !db.prepare('SELECT 1 FROM collab_invites WHERE room_id = ? AND invite_hash = ?').get(input.id, hashHandle(input.invite))
          || !isHandle(input.token)) throw notFound()
        const name = boundedText(input.name, 'Name', MAX_MEMBER_NAME_LENGTH)
        const existing = db.prepare('SELECT id FROM collab_members WHERE room_id = ? AND token_hash = ?')
          .get(input.id, hashHandle(input.token)) as { id: string } | undefined
        if (existing) return { room: readSnapshot(input.id, existing.id), memberId: existing.id }
        if (input.maxMembers !== null && (db.prepare('SELECT COUNT(*) AS count FROM collab_members WHERE room_id = ?').get(input.id) as { count: number }).count >= input.maxMembers) {
          throw new AuthError(403, ROOM_FULL_MESSAGE)
        }
        const memberId = opaqueId()
        db.prepare('INSERT INTO collab_members (id, room_id, name, token_hash, joined_at) VALUES (?, ?, ?, ?, ?)')
          .run(memberId, input.id, name, hashHandle(input.token), Date.now())
        bump(input.id)
        return { room: readSnapshot(input.id, memberId), memberId }
      })
    },
    snapshot(id: string, token: string): RoomSnapshot {
      return readSnapshot(id, requireMember(id, token).id)
    },
    /** One revision's HTML, for a member of its room. */
    revisionHtml(id: string, token: string, revisionId: number): string {
      requireMember(id, token)
      const row = db.prepare('SELECT html FROM collab_revisions WHERE room_id = ? AND id = ?').get(id, revisionId) as { html: string } | undefined
      if (!row) throw new AuthError(404, 'Design not found')
      return row.html
    },
    /** The room's version, for a member; it changes whenever the snapshot does. */
    version(id: string, token: string): number {
      requireMember(id, token)
      return roomRow(id).version
    },
    listRooms(token: string): RoomSummary[] {
      if (!isHandle(token)) return []
      const rows = db.prepare(`SELECT r.id, r.title, r.status = 'working' AS busy, ${VIEWER_ACTIVITY} AS lastActivity
      FROM collab_rooms r JOIN collab_members m ON m.room_id = r.id
      WHERE m.token_hash = ? ORDER BY lastActivity DESC, r.id`).all(hashHandle(token)) as Array<Omit<RoomSummary, 'busy'> & { busy: number }>
      return rows.map((row) => ({ ...row, busy: Boolean(row.busy) }))
    },
    /** Any member can switch review on or off; the change applies from the room's next batch. */
    setReview(id: string, token: string, review: boolean): RoomSnapshot {
      const member = requireMember(id, token)
      db.prepare('UPDATE collab_rooms SET review = ?, version = version + 1 WHERE id = ?').run(review ? 1 : 0, id)
      return readSnapshot(id, member.id)
    },
    /** A member can mint a new share link without invalidating existing links. */
    createInvite(id: string, token: string): string {
      requireMember(id, token)
      const invite = randomHandle()
      db.prepare('INSERT INTO collab_invites (room_id, invite_hash) VALUES (?, ?)').run(id, hashHandle(invite))
      return invite
    },
    /**
     * Stores a member's message; `inserted` is false for a repeat of a request already stored, which starts no new work.
     * `admit` runs only for a new, valid message, before anything is counted or stored, and throws to refuse it.
     */
    appendMessage(id: string, token: string, input: { text: string; requestId: string; dailyLimit: number | null; admit: () => void }): { room: RoomSnapshot; inserted: boolean } {
      return transaction(() => {
        const member = requireMember(id, token)
        const text = boundedText(input.text, 'Message', MAX_MESSAGE_LENGTH)
        if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) {
          throw new AuthError(400, 'Invalid message request ID')
        }
        const prior = db.prepare('SELECT text FROM collab_messages WHERE room_id = ? AND author_id = ? AND request_id = ?')
          .get(id, member.id, input.requestId) as { text: string } | undefined
        if (prior) {
          if (prior.text !== text) throw new AuthError(409, 'Message request ID already used')
          return { room: readSnapshot(id, member.id), inserted: false }
        }
        input.admit()
        if (!takeDailyUnit(input.dailyLimit)) throw new AuthError(429, DAILY_LIMIT_MESSAGE)
        db.prepare(`INSERT INTO collab_messages (room_id, author_id, author, role, text, created_at, request_id)
        VALUES (?, ?, ?, 'user', ?, ?, ?)`).run(id, member.id, member.name, text, Date.now(), input.requestId)
        bump(id)
        return { room: readSnapshot(id, member.id), inserted: true }
      })
    },
    /** Counts a retry or resumed run against the day's limit; false once the limit is reached. */
    takeRunUnit(dailyLimit: number | null): boolean {
      return transaction(() => takeDailyUnit(dailyLimit))
    },
    // Trusted server-runner methods below; never expose them as routes. Their callers already bound every value.
    snapshotInternal(id: string): RoomSnapshot {
      return readSnapshot(id, '')
    },
    /** Rooms with messages no run has settled yet. */
    roomsWithPendingMessages(): string[] {
      return (db.prepare(`SELECT r.id FROM collab_rooms r
      WHERE EXISTS (SELECT 1 FROM collab_messages m WHERE m.room_id = r.id AND m.role = 'user' AND m.id > r.processed_through)`).all() as Array<{ id: string }>).map((row) => row.id)
    },
    /** The latest page and its room-local revision number; 0 and empty before the first publish. */
    latestDesign(id: string): { html: string; revision: number } {
      roomRow(id)
      const latest = db.prepare('SELECT html FROM collab_revisions WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(id) as { html: string } | undefined
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM collab_revisions WHERE room_id = ?').get(id) as { count: number }
      return { html: latest?.html ?? '', revision: count }
    },
    pendingMessages(id: string): Message[] {
      return messages(id, roomRow(id).processed_through, true)
    },
    markProcessed(id: string, throughId: number): void {
      roomRow(id)
      db.prepare('UPDATE collab_rooms SET processed_through = MAX(processed_through, ?) WHERE id = ?').run(throughId, id)
    },
    setStatus(id: string, status: RoomStatus, error: string | null = null): void {
      roomRow(id)
      db.prepare('UPDATE collab_rooms SET status = ?, error = ?, version = version + 1 WHERE id = ?').run(status, error, id)
    },
    appendAssistant(id: string, text: string): void {
      transaction(() => {
        roomRow(id)
        db.prepare(`INSERT INTO collab_messages (room_id, author_id, author, role, text, created_at)
        VALUES (?, 'assistant', 'Assistant', 'assistant', ?, ?)`).run(id, text.trim(), Date.now())
        bump(id)
      })
    },
    publishDesign(id: string, html: string): Revision {
      return transaction(() => {
        roomRow(id)
        const row = db.prepare('INSERT INTO collab_revisions (room_id, html, created_at) VALUES (?, ?, ?)').run(id, html, Date.now())
        bump(id)
        return { ...db.prepare('SELECT id, created_at AS createdAt FROM collab_revisions WHERE id = ?').get(row.lastInsertRowid) } as unknown as Revision
      })
    },
    recordActivity(id: string, event: Omit<AgentActivity, 'id' | 'createdAt'>): void {
      transaction(() => {
        roomRow(id)
        db.prepare('INSERT INTO collab_activity (room_id, agent, kind, text, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, event.agent, event.kind, event.text.trim(), event.revision ?? null, Date.now())
        bump(id)
      })
    },
    agentSessions(id: string): Partial<Record<AgentSeat, SeatSession>> {
      roomRow(id)
      const rows = db.prepare('SELECT seat, session_id AS sessionId, delivered_through AS deliveredThrough FROM collab_sessions WHERE room_id = ?')
        .all(id) as unknown as Array<SeatSession & { seat: AgentSeat }>
      return Object.fromEntries(rows.map(({ seat, sessionId, deliveredThrough }) => [seat, { sessionId, deliveredThrough }]))
    },
    /** Up to `limit` rooms, oldest first and none of `skip`, with no join, message, revision or agent activity since the cutoff, except ones running now. Reads don't count. */
    idleRooms(cutoff: number, limit: number, skip: string[]): string[] {
      return (db.prepare(`SELECT r.id FROM collab_rooms r
      WHERE r.status != 'working' AND ${ROOM_ACTIVITY} < ? AND r.id NOT IN (SELECT value FROM json_each(?))
      ORDER BY ${ROOM_ACTIVITY}, r.id LIMIT ?`).all(cutoff, JSON.stringify(skip), limit) as Array<{ id: string }>).map((row) => row.id)
    },
    /** Deletes a room and everything in it, unless it was used or started running since the cutoff; true if it was deleted. */
    deleteIdleRoom(id: string, cutoff: number): boolean {
      return transaction(() => {
        if (!db.prepare(`SELECT 1 FROM collab_rooms r WHERE r.id = ? AND r.status != 'working' AND ${ROOM_ACTIVITY} < ?`).get(id, cutoff)) return false
        for (const table of ['collab_sessions', 'collab_activity', 'collab_revisions', 'collab_messages', 'collab_members', 'collab_invites']) {
          db.prepare(`DELETE FROM ${table} WHERE room_id = ?`).run(id)
        }
        db.prepare('DELETE FROM collab_rooms WHERE id = ?').run(id)
        return true
      })
    },
    /** Records a seat's session, replacing any earlier one, and the newest room message it has been sent. */
    saveAgentSession(id: string, seat: AgentSeat, session: SeatSession): void {
      roomRow(id)
      db.prepare(`INSERT INTO collab_sessions (room_id, seat, session_id, delivered_through) VALUES (?, ?, ?, ?)
      ON CONFLICT (room_id, seat) DO UPDATE SET session_id = excluded.session_id, delivered_through = excluded.delivered_through`)
        .run(id, seat, session.sessionId, session.deliveredThrough)
    },
  }
}

export type RoomStore = ReturnType<typeof createRoomStore>
