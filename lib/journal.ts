import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Redis } from '@upstash/redis'
// @ts-expect-error Node's strip-types integration test requires the source extension.
import { assetReference, rewriteRemoteImages, validateDesignArtifactHtml } from './design-artifact.ts'
// @ts-expect-error Node's strip-types integration test requires the source extension.
import { CAPTURE_ACK_MS, CAPTURE_WAIT_MS, type CaptureFailure, type ShotTiming } from './capture-protocol.ts'
// @ts-expect-error Node's strip-types integration test requires the source extension.
import { type DesignMdInput } from './design-md.ts'
// @ts-expect-error Node's strip-types integration test requires the source extension.
import { type SessionInfo, type SessionView, type StreamItem } from './events.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { createTranscriptReader, type TranscriptSnapshot } from './transcript.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { AuthError } from './accounts.ts'

const PREFIX = process.env.FX0_REDIS_PREFIX?.trim() || 'fx0:v1'

let client: Redis | null = null

function redisConfig(): { url: string; token: string } {
  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  if (!url || !token) throw new Error('Redis journal is not configured (KV_REST_API_URL/KV_REST_API_TOKEN)')
  return { url, token }
}

export function redis(): Redis {
  if (!client) client = new Redis(redisConfig())
  return client
}

// BLPOP over Upstash's REST API, which the client library does not expose: one request
// blocks in Redis for up to `seconds` and returns as soon as a value is pushed. Aborting
// ends the request; the caller withdraws whatever it was waiting for (see awaitCapture).
// A request that outlives its block by much has stalled, and fails like any other error.
async function blockingPop(listKey: string, seconds: number, signal: AbortSignal): Promise<string | null> {
  const { url, token } = redisConfig()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(['BLPOP', listKey, String(seconds)]),
      signal: AbortSignal.any([signal, AbortSignal.timeout((seconds + 5) * 1000)]),
    })
    if (!response.ok) throw new Error(`Redis BLPOP failed with ${response.status}`)
    const { result } = await response.json() as { result: [string, string] | null }
    return result?.[1] ?? null
  } catch (error) {
    if (signal.aborted) return null
    throw error
  }
}

// Events committed by this process, announced the moment Redis confirms them. A
// stream in the same process (a prompt's own response, where its worker also runs)
// delivers them without waiting for its next journal poll; polling still covers
// events written by other instances, and seq keeps delivery exactly-once.
const g = globalThis as unknown as { __fx0LocalEvents?: EventEmitter }
export const localEvents = g.__fx0LocalEvents ??= new EventEmitter().setMaxListeners(0)

// Ephemeral, display-only events (a design being written, for instance) that are
// never journaled: only streams in this process see them, and a reload does not.
export function emitLive(sessionId: string, item: StreamItem): void {
  localEvents.emit(`${sessionId}:live`, item)
}

function announce<T extends StreamItem | null | undefined>(sessionId: string, item: T): T {
  if (item && typeof item.seq === 'number') localEvents.emit(sessionId, item)
  return item
}

function key(sessionId: string, part: string): string {
  return `${PREFIX}:session:${sessionId}:${part}`
}

export function prefixed(part: string): string {
  return `${PREFIX}:${part}`
}

const LEASE_MS = 180_000

export class SessionCleanupError extends Error {
  constructor() {
    super('chat was deleted or is being deleted')
    this.name = 'SessionCleanupError'
  }
}

export interface StoredSession {
  id: string
  createdAt: number
  // When the chat last received a prompt. Only submitPrompt sets it, so the
  // sidebar keeps chats in the order their prompts arrived, not their replies.
  lastActivity: number
  title: string | null
  preferredModel: string | null
  preferredEffort: string | null
  preferredFast: boolean | null
  // Set by the prompt that created the chat; the text lives in its own key.
  designMd: DesignMdMeta | null
  // The libfx session that holds this chat's conversation, once its first prompt ran.
  libfxSessionId: string | null
  // The turn that published the current design, so its end records that version.
  artifactTurn: number | null
  trialChat: boolean
}

export interface DesignMdMeta {
  name: string
  source: string
  sha: string
  bytes: number
}

export interface DurablePromptImage {
  type: 'image'
  data: string
  mimeType: string
}

export interface DurablePrompt {
  id: number
  author: string
  text: string
  clientId?: string
  images?: DurablePromptImage[]
  previews?: string[]
}

// The turn libfx is running, as the projector last saw it: the message that
// started it, when, and the team billed. It expires on its own, so a lost
// turn_end can't leave a chat busy forever.
export interface ActiveTurn {
  sponsored?: true
  id: number
  startedAt: number
  billingTeamId: string | null
  // The prompt text for the turn's history row, and the transcript position its
  // response starts at.
  prompt: string
  startSeq: number
  // The settings the turn started with. A settings change during the turn
  // applies from the next one. Absent on turns started before this was recorded.
  settings?: TurnSettings
}

export interface TurnSettings { model: string; effort: string; fast: boolean }

function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return value as T
}

// Creates the state hash on first write. Returns whether the hash already existed.
const INIT_STATE = `
local function init_state(state, id, now)
  local exists = redis.call('EXISTS', state)
  redis.call('HSETNX', state, 'id', id)
  redis.call('HSETNX', state, 'createdAt', now)
  redis.call('HSETNX', state, 'artifactRevision', 0)
  return exists
end
`

const SUBMIT_PROMPT = INIT_STATE + `
if redis.call('EXISTS', KEYS[4]) == 1 then return false end
local trial = redis.call('HGET', KEYS[5], 'trialChat')
if not trial then
  local previous = tonumber(redis.call('GET', KEYS[1]) or '0')
  trial = previous == 0 and ARGV[7] == '1' and '1' or '0'
end
-- A paid conversation cannot acquire sponsorship behind an already-admitted
-- steer. Trial eligibility is fixed before its first SDK submission.
if ARGV[7] == '1' and trial ~= '1' then return cjson.encode({error = 'not_trial_chat'}) end
local now = tonumber(ARGV[1])
local id = redis.call('INCR', KEYS[1])
local event = cjson.decode(ARGV[2])
event.id = id
local seq = redis.call('INCR', KEYS[2])
event.seq = seq
local created = init_state(KEYS[5], ARGV[3], now) == 0
if created and ARGV[5] ~= '' then
  local design = cjson.decode(ARGV[5])
  redis.call('HSET', KEYS[5], 'designMd', ARGV[5])
  redis.call('SET', KEYS[6], ARGV[6])
  event.designMd = { name = design.name, source = design.source }
end
-- Idle: no turn is running and the latest earlier message's turn has ended, so
-- this message starts a turn of its own. A settings notice, a status with no
-- turn, doesn't count. Read before this message is appended.
local idle = redis.call('EXISTS', KEYS[7]) == 0
if idle then
  local recent = redis.call('LRANGE', KEYS[3], -10, -1)
  for i = #recent, 1, -1 do
    local item = cjson.decode(recent[i])
    if not (item.type == 'status' and item.turnId == nil) then
      idle = item.type == 'done' or (item.type == 'error' and item.turnId ~= nil)
      break
    end
  end
end
redis.call('RPUSH', KEYS[3], cjson.encode(event))
if created and ARGV[4] ~= '' then
  for field, value in pairs(cjson.decode(ARGV[4])) do redis.call('HSET', KEYS[5], field, value) end
end
redis.call('HSET', KEYS[5], 'lastActivity', now)
redis.call('HSET', KEYS[5], 'trialChat', trial)
if event.text and event.text ~= '' then
  redis.call('HSETNX', KEYS[5], 'title', string.sub(event.text, 1, 40))
end
return cjson.encode({id = id, event = event, idle = idle, trialChat = trial == '1'})
`

export type InitialGeneration = Partial<Pick<StoredSession, 'preferredModel' | 'preferredEffort' | 'preferredFast'>> & {
  designMd?: DesignMdInput | null
}

// `initial` applies only when this prompt creates the chat, in the same atomic
// script, so a new chat needs no separate settings write before its first prompt.
// `idle` says whether the chat had no turn running or waiting when it arrived.
export async function submitPrompt(
  sessionId: string,
  prompt: Omit<DurablePrompt, 'id'>,
  initial?: InitialGeneration,
  sponsored = false,
): Promise<{ id: number; event: StreamItem; idle: boolean; trialChat: boolean }> {
  const now = Date.now()
  const initialFields: Record<string, string> = {}
  for (const name of ['preferredModel', 'preferredEffort', 'preferredFast'] as const) {
    const value = initial?.[name]
    if (value != null && value !== '') initialFields[name] = String(value)
  }
  const design = initial?.designMd
  const designMeta: DesignMdMeta | null = design
    ? {
        name: design.name,
        source: design.source,
        sha: createHash('sha256').update(design.text).digest('hex'),
        bytes: Buffer.byteLength(design.text),
      }
    : null
  const raw = await redis().eval<unknown[], unknown>(
    SUBMIT_PROMPT,
    [
      key(sessionId, 'message-seq'), key(sessionId, 'event-seq'), key(sessionId, 'events'),
      key(sessionId, 'deleting'), key(sessionId, 'state'), key(sessionId, 'design-md'),
      key(sessionId, 'active'),
    ],
    [
      String(now),
      JSON.stringify({
        type: 'user', at: now, clientId: prompt.clientId, author: prompt.author,
        text: prompt.text, imageCount: prompt.images?.length || undefined,
        imagePreviews: prompt.previews?.length ? prompt.previews : undefined,
      }),
      sessionId,
      Object.keys(initialFields).length ? JSON.stringify(initialFields) : '',
      designMeta ? JSON.stringify(designMeta) : '',
      // Wrapped so the client's JSON auto-parsing can never turn the text into a value.
      design ? JSON.stringify({ text: design.text }) : '',
      sponsored ? '1' : '0',
    ],
  )
  if (raw === false || raw === null) throw new SessionCleanupError()
  const result = parseJson<{ id: number; event: StreamItem; idle?: boolean; trialChat?: boolean; error?: string }>(raw)
  if (result.error === 'not_trial_chat') throw new AuthError(409, 'Free prompts are available in a new design')
  announce(sessionId, result.event)
  return { id: result.id, event: result.event, idle: result.idle === true, trialChat: result.trialChat === true }
}

const APPEND_EVENT = INIT_STATE + `
if redis.call('EXISTS', KEYS[4]) == 1 then return false end
local item = cjson.decode(ARGV[1])
local seq = redis.call('INCR', KEYS[1])
item.seq = seq
redis.call('RPUSH', KEYS[2], cjson.encode(item))
init_state(KEYS[3], ARGV[2], ARGV[3])
return cjson.encode(item)
`

export async function appendEvent(
  sessionId: string,
  entry: Omit<StreamItem, 'seq' | 'at'> & { at?: number },
): Promise<StreamItem> {
  const now = entry.at ?? Date.now()
  const raw = await redis().eval<unknown[], unknown>(
    APPEND_EVENT,
    [key(sessionId, 'event-seq'), key(sessionId, 'events'), key(sessionId, 'state'), key(sessionId, 'deleting')],
    [JSON.stringify({ ...entry, at: now }), sessionId, String(now)],
  )
  if (raw === null || raw === false) throw new SessionCleanupError()
  return announce(sessionId, parseJson<StreamItem>(raw))
}

export async function readEvents(sessionId: string, afterSeq = 0): Promise<StreamItem[]> {
  // Event sequence starts at 1 and the transcript list is append-only, so the
  // sequence itself is the zero-based LRANGE offset for the next item.
  const events = (await redis().lrange<unknown>(key(sessionId, 'events'), Math.max(0, afterSeq), -1)) ?? []
  return events
    .map((item) => parseJson<StreamItem>(item))
    .filter((item) => typeof item.seq === 'number' && item.seq > afterSeq)
}

export async function currentSeq(sessionId: string): Promise<number> {
  return Number((await redis().get<number>(key(sessionId, 'event-seq'))) ?? 0)
}

// Read the checkpoint and its tail atomically, including concurrent appends.
const READ_TRANSCRIPT = `
local previous = redis.call('GET', KEYS[1])
local offset = 0
if previous then
  local ok, value = pcall(cjson.decode, previous)
  if ok and value.version == 1 then offset = value.lastSeq else previous = false end
end
return {previous or false, redis.call('LRANGE', KEYS[2], offset, -1),
  redis.call('HGETALL', KEYS[3]), redis.call('EXISTS', KEYS[4])}
`

const PUBLISH_TRANSCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
local previous = redis.call('GET', KEYS[1])
if previous then
  local ok, value = pcall(cjson.decode, previous)
  if ok and value.version == 1 and value.lastSeq >= tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`

export async function publishTranscriptSnapshot(id: string, snapshot: TranscriptSnapshot): Promise<void> {
  await redis().eval(PUBLISH_TRANSCRIPT, [key(id, 'transcript'), key(id, 'events'), key(id, 'deleting')],
    [String(snapshot.lastSeq), JSON.stringify(snapshot)])
}

export const readTranscript = createTranscriptReader({
  async read(id) {
    const [previous, tail, fields, busy] = await redis().eval<unknown[], [unknown, unknown[], string[], number]>(
      READ_TRANSCRIPT, [key(id, 'transcript'), key(id, 'events'), key(id, 'state'), key(id, 'active')], [])
    const values: Record<string, string> = {}
    for (let i = 0; i < fields.length; i += 2) values[fields[i]] = fields[i + 1]
    const stored = parseStoredSession(id, values)
    const view = sessionView(values)
    return {
      previous: previous ? parseJson<TranscriptSnapshot>(previous) : null,
      events: tail.map((item) => parseJson<StreamItem>(item)),
      view,
      summary: stored ? { id, title: stored.title, createdAt: stored.createdAt, lastActivity: stored.lastActivity, busy: busy > 0, ...(stored.trialChat ? { trialChat: true as const } : {}),
        ...(view.artifactRevision > 0 ? { artifactRevision: view.artifactRevision } : {}) } : null,
    }
  },
  publish: publishTranscriptSnapshot,
})

const NEXT_QUESTION_ID = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
return redis.call('INCR', KEYS[1])
`
export async function nextQuestionId(sessionId: string): Promise<number> {
  const id = await redis().eval<unknown[], number>(NEXT_QUESTION_ID,
    [key(sessionId, 'question-seq'), key(sessionId, 'deleting')], [])
  if (!id) throw new SessionCleanupError()
  return id
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return null
}

function sessionView(value: Record<string, unknown> | null): SessionView {
  return { artifactRevision: Number(value?.artifactRevision ?? 0) }
}

function parseStoredSession(sessionId: string, value: Record<string, unknown> | null): StoredSession | null {
  if (!value?.id) return null
  return {
    id: sessionId,
    createdAt: Number(value.createdAt ?? Date.now()),
    lastActivity: Number(value.lastActivity ?? value.createdAt ?? Date.now()),
    title: nullableString(value.title),
    preferredModel: nullableString(value.preferredModel),
    preferredEffort: nullableString(value.preferredEffort),
    preferredFast: nullableBoolean(value.preferredFast),
    designMd: parseDesignMdMeta(value.designMd),
    libfxSessionId: nullableString(value.libfxSessionId),
    artifactTurn: value.artifactTurn == null || value.artifactTurn === '' ? null : Number(value.artifactTurn),
    trialChat: nullableBoolean(value.trialChat) === true,
  }
}

function parseDesignMdMeta(value: unknown): DesignMdMeta | null {
  if (value == null || value === '') return null
  try {
    const meta = parseJson<Partial<DesignMdMeta>>(value)
    if (typeof meta?.name !== 'string' || typeof meta.source !== 'string' || typeof meta.sha !== 'string') return null
    return { name: meta.name, source: meta.source, sha: meta.sha, bytes: Number(meta.bytes ?? 0) }
  } catch {
    return null
  }
}

// Ownership reservation must refuse any id with journal data or a deletion
// tombstone, not just chats with a metadata hash. One bounded Redis round trip.
export async function sessionExists(sessionId: string): Promise<boolean> {
  const parts = [...SESSION_PARTS, 'deleting', 'cleanup']
  return (await redis().exists(...parts.map((part) => key(sessionId, part)))) > 0
}

export async function readSession(sessionId: string): Promise<StoredSession | null> {
  return parseStoredSession(sessionId, await redis().hgetall<Record<string, unknown>>(key(sessionId, 'state')))
}

export async function readSessionView(sessionId: string): Promise<SessionView> {
  return sessionView(await redis().hgetall<Record<string, unknown>>(key(sessionId, 'state')))
}

export async function readDesignArtifact(sessionId: string): Promise<string | null> {
  return (await redis().get<string>(key(sessionId, 'design-artifact'))) ?? null
}

const READ_DESIGN_ARTIFACT_AT = `return {redis.call('GET', KEYS[1]), redis.call('HGET', KEYS[2], 'artifactRevision')}`

// The live design with its revision, read together: publishing writes both in one
// script, so the pair always matches.
export async function readDesignArtifactAt(sessionId: string): Promise<{ html: string | null; revision: number }> {
  const [html, revision] = await redis().eval<unknown[], [unknown, unknown]>(
    READ_DESIGN_ARTIFACT_AT,
    [key(sessionId, 'design-artifact'), key(sessionId, 'state')],
    [],
  )
  return { html: typeof html === 'string' ? html : null, revision: Number(revision ?? 0) }
}

export async function readDesignMd(sessionId: string): Promise<string | null> {
  const stored = await redis().get<unknown>(key(sessionId, 'design-md'))
  if (stored == null) return null
  const { text } = parseJson<{ text?: unknown }>(stored)
  return typeof text === 'string' ? text : null
}

const SESSION_PARTS = [
  'asset-count',
  'assets',
  'draft',
  'draft-chunks',
  'active',
  'active-question',
  'answer',
  'capture',
  'capture-replies',
  'preview-waits',
  'design-artifact',
  'design-md',
  'event-seq',
  'events',
  'message-seq',
  'projected',
  'question-seq',
  'state',
  'transcript',
  'turn-designs',
  'turn-work',
] as const

const CLAIM_CLEANUP = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'missing' end
if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 'busy' end
redis.call('SET', KEYS[3], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[4], '1')
return 'claimed'
`

export async function claimSessionCleanup(sessionId: string, token: string): Promise<'claimed' | 'busy' | 'missing'> {
  return redis().eval<unknown[], 'claimed' | 'busy' | 'missing'>(CLAIM_CLEANUP,
    [key(sessionId, 'state'), key(sessionId, 'active'), key(sessionId, 'cleanup'), key(sessionId, 'deleting')],
    [token, String(LEASE_MS)],
  )
}

const RENEW_CLEANUP = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`
export async function renewSessionCleanup(sessionId: string, token: string): Promise<boolean> {
  return (await redis().eval<unknown[], number>(RENEW_CLEANUP,
    [key(sessionId, 'cleanup')], [token, String(LEASE_MS)])) === 1
}

// The deleting tombstone is not a session part: it outlives the chat.
// The keys after the session parts include the chat's libfx session mapping.
const FINISH_CLEANUP = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('EXISTS', KEYS[2]) == 0 or redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('DEL', unpack(KEYS, 4))
redis.call('DEL', KEYS[1])
return 1
`

export async function finishSessionCleanup(sessionId: string, token: string, libfxSessionId: string | null): Promise<boolean> {
  return (await redis().eval<unknown[], number>(FINISH_CLEANUP,
    [key(sessionId, 'cleanup'), key(sessionId, 'state'), key(sessionId, 'active'),
      ...SESSION_PARTS.map((part) => key(sessionId, part)),
      ...(libfxSessionId ? [prefixed(`libfx-session:${libfxSessionId}`)] : [])],
    [token],
  )) === 1
}

const RELEASE_CLEANUP = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`
export async function releaseSessionCleanup(sessionId: string, token: string): Promise<void> {
  await redis().eval<unknown[], number>(RELEASE_CLEANUP, [key(sessionId, 'cleanup')], [token])
}

// Caller supplies IDs already selected by account ownership. Batch metadata,
// activity and nonempty-chat checks instead of sending two requests per chat.
export async function readSessionSummaries(ids: string[]): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = []
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    const pipeline = redis().pipeline()
    for (const id of batch) {
      pipeline.hmget(key(id, 'state'), 'id', 'createdAt', 'lastActivity', 'title', 'trialChat', 'preferredModel', 'preferredEffort', 'preferredFast', 'artifactRevision')
      pipeline.exists(key(id, 'active'))
      pipeline.get(key(id, 'message-seq'))
    }
    const values = await pipeline.exec()
    for (let index = 0; index < batch.length; index++) {
      if (Number(values[index * 3 + 2] ?? 0) < 1) continue
      const fields = values[index * 3] as Record<string, unknown> | null
      const state = parseStoredSession(batch[index], fields)
      if (!state) continue
      const { artifactRevision } = sessionView(fields)
      sessions.push({ id: state.id, title: state.title, createdAt: state.createdAt,
        lastActivity: state.lastActivity, busy: Number(values[index * 3 + 1] ?? 0) > 0,
        ...(state.trialChat ? { trialChat: true as const } : {}),
        generation: { model: state.preferredModel ?? '', effort: state.preferredEffort ?? '', fast: state.preferredFast ?? false },
        ...(Number.isSafeInteger(artifactRevision) && artifactRevision > 0 ? { artifactRevision } : {}) })
    }
  }
  return sessions.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 100)
}

const UPDATE_SESSION = INIT_STATE + `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
init_state(KEYS[1], ARGV[1], ARGV[2])
for name, value in pairs(cjson.decode(ARGV[3])) do redis.call('HSET', KEYS[1], name, value) end
return 1
`

export async function updateSession(
  sessionId: string,
  fields: Partial<Pick<StoredSession, 'preferredModel' | 'preferredEffort' | 'preferredFast'>>,
): Promise<void> {
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries(fields)) values[name] = value == null ? '' : String(value)
  const updated = await redis().eval<unknown[], number>(
    UPDATE_SESSION,
    [key(sessionId, 'state'), key(sessionId, 'deleting')],
    [sessionId, String(Date.now()), JSON.stringify(values)],
  )
  if (!updated) throw new SessionCleanupError()
}

const PUBLISH_DESIGN_ARTIFACT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return cjson.encode({status = 'fenced'})
end
if redis.call('HGET', KEYS[6], 'turnId') == ARGV[3] then
  redis.call('HSET', KEYS[6], 'closed', 1, 'published', 1)
  redis.call('DEL', KEYS[7])
end
local revision = tonumber(redis.call('HGET', KEYS[2], 'artifactRevision') or '0')
if redis.call('GET', KEYS[3]) == ARGV[1] then
  return cjson.encode({status = 'unchanged', revision = revision})
end
-- The design another turn published last is that turn's history version. A turn
-- whose end is still to be projected would find it replaced, so keep it now.
local previous = redis.call('HGET', KEYS[2], 'artifactTurn')
if previous and previous ~= '' and previous ~= ARGV[3] then
  local html = redis.call('GET', KEYS[3])
  if html then
    redis.call('HSET', KEYS[8], previous, cjson.encode({revision = revision, html = html}))
    redis.call('EXPIRE', KEYS[8], ARGV[4])
  end
end
redis.call('SET', KEYS[3], ARGV[1])
revision = redis.call('HINCRBY', KEYS[2], 'artifactRevision', 1)
local event = {type = 'artifact', artifactRevision = revision, at = tonumber(ARGV[2])}
if ARGV[3] ~= '' then
  event.turnId = tonumber(ARGV[3])
  redis.call('HSET', KEYS[2], 'artifactTurn', ARGV[3])
else
  redis.call('HDEL', KEYS[2], 'artifactTurn')
end
local seq = redis.call('INCR', KEYS[4])
event.seq = seq
redis.call('RPUSH', KEYS[5], cjson.encode(event))
return cjson.encode({status = 'published', revision = revision, event = event})
`

// The images a chat's messages attached, by handle: what a design may name as
// fx0-asset:<handle>. Deleting the chat removes this with the rest of its keys, which
// makes the stored files unreachable at once (lib/design-assets.ts).
export interface DesignAsset { mimeType: string; bytes: number }

// Attached images are capped per chat and per user per UTC day. Both counts are
// checked and taken together, atomically, before any file is stored, so concurrent
// prompts cannot overshoot; a failed upload gives its share back.
export const MAX_CHAT_ASSETS = 50
export const MAX_DAILY_ASSETS = 100

const RESERVE_ASSETS = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 'deleted' end
local count = tonumber(ARGV[1])
local chat = tonumber(redis.call('GET', KEYS[1]) or '0')
local daily = tonumber(redis.call('GET', KEYS[2]) or '0')
if chat + count > tonumber(ARGV[2]) then return 'chat' end
if daily + count > tonumber(ARGV[3]) then return 'daily' end
redis.call('INCRBY', KEYS[1], count)
redis.call('INCRBY', KEYS[2], count)
redis.call('EXPIRE', KEYS[2], 172800)
return 'ok'
`

const RELEASE_ASSETS = `
local count = tonumber(ARGV[1])
for _, name in ipairs(KEYS) do
  if tonumber(redis.call('GET', name) or '0') >= count then redis.call('DECRBY', name, count) end
end
return 1
`

const dailyAssetKey = (userId: string, now: number) => prefixed(`user:${userId}:assets:${new Date(now).toISOString().slice(0, 10)}`)

export async function reserveDesignAssets(sessionId: string, userId: string, count: number, now = Date.now()): Promise<'ok' | 'chat' | 'daily'> {
  const result = await redis().eval<string[], 'ok' | 'chat' | 'daily' | 'deleted'>(RESERVE_ASSETS,
    [key(sessionId, 'asset-count'), dailyAssetKey(userId, now), key(sessionId, 'deleting')], [String(count), String(MAX_CHAT_ASSETS), String(MAX_DAILY_ASSETS)])
  if (result === 'deleted') throw new SessionCleanupError()
  return result
}

export async function releaseDesignAssets(sessionId: string, userId: string, count: number, now = Date.now()): Promise<void> {
  await redis().eval<string[], number>(RELEASE_ASSETS, [key(sessionId, 'asset-count'), dailyAssetKey(userId, now)], [String(count)])
}

const RECORD_ASSETS = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
for handle, asset in pairs(cjson.decode(ARGV[1])) do redis.call('HSET', KEYS[1], handle, cjson.encode(asset)) end
return 1
`

export async function recordDesignAssets(sessionId: string, assets: { handle: string; mimeType: string; bytes: number }[]): Promise<void> {
  if (!assets.length) return
  const recorded = await redis().eval<unknown[], number>(RECORD_ASSETS,
    [key(sessionId, 'assets'), key(sessionId, 'deleting')],
    [JSON.stringify(Object.fromEntries(assets.map(({ handle, mimeType, bytes }) => [handle, { mimeType, bytes }])))])
  if (recorded !== 1) throw new SessionCleanupError()
}

// Failed uploads retain their quota until their files have actually been removed.
// This outbox survives request failures and chat deletion; later asset writes retry
// a bounded batch. Completion removes the manifest entries and refunds exactly once.
export interface DesignAssetCleanup { sessionId: string; userId: string; handles: string[]; reservedAt: number }

const assetCleanupKey = () => prefixed('asset-cleanup')
const assetCleanupReceipt = (cleanup: DesignAssetCleanup) => prefixed(`asset-cleanup-done:${createHash('sha256').update(JSON.stringify(cleanup)).digest('hex')}`)

const QUEUE_ASSET_CLEANUP = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
return 1
`

export async function queueDesignAssetCleanup(cleanup: DesignAssetCleanup): Promise<void> {
  await redis().eval<unknown[], number>(QUEUE_ASSET_CLEANUP,
    [assetCleanupKey(), assetCleanupReceipt(cleanup)], [String(Date.now()), JSON.stringify(cleanup)])
}

const PENDING_ASSET_CLEANUPS = `
local pending = redis.call('ZRANGE', KEYS[1], 0, 9)
for _, job in ipairs(pending) do redis.call('ZADD', KEYS[1], ARGV[1], job) end
return pending
`

export async function pendingDesignAssetCleanups(): Promise<DesignAssetCleanup[]> {
  // Rotate attempted jobs behind newer ones without recreating a completed job
  // after an ambiguous completion response. Overlapping workers are safe below.
  return redis().eval<unknown[], DesignAssetCleanup[]>(PENDING_ASSET_CLEANUPS, [assetCleanupKey()], [String(Date.now())])
}

const FINISH_ASSET_CLEANUP = `
if not redis.call('SET', KEYS[5], '1', 'NX', 'EX', 172800) then return 0 end
redis.call('ZREM', KEYS[4], ARGV[1])
local handles = cjson.decode(ARGV[2])
for _, handle in ipairs(handles) do redis.call('HDEL', KEYS[3], handle) end
local count = #handles
for index = 1, 2 do
  if tonumber(redis.call('GET', KEYS[index]) or '0') >= count then redis.call('DECRBY', KEYS[index], count) end
end
return 1
`

export async function finishDesignAssetCleanup(cleanup: DesignAssetCleanup): Promise<void> {
  // The receipt outlives any request retry. Even an enqueue whose response was
  // lost cannot recreate this job or refund a completed rollback a second time.
  await redis().eval<unknown[], number>(FINISH_ASSET_CLEANUP,
    [key(cleanup.sessionId, 'asset-count'), dailyAssetKey(cleanup.userId, cleanup.reservedAt), key(cleanup.sessionId, 'assets'), assetCleanupKey(), assetCleanupReceipt(cleanup)],
    [JSON.stringify(cleanup), JSON.stringify(cleanup.handles)])
}

export async function readDesignAssets(sessionId: string, handles?: string[]): Promise<Map<string, DesignAsset>> {
  const found = new Map<string, DesignAsset>()
  if (handles && !handles.length) return found
  const values = handles
    ? await redis().hmget<Record<string, unknown>>(key(sessionId, 'assets'), ...handles)
    : await redis().hgetall<Record<string, unknown>>(key(sessionId, 'assets'))
  for (const [handle, value] of Object.entries(values ?? {})) {
    const asset = value == null ? null : parseJson<DesignAsset | null>(value)
    if (asset && typeof asset.mimeType === 'string') found.set(handle, asset)
  }
  return found
}

export type PublishDesignArtifactResult =
  | { ok: true; revision: number; changed: boolean; event?: StreamItem }
  | { ok: false; reason: 'invalid' | 'fenced'; error: string }

export async function publishDesignArtifact(
  sessionId: string,
  html: string,
  turnId: number | null = null,
): Promise<PublishDesignArtifactResult> {
  const validation = validateDesignArtifactHtml(html)
  if (!validation.ok) return { ok: false, reason: 'invalid', error: validation.error }
  // An attached image is named by a handle the model was given; one this chat never
  // received is refused here, so the model fixes it rather than showing a blank.
  const handles = new Set<string>()
  rewriteRemoteImages(validation.html, (reference) => {
    const asset = assetReference(reference)
    if (asset) handles.add(asset.slice('fx0-asset:'.length))
    return null
  })
  if (handles.size) {
    const known = await readDesignAssets(sessionId, [...handles])
    const unknown = [...handles].find((handle) => !known.has(handle))
    if (unknown) return { ok: false, reason: 'invalid', error: `fx0-asset:${unknown} is not an image attached to this chat` }
  }

  const raw = await redis().eval<unknown[], unknown>(
    PUBLISH_DESIGN_ARTIFACT,
    [
      key(sessionId, 'deleting'),
      key(sessionId, 'state'),
      key(sessionId, 'design-artifact'),
      key(sessionId, 'event-seq'),
      key(sessionId, 'events'),
      key(sessionId, 'draft'),
      key(sessionId, 'draft-chunks'),
      key(sessionId, 'turn-designs'),
    ],
    // The stored design is the normalized one validation passed, never the raw input.
    // The turn lets the transcript group a turn's revisions under its activity.
    [validation.html, String(Date.now()), turnId == null ? '' : String(turnId), String(TURN_WORK_SECONDS)],
  )
  const result = parseJson<{
    status: 'published' | 'unchanged' | 'fenced'
    revision?: number
    event?: StreamItem
  }>(raw)
  if (result.status === 'fenced') {
    return { ok: false, reason: 'fenced', error: 'the chat was deleted before publishing' }
  }
  return {
    ok: true,
    revision: Number(result.revision ?? 0),
    changed: result.status === 'published',
    event: announce(sessionId, result.event),
  }
}

// projectEvents marks a turn active at its turn_start and clears it at its end,
// in the same script as those lines. The TTL bounds a turn whose end is never seen.
const ACTIVE_TURN_MS = 30 * 60_000

export async function getActiveTurn(sessionId: string): Promise<ActiveTurn | null> {
  const value = await redis().get<unknown>(key(sessionId, 'active'))
  return value == null ? null : parseJson<ActiveTurn>(value)
}

export interface ActiveQuestion {
  turnId: number
  qid: number
}

// ask_user_question waits in its tool call for an answer, at most this long.
export const QUESTION_WAIT_MS = 600_000

const SET_QUESTION = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`
export async function setActiveQuestion(sessionId: string, question: ActiveQuestion): Promise<void> {
  const set = await redis().eval<unknown[], number>(SET_QUESTION,
    [key(sessionId, 'active-question'), key(sessionId, 'deleting')],
    [JSON.stringify(question), String(QUESTION_WAIT_MS)])
  if (!set) throw new SessionCleanupError()
}

export async function getActiveQuestion(sessionId: string): Promise<ActiveQuestion | null> {
  const value = await redis().get<unknown>(key(sessionId, 'active-question'))
  return value == null ? null : parseJson<ActiveQuestion>(value)
}

// An answer is accepted once, and only for the question still open.
const ANSWER_QUESTION = `
local value = redis.call('GET', KEYS[1])
if not value or cjson.decode(value).qid ~= tonumber(ARGV[1]) then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
return 1
`
export async function answerActiveQuestion(sessionId: string, qid: number, answers: Record<string, string>): Promise<boolean> {
  return (await redis().eval<unknown[], number>(ANSWER_QUESTION,
    [key(sessionId, 'active-question'), key(sessionId, 'answer')],
    [String(qid), JSON.stringify({ qid, answers }), String(QUESTION_WAIT_MS)])) === 1
}

// The waiting tool takes its answer; an answer to another question stays put.
const TAKE_ANSWER = `
local value = redis.call('GET', KEYS[1])
if not value or cjson.decode(value).qid ~= tonumber(ARGV[1]) then return false end
redis.call('DEL', KEYS[1])
return value
`
export async function takeAnswer(sessionId: string, qid: number): Promise<Record<string, string> | null> {
  const raw = await redis().eval<unknown[], unknown>(TAKE_ANSWER, [key(sessionId, 'answer')], [String(qid)])
  return raw == null || raw === false ? null : parseJson<{ answers: Record<string, string> }>(raw).answers
}

// Withdraws the question when its tool call stops waiting. Returns whether it was
// still open, so only one side reports it resolved.
const CLEAR_QUESTION = `
local value = redis.call('GET', KEYS[1])
if not value or cjson.decode(value).qid ~= tonumber(ARGV[1]) then return 0 end
redis.call('DEL', KEYS[1])
return 1
`
export async function clearActiveQuestion(sessionId: string, qid: number): Promise<boolean> {
  return (await redis().eval<unknown[], number>(CLEAR_QUESTION, [key(sessionId, 'active-question')], [String(qid)])) === 1
}

export interface CaptureShot {
  // The viewport, or a full page's viewport-high tiles from the top.
  images: { mimeType: string; data: string }[]
  width?: number
  height?: number
  // A full page taller than the tiles cover.
  truncated?: boolean
  // The tab's and /api/capture's part of the capture's trace (lib/capture-protocol.ts).
  timing?: ShotTiming
}

// The Redis side of the screenshot protocol (lib/capture-protocol.ts). The tool call opens a
// capture and blocks on the chat's reply list; /api/capture pushes the tab's acknowledgement,
// then its photo or failure, so the call wakes the moment each arrives, on whichever instance
// runs the turn. No polling. A key whose format changes gets a new name, so instances of two
// deploys never misread it.

/** What a tab answered for a capture it acknowledged. */
export type CaptureAnswer = { kind: 'shot'; shot: CaptureShot } | { kind: 'failed'; reason: CaptureFailure }

/** How a capture ended for the waiting call. */
export type CaptureOutcome =
  | CaptureAnswer
  | { kind: 'unanswered' } // no tab acknowledged it within the ack window
  | { kind: 'timeout' } // a tab acknowledged it, then sent nothing in time
  | { kind: 'cancelled' }

const OPEN_CAPTURE = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('DEL', KEYS[2])
return 1
`
export async function openCapture(sessionId: string, cid: string): Promise<void> {
  const set = await redis().eval<unknown[], number>(OPEN_CAPTURE,
    [key(sessionId, 'capture'), key(sessionId, 'capture-replies'), key(sessionId, 'deleting')],
    [cid, String(CAPTURE_ACK_MS + CAPTURE_WAIT_MS)])
  if (!set) throw new SessionCleanupError()
}

// A reply counts only for the capture still open. An acknowledgement leaves it open for the
// whole wait it starts; a photo or a failure closes it, so the first answer is the only one.
const REPLY_CAPTURE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[4] == '1' then redis.call('DEL', KEYS[1]) else redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1
`
async function replyCapture(sessionId: string, cid: string, reply: { kind: 'ack' } | CaptureAnswer): Promise<boolean> {
  return (await redis().eval<unknown[], number>(REPLY_CAPTURE,
    [key(sessionId, 'capture'), key(sessionId, 'capture-replies')],
    [cid, JSON.stringify({ cid, ...reply }), String(CAPTURE_ACK_MS + CAPTURE_WAIT_MS), reply.kind === 'ack' ? '0' : '1'])) === 1
}

/** A tab took the request; false when the capture is no longer open (a replayed event). */
export const acknowledgeCapture = (sessionId: string, cid: string) => replyCapture(sessionId, cid, { kind: 'ack' })
/** The tab's photo or failure; false when the capture is no longer open or already answered. */
export const answerCapture = (sessionId: string, cid: string, answer: CaptureAnswer) => replyCapture(sessionId, cid, answer)

// Upstash ends long requests on its own terms; waiting in slices keeps each one short. A
// slice that fails is retried while the wait has time left, so one bad request does not
// refuse a photo already on its way.
const CAPTURE_BLOCK_SECONDS = 10
const CAPTURE_POP_ATTEMPTS = 3

function replyFor(value: unknown, cid: string): { kind: 'ack' } | CaptureAnswer | null {
  const stored = parseJson<{ cid?: string; kind?: string; shot?: CaptureShot; reason?: CaptureFailure }>(value)
  if (stored?.cid !== cid) return null
  if (stored.kind === 'ack') return { kind: 'ack' }
  if (stored.kind === 'failed' && stored.reason) return { kind: 'failed', reason: stored.reason }
  return stored.kind === 'shot' && stored.shot ? { kind: 'shot', shot: stored.shot } : null
}

/**
 * Waits for the open capture: first for a tab to acknowledge it within `ackMs`, then for
 * its photo or failure within CAPTURE_WAIT_MS. However it ends, the capture is withdrawn,
 * so a reply sent afterwards is refused instead of left behind.
 */
export async function awaitCapture(sessionId: string, cid: string, signal: AbortSignal, ackMs = CAPTURE_ACK_MS): Promise<CaptureOutcome> {
  const replies = key(sessionId, 'capture-replies')
  let acknowledged = false
  let deadline = Date.now() + ackMs
  let failures = 0
  try {
    for (let left = ackMs; left > 0 && !signal.aborted; left = deadline - Date.now()) {
      let value: string | null
      try {
        value = await blockingPop(replies, Math.min(CAPTURE_BLOCK_SECONDS, Math.ceil(left / 1000)), signal)
        failures = 0
      } catch (error) {
        if (++failures >= CAPTURE_POP_ATTEMPTS) throw error
        continue
      }
      const reply = value == null ? null : replyFor(value, cid)
      if (reply?.kind === 'ack') {
        if (!acknowledged) deadline = Date.now() + CAPTURE_WAIT_MS
        acknowledged = true
      } else if (reply) return reply
    }
  } catch (error) {
    await closeCapture(sessionId, cid).catch(() => {})
    throw error
  }
  // An answer accepted just before the capture closed is already in the list.
  if (!await closeCapture(sessionId, cid)) {
    for (let late = await redis().lpop<unknown>(replies); late != null; late = await redis().lpop<unknown>(replies)) {
      const reply = replyFor(late, cid)
      if (reply && reply.kind !== 'ack') return reply
    }
  }
  if (signal.aborted) return { kind: 'cancelled' }
  return { kind: acknowledged ? 'timeout' : 'unanswered' }
}

// How long a screenshot call waited for the preview, by the model's id for the call. The
// call records it before it returns, so it is there when the projector writes the call's
// tool_end; the transcript leaves that wait out of the call's time.
const PREVIEW_WAITS_TTL_MS = 86_400_000

export async function recordPreviewWait(sessionId: string, toolCallId: string, ms: number): Promise<void> {
  const waits = key(sessionId, 'preview-waits')
  await redis().pipeline().hset(waits, { [toolCallId]: Math.round(ms) }).pexpire(waits, PREVIEW_WAITS_TTL_MS).exec()
}

export async function readPreviewWaits(sessionId: string, toolCallIds: string[]): Promise<Map<string, number>> {
  if (!toolCallIds.length) return new Map()
  const values = await redis().hmget<Record<string, unknown>>(key(sessionId, 'preview-waits'), ...toolCallIds)
  const waits = new Map<string, number>()
  for (const id of toolCallIds) {
    const ms = Number(values?.[id])
    if (Number.isFinite(ms) && ms > 0) waits.set(id, ms)
  }
  return waits
}

// Withdraws the capture when its tool call stops waiting; true if it was still open.
const CLOSE_CAPTURE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`
export async function closeCapture(sessionId: string, cid: string): Promise<boolean> {
  return (await redis().eval<unknown[], number>(CLOSE_CAPTURE, [key(sessionId, 'capture')], [cid])) === 1
}

// The first libfx session id stored for a chat wins, so two first prompts racing
// on the same chat still share one conversation. The reverse key lets the agent's
// fetch find the chat from the x-session-id libfx sends with each model request.
const BIND_LIBFX_SESSION = `
if redis.call('EXISTS', KEYS[2]) == 1 then return false end
local current = redis.call('HGET', KEYS[1], 'libfxSessionId')
if current and current ~= '' then return current end
redis.call('HSET', KEYS[1], 'libfxSessionId', ARGV[1])
redis.call('SET', KEYS[3], ARGV[2])
return ARGV[1]
`
export async function bindLibfxSession(sessionId: string, candidate: string): Promise<string> {
  const bound = await redis().eval<unknown[], unknown>(BIND_LIBFX_SESSION,
    [key(sessionId, 'state'), key(sessionId, 'deleting'), prefixed(`libfx-session:${candidate}`)],
    [candidate, sessionId])
  if (typeof bound !== 'string') throw new SessionCleanupError()
  return bound
}

export async function chatOfLibfxSession(libfxSessionId: string): Promise<string | null> {
  return (await redis().get<string>(prefixed(`libfx-session:${libfxSessionId}`))) ?? null
}

export async function projectedCursor(sessionId: string): Promise<number> {
  return Number((await redis().get<number>(key(sessionId, 'projected'))) ?? 0)
}

// A turn's running record, as its start is projected: its startSeq is the seq the
// turn_start line gets in the same script.
export type TurnStart = Omit<ActiveTurn, 'startSeq'>

// What a finished turn still owes its history, kept in Redis until it is written:
// its end, the running record that end found (absent if the start was never
// recorded), and the design the turn left. Work for a design alone comes from a
// publish that replaced it before the turn's end was projected.
export interface TurnWork {
  turnId: number
  type?: 'done' | 'error'
  stopReason?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  at?: number
  turn?: ActiveTurn
  design?: { revision: number; html: string }
}

// Work left by a turn whose history cannot be written is retried by later
// followers of the chat, for this long.
const TURN_WORK_SECONDS = 7 * 24 * 60 * 60

// Appends the items copied from libfx's stream between two cursors, only if no
// other projector moved the cursor first: each libfx line reaches the transcript
// once however many projectors follow the chat. The turn bookkeeping those lines
// imply commits with them: a turn_start marks the turn running, and a turn's end
// clears it and leaves the turn's history work, with the design it left if it
// published last. So a crash, or a projector on another instance, can neither skip
// that bookkeeping nor apply it out of order.
const PROJECT_EVENTS = INIT_STATE + `
if redis.call('EXISTS', KEYS[4]) == 1 then return false end
if tonumber(redis.call('GET', KEYS[5]) or '0') ~= tonumber(ARGV[1]) then return false end
local items = cjson.decode(ARGV[3])
local starts = cjson.decode(ARGV[6])
local out = {}
for i, item in ipairs(items) do
  local ended = item.type == 'done' or item.type == 'error'
  if ended then
    local turn = item.turnId or item.id or 0
    local closed = tonumber(redis.call('HGET', KEYS[3], 'draftClosedTurn') or '0')
    redis.call('HSET', KEYS[3], 'draftClosedTurn', math.max(closed, turn))
    if tonumber(redis.call('HGET', KEYS[6], 'turnId') or '0') == turn then
      redis.call('HSET', KEYS[6], 'closed', 1)
      redis.call('DEL', KEYS[7])
    end
  end
  item.seq = redis.call('INCR', KEYS[1])
  local encoded = cjson.encode(item)
  redis.call('RPUSH', KEYS[2], encoded)
  out[i] = encoded
  if item.type == 'turn_start' and item.id and starts[tostring(item.id)] then
    local start = starts[tostring(item.id)]
    start.startSeq = item.seq
    redis.call('SET', KEYS[8], cjson.encode(start), 'PX', ARGV[7])
  elseif ended and item.id then
    local work = {turnId = item.id, type = item.type, stopReason = item.stopReason, usage = item.usage, at = item.at}
    local active = redis.call('GET', KEYS[8])
    if active then
      local running = cjson.decode(active)
      if running.id == item.id then
        work.turn = running
        redis.call('DEL', KEYS[8])
      end
    end
    redis.call('HSET', KEYS[9], tostring(item.id), cjson.encode(work))
    redis.call('EXPIRE', KEYS[9], ARGV[8])
    if tonumber(redis.call('HGET', KEYS[3], 'artifactTurn') or '0') == item.id then
      local html = redis.call('GET', KEYS[11])
      if html then
        local revision = tonumber(redis.call('HGET', KEYS[3], 'artifactRevision') or '0')
        redis.call('HSET', KEYS[10], tostring(item.id), cjson.encode({revision = revision, html = html}))
        redis.call('EXPIRE', KEYS[10], ARGV[8])
      end
      redis.call('HDEL', KEYS[3], 'artifactTurn')
    end
  end
end
redis.call('SET', KEYS[5], ARGV[2])
init_state(KEYS[3], ARGV[4], ARGV[5])
return out
`
export async function projectEvents(
  sessionId: string,
  fromCursor: number,
  toCursor: number,
  entries: (Omit<StreamItem, 'seq'>)[],
  starts: Record<number, TurnStart> = {},
): Promise<StreamItem[] | null> {
  const raw = await redis().eval<unknown[], unknown>(PROJECT_EVENTS,
    [key(sessionId, 'event-seq'), key(sessionId, 'events'), key(sessionId, 'state'), key(sessionId, 'deleting'),
      key(sessionId, 'projected'), key(sessionId, 'draft'), key(sessionId, 'draft-chunks'),
      key(sessionId, 'active'), key(sessionId, 'turn-work'), key(sessionId, 'turn-designs'), key(sessionId, 'design-artifact')],
    [String(fromCursor), String(toCursor), JSON.stringify(entries), sessionId, String(Date.now()),
      JSON.stringify(starts), String(ACTIVE_TURN_MS), String(TURN_WORK_SECONDS)])
  if (raw === null || raw === false) return null
  // An empty Lua table comes back as an empty array or an empty object.
  const items = Array.isArray(raw) ? raw.map((item) => parseJson<StreamItem>(item)) : []
  for (const item of items) announce(sessionId, item)
  return items
}

// Every finished turn's history work still waiting, oldest turn first.
export async function readTurnWork(sessionId: string): Promise<TurnWork[]> {
  const [work, designs] = await Promise.all([
    redis().hgetall<Record<string, unknown>>(key(sessionId, 'turn-work')),
    redis().hgetall<Record<string, unknown>>(key(sessionId, 'turn-designs')),
  ])
  const byTurn = new Map<number, TurnWork>()
  for (const value of Object.values(work ?? {})) {
    const item = parseJson<TurnWork>(value)
    byTurn.set(item.turnId, item)
  }
  for (const [turn, value] of Object.entries(designs ?? {})) {
    const turnId = Number(turn)
    byTurn.set(turnId, { ...(byTurn.get(turnId) ?? { turnId }), design: parseJson<{ revision: number; html: string }>(value) })
  }
  return [...byTurn.values()].sort((a, b) => a.turnId - b.turnId)
}

// A turn's history is written: its work and its design go together.
const FINISH_TURN_WORK = `
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`
export async function finishTurnWork(sessionId: string, turnId: number): Promise<void> {
  await redis().eval<unknown[], number>(FINISH_TURN_WORK,
    [key(sessionId, 'turn-work'), key(sessionId, 'turn-designs')], [String(turnId)])
}
