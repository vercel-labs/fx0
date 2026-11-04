import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { createAmpersandClient } from '../lib/collab/ampersand.ts'
import { collabLimits, DAILY_LIMIT_MESSAGE, HOURLY_MESSAGE_LIMIT_MESSAGE, HOURLY_ROOM_LIMIT_MESSAGE, PAUSED_MESSAGE, ROOM_FULL_MESSAGE } from '../lib/collab/limits.ts'
import { MAX_ERROR_LENGTH, MAX_MESSAGE_LENGTH, MISSING_API_KEY_MESSAGE } from '../lib/collab/types.ts'
import { createAgentsApi, delivered } from './fixtures/agents-api.mjs'
import { createRoomsDatabase, databaseText, storeOn } from './fixtures/rooms-db.mjs'

// Routes, cookie and origin policy, the Postgres store (on PGlite), the runtime, the group and the client run unchanged against the fake API.
// Only Next's request scope is faked: after() work waits in a list for the test to run, and connection() resolves at once.
const root = new URL('../', import.meta.url)
const nextServer = `data:text/javascript,${encodeURIComponent('export function after(work) { globalThis.__fx0CollabAfter.push(work) } export async function connection() {}')}`
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next/server') return { url: nextServer, shortCircuit: true }
  // Routes and the runtime import siblings without extensions, as Next resolves them.
  if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    return next(`${specifier}.ts`, context)
  }
  return next(specifier, context)
} })
const ORIGIN = 'https://demo.example'
process.env.FX0_COLLAB_ORIGIN = ORIGIN
const routes = await import('../app/api/ampersand/route.ts')
const artifactRoute = await import('../app/api/ampersand/artifact/route.ts')
// After the hooks, like the routes: the runtime imports its siblings without extensions.
const { createCollabRuntime } = await import('../lib/collab/runtime.ts')
const DAY = 24 * 60 * 60 * 1000
// The Google load balancer appends the client's address and then its own.
const LOAD_BALANCER = '130.211.0.1'

const page = (heading) => `<!doctype html><html><head><title>Team</title></head><body><h1>${heading}</h1></body></html>`
const text = (item) => item.content[0].text
const requestIds = (design) => design.pending_requests.map((request) => request.id)

// Includes every pending request in the heading, preserves prior content, then replies after review.
const builder = async (turn) => {
  const requests = turn.messages('room')
  if (requests.length) {
    const design = await turn.read()
    const previous = /<h1>(.*?)<\/h1>/.exec(design.html)?.[1]
    const heading = [...new Set([previous, ...design.pending_requests.map((request) => request.text)].filter(Boolean))].join(' | ')
    await turn.call('publish_design', { html: page(heading), base_revision: design.revision })
  }
  if (turn.has('notice', /^Reviewer approved revision \d+\./)) await turn.call('room_reply', { content: `Done: ${text(turn.messages('notice').at(-1))}`, addressed_message_ids: requestIds(await turn.read()) })
}
const reviewer = async (turn) => {
  if (!turn.has('notice', /^Builder published revision \d+\./)) return
  const design = await turn.read()
  await turn.call('finish_review', { revision: design.revision, summary: 'Checked the heading.', addressed_message_ids: requestIds(design) })
}
const done = (revision) => `Done: Reviewer approved revision ${revision}. Notes: Checked the heading.`
const started = (api, count) => new Promise((resolve) => {
  const check = () => api.bySeat('Builder').filter((session) => session.turns.length).length >= count ? resolve() : setImmediate(check)
  check()
})

async function fixture(t, scripts = {}, limits = collabLimits({})) {
  const db = await createRoomsDatabase()
  const api = createAgentsApi({ scripts })
  const client = createAmpersandClient({ baseUrl: 'https://ampersand.test/v1', apiKey: api.apiKey, fetch: api.fetch })
  const f = {
    api, db, after: [],
    get store() { return globalThis.__fx0CollabRuntime.store },
    start() { globalThis.__fx0CollabRuntime = { ...createCollabRuntime(storeOn(db), limits), client } },
    // Another process on the same database: a new lease holder with no workers in memory.
    restart() {
      f.start()
    },
    async drain() {
      while (f.after.length) await f.after.shift()()
    },
  }
  f.start()
  globalThis.__fx0CollabAfter = f.after
  Object.assign(process.env, { AMPERSAND_API_KEY: api.apiKey, AMPERSAND_MODEL: 'ampersand-test' })
  t.after(async () => {
    assert.equal(globalThis.__fx0CollabRuntime.running.size, 0, 'every room worker finished')
    await db.close()
    delete globalThis.__fx0CollabRuntime
    delete process.env.AMPERSAND_API_KEY
    delete process.env.AMPERSAND_MODEL
  })
  return f
}

function request(path, { body, cookie, from = ORIGIN, address } = {}) {
  const headers = { ...(cookie ? { cookie } : {}), ...(body !== undefined && from ? { origin: from } : {}), ...(address ? { 'x-forwarded-for': `${address}, ${LOAD_BALANCER}` } : {}) }
  return new Request(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
}
const get = (path, cookie) => routes.GET(request(path, { cookie }))
const post = (body, cookie, from, address) => routes.POST(request('/api/ampersand', { body, cookie, from, address }))
const cookieOf = (response) => response.headers.get('set-cookie').split(';')[0]
const roomOf = async (owner, cookie = owner.cookie) => (await (await get(`/api/ampersand?room=${owner.room.id}`, cookie)).json()).room
const sourceOf = (owner, revisionId, cookie = owner.cookie) => get(`/api/ampersand?room=${owner.room.id}&revision=${revisionId}`, cookie)
// Snapshots list revisions without HTML, so each design is read on its own.
const designsOf = async (owner) => Promise.all((await roomOf(owner)).revisions.map(async (revision) => (await (await sourceOf(owner, revision.id)).json()).html))

async function create(name, cookie, address) {
  const response = await post({ action: 'create', name, title: `${name}'s board` }, cookie, ORIGIN, address)
  assert.equal(response.status, 201)
  return { ...await response.json(), cookie: cookieOf(response), response }
}

// These scenarios exercise two-agent coordination, so they opt into review explicitly.
async function createReviewed(name, cookie, address) {
  const owner = await create(name, cookie, address)
  const response = await post({ action: 'review', id: owner.room.id, enabled: true }, owner.cookie)
  assert.equal(response.status, 200)
  owner.room = (await response.json()).room
  return owner
}

let sent = 0
const sayAs = (member, content, address, requestId = `request-${++sent}`) => post({ action: 'message', id: member.room.id, text: content, requestId }, member.cookie, ORIGIN, address)
async function say(member, content) {
  const response = await sayAs(member, content)
  assert.equal(response.status, 200)
  return (await response.json()).room
}
async function refused(response, status, error) {
  assert.equal(response.status, status)
  assert.deepEqual(await response.json(), { error })
}

test('rooms admit only their members, and identity and authorship come from the browser cookie', async (t) => {
  const f = await fixture(t)
  const alice = await create('Alice')
  const outsider = await create('Outsider')
  const id = alice.room.id
  const token = alice.cookie.slice('fx0-collab='.length)
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.match(alice.invite, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(alice.response.headers.get('set-cookie'), `${alice.cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800; Secure`, 'an HTTPS origin gets a Secure cookie')
  assert.equal(alice.response.headers.get('cache-control'), 'private, no-store')
  assert.equal(alice.response.headers.get('referrer-policy'), 'no-referrer')
  const revision = await f.store.publishDesign(id, page('Board'))
  const artifact = (query, cookie) => artifactRoute.GET(request(`/api/ampersand/artifact?${query}`, { cookie }))

  // Missing, foreign, malformed and look-alike cookies all get the same 404, and no work is scheduled.
  for (const cookie of [undefined, outsider.cookie, 'fx0-collab=short', `fx0-collab=${token}x`, `prefix-${alice.cookie}`, `${alice.cookie}%0a`]) {
    const read = await get(`/api/ampersand?room=${id}`, cookie)
    assert.equal(read.status, 404, `read with ${cookie}`)
    assert.deepEqual(await read.json(), { error: 'Room not found' })
    for (const action of ['invite', 'message', 'retry']) assert.equal((await post({ action, id, text: 'Uninvited', requestId: 'foreign' }, cookie)).status, 404, `${action} with ${cookie}`)
    assert.equal((await artifact(`room=${id}&revision=${revision.id}`, cookie)).status, 404, `artifact with ${cookie}`)
  }
  assert.equal(f.after.length, 0)
  assert.notEqual((await create('Dana', 'fx0-collab=short')).cookie, 'fx0-collab=short', 'a malformed cookie is replaced, not reused')

  // A join needs this room's invite; minting another never rotates the first, and a rejoin keeps the member.
  const minted = (await (await post({ action: 'invite', id }, alice.cookie)).json()).invite
  assert.notEqual(minted, alice.invite)
  const eve = await post({ action: 'join', id, invite: outsider.invite, name: 'Eve' })
  assert.equal(eve.status, 404)
  assert.equal(eve.headers.get('set-cookie'), null)
  const bobJoin = await post({ action: 'join', id, invite: minted, name: 'Bob' })
  const bob = { ...await bobJoin.json(), cookie: `other=value; ${cookieOf(bobJoin)}; another=value` }
  assert.equal((await post({ action: 'join', id, invite: alice.invite, name: 'Carol' })).status, 200)
  const rejoined = await (await post({ action: 'join', id, invite: alice.invite, name: 'Impersonator' }, bob.cookie)).json()
  assert.equal(rejoined.memberId, bob.memberId)
  assert.deepEqual(rejoined.room.members.map((member) => member.name), ['Alice', 'Bob', 'Carol'])

  // The author is the cookie's member, whatever the body claims; request IDs dedupe per member.
  const forged = { action: 'message', id, text: 'Add a timeline', requestId: 'bob-first', author: 'Alice', authorId: alice.memberId, role: 'assistant' }
  const posted = (await (await post(forged, bob.cookie)).json()).room
  assert.deepEqual(posted.messages.map(({ authorId, author, role }) => ({ authorId, author, role })), [{ authorId: bob.memberId, author: 'Bob', role: 'user' }])
  assert.equal(posted.viewerId, bob.memberId)
  const repeated = (await (await post(forged, bob.cookie)).json()).room
  assert.deepEqual([repeated.messages.length, repeated.version], [1, posted.version])
  assert.equal((await post({ ...forged, text: 'Changed my mind' }, bob.cookie)).status, 409)
  assert.equal((await (await post(forged, alice.cookie)).json()).room.messages.length, 2)

  // Designs are served to members only, from their own room, sandboxed without network or same-origin access.
  const served = await artifact(`room=${id}&revision=${revision.id}`, bob.cookie)
  assert.equal(served.status, 200)
  const csp = served.headers.get('content-security-policy')
  assert.match(csp, /sandbox allow-scripts/)
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-forms|allow-popups/)
  for (const directive of [/connect-src 'none'/, /frame-ancestors 'self'/, /form-action 'none'/]) assert.match(csp, directive)
  assert.deepEqual(['cache-control', 'referrer-policy', 'x-content-type-options'].map((name) => served.headers.get(name)), ['private, no-store', 'no-referrer', 'nosniff'])
  assert.match(await served.text(), /<h1>Board<\/h1>/)
  const foreign = await f.store.publishDesign(outsider.room.id, page('Other'))
  for (const query of [`room=${id}&revision=${foreign.id}`, `room=${id}&revision=0`, `room=${id}&revision=1.5`, `revision=${revision.id}`]) {
    assert.equal((await artifact(query, bob.cookie)).status, 404, query)
  }
  // Snapshots list revisions without their HTML; a member reads one revision's source at a time, from their own room only.
  const room = await roomOf({ room: { id } }, bob.cookie)
  assert.deepEqual(room.revisions, [{ id: revision.id, createdAt: revision.createdAt }])
  assert.deepEqual(await (await sourceOf({ room: { id } }, revision.id, bob.cookie)).json(), { html: page('Board') })
  for (const [revisionId, cookie] of [[revision.id, outsider.cookie], [revision.id, undefined], [foreign.id, bob.cookie], ['0', bob.cookie], ['x', bob.cookie]]) {
    assert.equal((await sourceOf({ room: { id } }, revisionId, cookie ?? null)).status, 404, `${revisionId} with ${cookie}`)
  }

  // One browser keeps one identity across rooms, and the sidebar lists only its rooms, newest first.
  const second = await create('Alice', alice.cookie)
  assert.equal(second.response.headers.get('set-cookie'), `${alice.cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800; Secure`)
  await f.store.setStatus(second.room.id, 'working')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(cookieOf(await post({ action: 'join', id: outsider.room.id, invite: outsider.invite, name: 'Alice' }, alice.cookie)), alice.cookie)
  const listed = await (await get('/api/ampersand', alice.cookie)).json()
  assert.deepEqual(listed.rooms.map((room) => room.id).sort(), [id, second.room.id, outsider.room.id].sort())
  assert.equal(listed.rooms[0].id, outsider.room.id)
  assert.deepEqual(Object.keys(listed.rooms[0]).sort(), ['busy', 'id', 'lastActivity', 'title'])
  assert.deepEqual(listed.rooms.filter((room) => room.busy).map((room) => room.id), [second.room.id])
  assert.deepEqual(await (await get('/api/ampersand')).json(), { configured: true, model: 'ampersand-test', rooms: [] })
})

test('a message sent during a run supersedes stale work, retaining all requests while other rooms run concurrently', { timeout: 10_000 }, async (t) => {
  const gate = Promise.withResolvers()
  const f = await fixture(t, {
    // Every room's first Builder turn waits here, so the test can act while both rooms are mid-run.
    Builder: async (turn) => {
      if (turn.number === 1) await gate.promise
      await builder(turn)
    },
    Reviewer: reviewer,
  })
  const alex = await createReviewed('Alex')
  const sam = await createReviewed('Sam')
  // An unrelated room's revision takes the first revision ID, so room revision numbers and IDs differ below.
  await f.store.publishDesign((await createReviewed('Other')).room.id, page('Other'))
  const joined = await post({ action: 'join', id: alex.room.id, invite: alex.invite, name: 'Jo' })
  const jo = { room: alex.room, cookie: cookieOf(joined) }
  await say(alex, 'Build a meetup page.')
  await say(sam, 'Sam private design')
  const [alexRun, samRun] = f.after.splice(0).map((work) => work())
  await started(f.api, 2)
  assert.equal((await roomOf(alex)).status, 'working')
  assert.deepEqual((await (await get('/api/ampersand', alex.cookie)).json()).rooms.map((room) => room.busy), [true])
  const joId = (await say(jo, 'Bring a friend')).messages.at(-1).id
  assert.equal(f.after.shift()(), alexRun, 'late input joins the room\'s running worker')
  gate.resolve()
  await Promise.all([alexRun, samRun])

  assert.deepEqual(f.api.scriptErrors, [])
  assert.equal(f.api.creates().length, 6, 'Alex\'s superseded sessions restart with all pending requests')
  const room = await roomOf(alex)
  assert.deepEqual([room.status, room.error], ['idle', null])
  assert.deepEqual(await designsOf(alex), [page('Build a meetup page. | Bring a friend')])
  assert.deepEqual(room.activity.filter((event) => event.kind === 'publish').map((event) => event.revision), [1], 'superseded work cannot publish a stale revision')
  assert.deepEqual(room.messages.filter((message) => message.role === 'assistant').map((message) => message.text), [done(1)])
  assert.deepEqual(await f.store.pendingMessages(alex.room.id), [])
  // Replacement sessions start from the full pending conversation; the reply is written only after both requests are reviewed.
  const expected = {
    Builder: { deliveredThrough: joId, room: [['Alex', 'Build a meetup page.'], ['Jo', 'Bring a friend']] },
    Reviewer: { deliveredThrough: joId, room: [['Alex', 'Build a meetup page.'], ['Jo', 'Bring a friend']] },
  }
  for (const seat of ['Builder', 'Reviewer']) {
    const { sessionId, deliveredThrough } = (await f.store.agentSessions(alex.room.id))[seat]
    assert.equal(deliveredThrough, expected[seat].deliveredThrough, seat)
    assert.deepEqual(delivered(f.api.sessions.get(sessionId)).filter((item) => item.channel === 'room').map((item) => [item.sender_name, item.text]), expected[seat].room)
  }
  const alexBuilder = f.api.sessions.get((await f.store.agentSessions(alex.room.id)).Builder.sessionId)
  const reads = alexBuilder.turns.flatMap((turn) => turn.calls).filter((call) => call.name === 'read_design')
  assert.deepEqual(reads.map((call) => JSON.parse(alexBuilder.results.find((result) => result.turn_id === call.turn_id && result.call_id === call.call_id).output).revision), [0, 1])
  assert.deepEqual(await designsOf(sam), [page('Sam private design')])
  const samBuilder = f.api.sessions.get((await f.store.agentSessions(sam.room.id)).Builder.sessionId)
  assert.deepEqual(delivered(samBuilder).filter((item) => item.channel === 'room').map((item) => item.text), ['Sam private design'], 'sessions never see another room')
})

test('a failed batch keeps its queue, partial design and a redacted error, and a retry starts its seats over from the transcript', { timeout: 10_000 }, async (t) => {
  const gate = Promise.withResolvers()
  let failing = true
  const f = await fixture(t, {
    Builder: async (turn) => {
      if (failing) {
        await turn.call('publish_design', { html: page('Partial'), base_revision: 0 })
        await gate.promise
        throw new Error('the model stopped')
      }
      await builder(turn)
    },
    Reviewer: reviewer,
  })
  const alex = await createReviewed('Alex')
  const id = alex.room.id
  await say(alex, 'Create the meetup.')
  await say(alex, 'Add the RSVP control')
  const failedRun = f.after.shift()()
  await started(f.api, 1)
  gate.resolve()
  await f.drain()
  await failedRun
  let room = await roomOf(alex)
  assert.deepEqual([room.status, room.error], ['error', 'The Builder\'s Ampersand turn failed (server_error)'])
  assert.deepEqual(await designsOf(alex), [page('Partial')])
  assert.equal((await f.store.pendingMessages(id)).length, 2)

  failing = false
  const retried = await post({ action: 'retry', id }, alex.cookie)
  assert.equal((await retried.json()).room.id, id)
  await f.drain()
  room = await roomOf(alex)
  assert.deepEqual([room.status, room.error], ['idle', null])
  assert.deepEqual(await designsOf(alex), [page('Partial'), page('Partial | Create the meetup. | Add the RSVP control')])
  assert.deepEqual(await f.store.pendingMessages(id), [])
  // The failed session already held the batch, so the retry replaces it with one that gets the whole transcript and the partial design.
  const [failedSession, builderSession] = f.api.bySeat('Builder')
  assert.equal(failedSession.deleted, true)
  assert.deepEqual(builderSession.turns[0].input.filter((item) => item.metadata.channel === 'room').map(text), ['Create the meetup.', 'Add the RSVP control'])
  const read = builderSession.turns[0].calls.find((call) => call.name === 'read_design')
  const retriedDesign = JSON.parse(builderSession.results.find((result) => result.turn_id === read.turn_id && result.call_id === read.call_id).output)
  assert.deepEqual({ html: retriedDesign.html, revision: retriedDesign.revision }, { html: page('Partial'), revision: 1 })
  assert.deepEqual(retriedDesign.pending_requests.map((request) => request.text), ['Create the meetup.', 'Add the RSVP control'])

  // A later failure is stored redacted, then capped, and keeps only its own message open.
  const appendAssistant = f.store.appendAssistant
  f.store.appendAssistant = () => { throw new Error(`disk refused ${f.api.apiKey} with Bearer abc.def ${'x'.repeat(48)} ${'z,'.repeat(MAX_ERROR_LENGTH)}`) }
  const blueId = (await say(alex, 'Make it blue')).messages.at(-1).id
  await f.drain()
  room = await roomOf(alex)
  assert.equal(room.status, 'error')
  assert.ok(room.error.startsWith('disk refused [redacted] with Bearer [redacted] [redacted] z,z,'), room.error)
  assert.equal(room.error.length, MAX_ERROR_LENGTH)
  assert.deepEqual((await f.store.pendingMessages(id)).map((message) => message.id), [blueId])
  f.store.appendAssistant = appendAssistant
  await post({ action: 'retry', id }, alex.cookie)
  await f.drain()
  assert.equal((await roomOf(alex)).status, 'idle')
  assert.equal(f.api.bySeat('Builder').length, 3)
  for (const session of f.api.sessions.values()) {
    const roomIds = delivered(session).filter((item) => item.channel === 'room').map((item) => item.id)
    assert.deepEqual(roomIds, [...new Set(roomIds)], 'no session is sent a room message twice')
  }
})

test('another process sees queues, errors, designs and sessions, and a member\'s read resumes a room whose runner lapsed', { timeout: 15_000 }, async (t) => {
  t.mock.method(console, 'warn', () => {})
  let full = true
  const f = await fixture(t, {
    Builder: async (turn) => {
      if (full && turn.has('room', /^Make it blue$/)) turn.fail('context_length_exceeded')
      await builder(turn)
    },
    Reviewer: reviewer,
  })
  const alex = await createReviewed('Alex')
  const sam = await createReviewed('Sam')
  await say(alex, 'Initial page')
  await f.drain()
  const original = await f.store.agentSessions(alex.room.id)
  await say(alex, 'Make it blue')
  await f.drain()
  assert.equal((await f.store.snapshotInternal(alex.room.id)).error, 'The Builder\'s Ampersand turn failed (context_length_exceeded)')

  // Sam's message was accepted, and its invocation ended mid-run while it held the room's lease.
  await say(sam, 'Build a page')
  f.after.length = 0
  await f.store.setStatus(sam.room.id, 'working')
  assert.equal(await f.store.claimRun(sam.room.id, 'ended-invocation', Date.now(), Date.now() + 60_000, null), true)
  globalThis.__fx0CollabRuntime.stallMs = 0
  await roomOf(sam)
  assert.equal(f.after.length, 0, 'a room under a live lease is left to its runner')
  const alexBefore = await roomOf(alex)
  const sessionsBefore = await f.store.agentSessions(alex.room.id)
  f.restart()
  globalThis.__fx0CollabRuntime.stallMs = 0
  assert.deepEqual(await roomOf(alex), alexBefore, 'a failed room keeps its messages, designs, activity and error')
  assert.deepEqual(await f.store.agentSessions(alex.room.id), sessionsBefore)
  assert.equal((await f.store.pendingMessages(alex.room.id)).length, 1)
  assert.equal((await f.store.pendingMessages(sam.room.id)).length, 1)

  // The ended invocation's lease lapses.
  await f.db.query('UPDATE ampersand_rooms SET runner_until = 0 WHERE id = $1', [sam.room.id])
  assert.equal((await get(`/api/ampersand?room=${sam.room.id}`)).status, 404)
  assert.equal(f.after.length, 0, 'an anonymous read never resumes work, and a failed room waits for a retry')
  delete process.env.AMPERSAND_API_KEY
  await roomOf(sam)
  assert.equal(f.after.length, 0, 'recovery waits for a configured key')
  process.env.AMPERSAND_API_KEY = f.api.apiKey
  await roomOf(sam)
  assert.equal(f.after.length, 1, 'a member\'s read resumes the stalled queue')
  await f.drain()
  assert.deepEqual((await roomOf(sam)).messages.map((message) => message.text), ['Build a page', done(1)])
  assert.equal(f.after.length, 0, 'an empty queue starts no worker')

  full = false
  await post({ action: 'retry', id: alex.room.id }, alex.cookie)
  await f.drain()
  assert.equal((await roomOf(alex)).status, 'idle')
  const sessions = await f.store.agentSessions(alex.room.id)
  assert.notEqual(sessions.Builder.sessionId, original.Builder.sessionId)
  assert.equal(f.api.sessions.get(original.Builder.sessionId).deleted, true, 'the session at its limit is replaced')
  assert.deepEqual(delivered(f.api.sessions.get(sessions.Builder.sessionId)).filter((item) => item.channel === 'room').map((item) => item.text), ['Initial page', done(1), 'Make it blue'])

  // Browser tokens and invites are stored only as hashes.
  const invite = (await (await post({ action: 'invite', id: alex.room.id }, alex.cookie)).json()).invite
  const secrets = [alex, sam].flatMap((owner) => [owner.cookie.slice('fx0-collab='.length), owner.invite]).concat(invite)
  const served = JSON.stringify([await roomOf(alex), await roomOf(sam)])
  const stored = await databaseText(f.db)
  for (const secret of secrets) assert.ok(!served.includes(secret) && !stored.includes(secret), 'a credential leaked')
})

test('browsers see the latest 32 activity entries, agent text is stored trimmed, and the queue holds only its own room\'s messages', async (t) => {
  const f = await fixture(t)
  const alex = await create('Alex')
  for (let index = 0; index < 33; index++) await f.store.recordActivity(alex.room.id, { agent: 'Builder', kind: 'message', text: ` Update ${index}\n` })
  await f.store.appendAssistant(alex.room.id, '\nDone.\n')
  const room = await roomOf(alex)
  assert.deepEqual(room.activity.map((event) => event.text), Array.from({ length: 32 }, (_, index) => `Update ${index + 1}`))
  assert.deepEqual(room.messages.map((message) => message.text), ['Done.'])

  await say(await create('Sam'), 'Elsewhere')
  await say(alex, 'Here')
  assert.deepEqual((await f.store.pendingMessages(alex.room.id)).map((message) => message.text), ['Here'])
})

test('mutations need the configured origin, a JSON object and a configured key, and failures stay private', async (t) => {
  const f = await fixture(t)
  const alice = await create('Alice')
  const id = alice.room.id
  const message = { action: 'message', id, text: 'Build this', requestId: 'first' }
  for (const from of ['https://evil.example', 'http://demo.example', 'https://demo.example:444', 'null', null]) {
    assert.equal((await post(message, alice.cookie, from)).status, 403, `origin ${from}`)
  }
  // A proxy may rewrite the request URL; the browser's Origin header still decides.
  const proxied = await routes.POST(new Request('http://localhost:3025/api/ampersand', { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify({ action: 'create', name: 'Bob', title: 'Proxied' }) }))
  assert.equal(proxied.status, 201)
  // A local `next start` serves the demo over plain HTTP, so production mode must accept it, without a Secure cookie.
  const previousOrigin = process.env.FX0_COLLAB_ORIGIN
  const previousEnvironment = process.env.NODE_ENV
  process.env.FX0_COLLAB_ORIGIN = 'http://127.0.0.1:3025'
  process.env.NODE_ENV = 'production'
  try {
    const local = await routes.POST(new Request('http://127.0.0.1:3025/api/ampersand', { method: 'POST', headers: { origin: 'http://127.0.0.1:3025' }, body: JSON.stringify({ action: 'create', name: 'Local', title: 'Local' }) }))
    assert.equal(local.status, 201)
    assert.doesNotMatch(local.headers.get('set-cookie'), /Secure/)
  } finally {
    process.env.FX0_COLLAB_ORIGIN = previousOrigin
    process.env.NODE_ENV = previousEnvironment
  }
  for (const body of ['{broken', '[]', 'null', '"text"', { action: 'create', name: 'Alice' }, { action: 'shout', id }, { ...message, requestId: '../first' }, { action: 'join', id, invite: alice.invite, name: ' ' }]) {
    assert.equal((await post(body, alice.cookie)).status, 400, JSON.stringify(body))
  }
  for (const content of ['', '  ', 'x'.repeat(MAX_MESSAGE_LENGTH + 1), '\0']) assert.equal((await post({ ...message, text: content }, alice.cookie)).status, 400)
  assert.equal(f.after.length, 0)
  assert.equal((await f.store.snapshotInternal(id)).messages.length, 0, 'a rejected request has no effect')

  // A failed room with a message left, to retry once the key is gone.
  assert.equal((await post({ ...message, requestId: 'before-the-key-goes' }, alice.cookie)).status, 200)
  f.after.length = 0
  await f.store.setStatus(id, 'error', 'The model stopped')
  delete process.env.AMPERSAND_API_KEY
  for (const model of [undefined, '']) {
    if (model === undefined) delete process.env.AMPERSAND_MODEL
    else process.env.AMPERSAND_MODEL = model
    assert.deepEqual(await (await get('/api/ampersand')).json(), { configured: false, model: 'ampersand-v0.1', rooms: [] }, `AMPERSAND_MODEL=${model} means Ampersand's model`)
  }
  for (const action of ['message', 'retry']) {
    const response = await post({ ...message, action }, alice.cookie)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: MISSING_API_KEY_MESSAGE })
  }
  assert.equal(f.after.length, 0)
  assert.equal((await f.store.snapshotInternal(id)).messages.length, 1, 'no paid work is accepted without a key')

  const log = t.mock.method(console, 'error', () => {})
  const store = f.store
  globalThis.__fx0CollabRuntime.store = null
  for (const response of [
    await get('/api/ampersand', alice.cookie),
    await post({ action: 'invite', id }, alice.cookie),
    await artifactRoute.GET(request(`/api/ampersand/artifact?room=${id}&revision=1`, { cookie: alice.cookie })),
  ]) {
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'The room is temporarily unavailable. Please try again.' })
    assert.deepEqual([response.headers.get('cache-control'), response.headers.get('referrer-policy')], ['private, no-store', 'no-referrer'])
  }
  globalThis.__fx0CollabRuntime.store = store
  assert.deepEqual(log.mock.calls.map((call) => call.arguments), Array.from({ length: 3 }, () => ['[fx0] collab request failed', { name: 'TypeError' }]))
})

test('public limits: a pause, hourly and daily caps, rooms per address and members per room', async (t) => {
  // Mid-hour on one UTC day, so no window rolls over until the test moves the clock.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 26, 12, 30) })
  const f = await fixture(t, {}, { ...collabLimits({}), dailyMessages: 5, hourlyMessages: 2, maxMembers: 2, addresses: { trustedProxies: 1, hourlyMessages: 3, hourlyRooms: 3 } })
  const office = '203.0.113.1'
  const home = '203.0.113.2'
  // Rooms per address count successful creates and joins, and an address the client wrote before its own changes nothing.
  const alice = await create('Alice', undefined, office)
  await refused(await post({ action: 'join', id: alice.room.id, invite: 'x'.repeat(43), name: 'Eve' }, undefined, ORIGIN, office), 404, 'Room not found')
  const bob = { room: alice.room, cookie: cookieOf(await post({ action: 'join', id: alice.room.id, invite: alice.invite, name: 'Bob' }, undefined, ORIGIN, office)) }
  await create('Ana', undefined, office)
  await refused(await post({ action: 'create', name: 'Amy', title: 'Fourth' }, undefined, ORIGIN, `198.51.100.9, ${office}`), 429, HOURLY_ROOM_LIMIT_MESSAGE)
  // A full room refuses a newcomer but not a member rejoining.
  await refused(await post({ action: 'join', id: alice.room.id, invite: alice.invite, name: 'Carol' }, undefined, ORIGIN, home), 403, ROOM_FULL_MESSAGE)
  assert.equal((await post({ action: 'join', id: alice.room.id, invite: alice.invite, name: 'Bob' }, bob.cookie, ORIGIN, home)).status, 200)

  // Each browser and each address has its own hourly allowance; a repeat of a stored request and a refused request use none.
  assert.equal((await sayAs(alice, 'One', office, 'alice-1')).status, 200)
  assert.equal((await sayAs(alice, 'Two', office, 'alice-2')).status, 200)
  assert.equal((await sayAs(alice, 'Two', office, 'alice-2')).status, 200)
  await refused(await sayAs(alice, 'Three', home), 429, HOURLY_MESSAGE_LIMIT_MESSAGE)
  assert.equal((await sayAs(bob, ' ', office)).status, 400)
  assert.equal((await sayAs(bob, 'Bob at the office', office, 'bob-1')).status, 200)
  const dana = await create('Dana', undefined, home)
  await refused(await sayAs(dana, 'Dana at the office', office), 429, HOURLY_MESSAGE_LIMIT_MESSAGE)
  assert.equal((await sayAs(dana, 'Dana at home', home, 'dana-1')).status, 200)
  assert.equal((await sayAs(bob, 'Bob at home', home, 'bob-2')).status, 200)
  assert.deepEqual((await roomOf(alice)).messages.map((message) => message.text), ['One', 'Two', 'Bob at the office', 'Bob at home'])

  // The day's five are used: new messages and retries of a failed room are refused, but a repeat of a stored request is not.
  await refused(await sayAs(dana, 'Dana again', home), 429, DAILY_LIMIT_MESSAGE)
  assert.equal((await sayAs(dana, 'Dana at home', home, 'dana-1')).status, 200)
  await f.store.setStatus(dana.room.id, 'error', 'The model stopped')
  await refused(await post({ action: 'retry', id: dana.room.id }, dana.cookie, ORIGIN, home), 429, DAILY_LIMIT_MESSAGE)
  // The day's count is stored: a restart forgets the hourly counts but not it.
  f.restart()
  await refused(await sayAs(dana, 'After a restart', home), 429, DAILY_LIMIT_MESSAGE)

  // Accepted messages nobody ran resume from a member's read once they have waited the stall window, but not while paused.
  // They were counted when accepted, so resuming them takes nothing from the day's limit.
  f.after.length = 0
  globalThis.__fx0CollabRuntime.limits.paused = true
  await refused(await sayAs(dana, 'Paused', home), 503, PAUSED_MESSAGE)
  await refused(await post({ action: 'retry', id: dana.room.id }, dana.cookie, ORIGIN, home), 503, PAUSED_MESSAGE)
  t.mock.timers.setTime(Date.UTC(2026, 9, 26, 12, 31))
  await roomOf(alice)
  assert.equal(f.after.length, 0, 'a pause holds the queue')
  globalThis.__fx0CollabRuntime.limits.paused = false
  const shown = (await roomOf(alice)).version
  assert.equal(f.after.length, 1, 'a member\'s read resumes the waiting queue at the day\'s limit')
  // An open tab polls with the version it shows, and still resumes the queue without a snapshot.
  const poll = async () => (await get(`/api/ampersand?room=${alice.room.id}&since=${shown}`, alice.cookie)).json()
  assert.deepEqual(await poll(), { unchanged: true })
  assert.equal(f.after.length, 2)
  f.after.length = 0
  t.mock.timers.setTime(Date.UTC(2026, 9, 27, 0, 5))
  assert.equal((await sayAs(dana, 'Next day', home, 'dana-2')).status, 200)
})

test('a resend of a stored message never reruns a failed room; only a counted retry of a failed room does', { timeout: 10_000 }, async (t) => {
  let failures = 2
  const f = await fixture(t, {
    Builder: async (turn) => {
      if (failures > 0) {
        failures--
        throw new Error('the model stopped')
      }
      await builder(turn)
    },
    Reviewer: reviewer,
  }, { ...collabLimits({}), dailyMessages: 3 })
  const alex = await createReviewed('Alex')
  const retry = () => post({ action: 'retry', id: alex.room.id }, alex.cookie)
  assert.equal((await sayAs(alex, 'Build it', undefined, 'alex-1')).status, 200)
  await f.drain()
  assert.equal((await roomOf(alex)).status, 'error')
  assert.equal((await sayAs(alex, 'Build it', undefined, 'alex-1')).status, 200)
  assert.equal(f.after.length, 0, 'the resend schedules no run')
  // The message and two retries of the failed room use the day's three.
  assert.equal((await retry()).status, 200)
  await f.drain()
  assert.equal((await roomOf(alex)).status, 'error')
  assert.equal((await retry()).status, 200)
  await f.drain()
  const room = await roomOf(alex)
  assert.deepEqual([room.status, room.messages.at(-1).text], ['idle', done(1)])
  assert.equal(f.api.creates().length, 6, 'the first run and each retry started both seats')
  // A retry of a room that isn't failed changes nothing and costs nothing, even at the day's limit.
  assert.deepEqual((await (await retry()).json()).room, room)
  assert.equal(f.after.length, 0)
  await refused(await sayAs(alex, 'One more', undefined), 429, DAILY_LIMIT_MESSAGE)
})

for (const recovery of ['newer message', 'explicit retry']) {
  test(`delayed message and stalled poll callbacks cannot rerun an ordinary failed batch; recovery via ${recovery} can`, { timeout: 10_000 }, async (t) => {
    const start = Date.now()
    t.mock.timers.enable({ apis: ['Date'], now: start })
    let failOnce = true
    const f = await fixture(t, {
      Builder: async (turn) => {
        if (failOnce) {
          failOnce = false
          throw new Error('ordinary first-batch failure')
        }
        await builder(turn)
      },
      Reviewer: reviewer,
    }, { ...collabLimits({}), dailyMessages: 3, hourlyMessages: 3 })
    const alex = await createReviewed('Alex')
    await say(alex, 'Keep the first request')
    const second = (await say(alex, 'Keep the second request')).messages.at(-1)
    // Both message callbacks and a stalled poll are admitted before any runner
    // starts. Only the first callback runs now; the others arrive after failure.
    t.mock.timers.setTime(start + 1)
    globalThis.__fx0CollabRuntime.stallMs = 0
    await roomOf(alex)
    assert.equal(f.after.length, 3)
    const [runFirst, delayedMessage, delayedPoll] = f.after.splice(0)
    await runFirst()
    const failed = await roomOf(alex)
    assert.equal(failed.status, 'error')
    assert.equal(f.api.creates().length, 2)
    const durable = async () => (await f.db.query('SELECT failed_through, processed_through, runner FROM ampersand_rooms WHERE id = $1', [alex.room.id])).rows[0]
    assert.deepEqual(await durable(), { failed_through: second.id, processed_through: 0, runner: null })
    const quota = async () => ({
      daily: (await f.db.query('SELECT SUM(units)::int AS n FROM ampersand_usage')).rows[0].n,
      hourly: (await f.db.query('SELECT SUM(count)::int AS n FROM ampersand_hourly')).rows[0].n,
    })
    assert.deepEqual(await quota(), { daily: 2, hourly: 2 })
    f.restart()
    const claimRun = f.store.claimRun
    const claims = []
    t.mock.method(f.store, 'claimRun', async (...args) => {
      const claimed = await claimRun(...args)
      claims.push(claimed)
      return claimed
    })
    for (const delayed of [delayedMessage, delayedPoll]) {
      await delayed()
      assert.deepEqual(await roomOf(alex), failed, 'delayed callbacks cannot clear the stored error or mutate the failed batch')
      assert.equal(f.api.creates().length, 2, 'no replacement sessions are admitted')
      assert.deepEqual(await quota(), { daily: 2, hourly: 2 }, 'delayed callbacks consume no quota')
      assert.deepEqual((await f.store.pendingMessages(alex.room.id)).map((item) => item.id), failed.messages.map((item) => item.id))
      assert.deepEqual(await durable(), { failed_through: second.id, processed_through: 0, runner: null })
    }
    assert.deepEqual(claims, [false, false], 'each delayed callback reaches durable admission and is refused after restart')
    assert.equal(f.after.length, 0, 'polling the failed room schedules no further work')
    if (recovery === 'newer message') {
      await say(alex, 'A newer request may restart work')
    } else {
      assert.equal((await post({ action: 'retry', id: alex.room.id }, alex.cookie)).status, 200)
    }
    assert.equal(f.after.length, 1)
    assert.deepEqual(await quota(), { daily: 3, hourly: 3 }, 'only the admitted new message or explicit retry spends the third unit')
    await f.drain()
    assert.deepEqual(claims, [false, false, true])
    assert.equal(f.api.creates().length, 4, 'one fresh two-seat batch settles all pending requests')
    const settled = await roomOf(alex)
    assert.deepEqual([settled.status, settled.error], ['idle', null])
    assert.match((await f.store.latestDesign(alex.room.id)).html, /Keep the first request \| Keep the second request/)
    if (recovery === 'newer message') assert.match((await f.store.latestDesign(alex.room.id)).html, /A newer request may restart work/)
    assert.deepEqual(await f.store.pendingMessages(alex.room.id), [])
    assert.deepEqual(await quota(), { daily: 3, hourly: 3 })
    assert.equal(f.api.scriptErrors.length, 1)
  })
}

test('concurrent duplicate POSTs at daily and hourly quota one admit one message and schedule one paid run', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { Builder: builder, Reviewer: reviewer }, { ...collabLimits({}), dailyMessages: 1, hourlyMessages: 1 })
  const alex = await createReviewed('Alex')
  const responses = await Promise.all(Array.from({ length: 6 }, () => sayAs(alex, 'Build it once', undefined, 'same-post')))
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200, 200], 'duplicates succeed even after the one available unit is reserved')
  const rooms = await Promise.all(responses.map(async (response) => (await response.json()).room))
  assert.deepEqual(rooms.map((room) => room.messages.map((message) => message.id)), Array.from({ length: 6 }, () => [rooms[0].messages[0].id]))
  const quota = async () => ({
    daily: (await f.db.query('SELECT SUM(units)::int AS n FROM ampersand_usage')).rows[0].n,
    hourly: (await f.db.query('SELECT SUM(count)::int AS n FROM ampersand_hourly')).rows[0].n,
  })
  assert.deepEqual(await quota(), { daily: 1, hourly: 1 })
  assert.equal(f.after.length, 1, 'only the winning insert schedules a worker')
  assert.equal(f.api.creates().length, 0, 'paid work is deferred until after the response')
  await refused(await sayAs(alex, 'Changed body', undefined, 'same-post'), 409, 'Message request ID already used')
  await refused(await sayAs(alex, 'A different request', undefined, 'another-post'), 429, DAILY_LIMIT_MESSAGE)
  assert.deepEqual(await quota(), { daily: 1, hourly: 1 }, 'refused requests consume neither counter')
  await f.drain()
  assert.equal(f.api.creates().length, 2)
  assert.equal((await roomOf(alex)).status, 'idle')
  assert.equal((await sayAs(alex, 'Build it once', undefined, 'same-post')).status, 200)
  assert.equal(f.after.length, 0, 'a later resend schedules no second run')
  assert.deepEqual(await quota(), { daily: 1, hourly: 1 })
})

test('concurrent retry POSTs clear a durable cleanup barrier once at daily and hourly quota one', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { Builder: builder, Reviewer: reviewer }, { ...collabLimits({}), dailyMessages: 1, hourlyMessages: 1 })
  const alex = await createReviewed('Alex')
  const token = alex.cookie.slice('fx0-collab='.length)
  // Seed a previously admitted, failed batch without using this test's retry allowance.
  await f.store.appendMessage(alex.room.id, token, { text: 'Finish the pending page', requestId: 'before-restart', dailyLimit: null })
  await f.store.setStatus(alex.room.id, 'error', 'Cleanup uncertain', undefined, true)
  f.restart()
  const barrier = async () => (await f.db.query('SELECT cleanup_blocked FROM ampersand_rooms WHERE id = $1', [alex.room.id])).rows[0].cleanup_blocked
  globalThis.__fx0CollabRuntime.stallMs = 0
  assert.equal((await roomOf(alex)).status, 'error')
  assert.equal(await barrier(), true)
  assert.equal(f.after.length, 0, 'a member poll cannot restart cleanup-blocked work')
  const responses = await Promise.all(Array.from({ length: 6 }, () => post({ action: 'retry', id: alex.room.id }, alex.cookie)))
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200, 200])
  assert.equal(await barrier(), false, 'the explicit retry releases the persisted barrier')
  assert.equal(f.after.length, 1, 'only the winning retry starts work')
  assert.equal((await f.db.query('SELECT SUM(units)::int AS n FROM ampersand_usage')).rows[0].n, 1)
  assert.equal((await f.db.query('SELECT SUM(count)::int AS n FROM ampersand_hourly')).rows[0].n, 1)
  await f.drain()
  assert.equal(f.api.creates().length, 2)
  assert.deepEqual(await f.store.pendingMessages(alex.room.id), [])
  assert.deepEqual([(await roomOf(alex)).status, (await roomOf(alex)).messages.at(-1).text], ['idle', done(1)])
})

test('rooms past the running cap wait without sessions until a read resumes them, and a failed batch frees its slot', { timeout: 15_000 }, async (t) => {
  const gate = Promise.withResolvers()
  const order = []
  const f = await fixture(t, {
    Builder: async (turn) => {
      const request = turn.messages('room').map(text).at(-1)
      if (request) order.push(request)
      if (request === 'A1') await gate.promise
      if (request === 'F1') throw new Error('the model stopped')
      await builder(turn)
    },
    Reviewer: reviewer,
  }, { ...collabLimits({}), maxRunningRooms: 1 })
  const runners = async () => (await f.db.query('SELECT COUNT(*)::int AS count FROM ampersand_rooms WHERE runner IS NOT NULL')).rows[0].count
  const alex = await createReviewed('Alex')
  const sam = await createReviewed('Sam')
  await say(alex, 'A1')
  await say(sam, 'S1')
  const [alexRun, samRun] = f.after.splice(0).map((work) => work())
  await started(f.api, 1)
  await samRun
  // Only Alex's batch runs; Sam's waits without a runner or sessions.
  assert.equal(f.api.creates().length, 2)
  assert.deepEqual([(await roomOf(alex)).status, (await roomOf(sam)).status], ['working', 'idle'])
  await say(alex, 'A2')
  assert.equal(f.after.shift()(), alexRun, 'Alex\'s second message joins its running worker')
  globalThis.__fx0CollabRuntime.stallMs = 0
  await roomOf(sam)
  await Promise.all(f.after.splice(0).map((work) => work()))
  assert.equal(f.api.creates().length, 2, 'a read cannot start Sam while Alex holds the only slot')
  gate.resolve()
  await alexRun
  await roomOf(sam)
  await f.drain()
  assert.equal(order.at(-1), 'S1', 'Sam\'s batch starts once Alex\'s run releases the slot')
  assert.deepEqual([(await roomOf(alex)).messages.at(-1).text, (await roomOf(sam)).messages.at(-1).text], [done(1), done(1)])

  const fay = await createReviewed('Fay')
  const gus = await createReviewed('Gus')
  await say(fay, 'F1')
  await say(gus, 'G1')
  await Promise.all(f.after.splice(0).map((work) => work()))
  await roomOf(gus)
  await f.drain()
  assert.deepEqual([(await roomOf(fay)).status, (await roomOf(gus)).status], ['error', 'idle'])
  assert.equal(await runners(), 0, 'every lease is released')
})

test('the hourly sweep fences returning members before deleting expired sessions, and keeps rooms whose deletes fail', { timeout: 15_000 }, async (t) => {
  t.mock.method(console, 'warn', () => {})
  const start = Date.UTC(2026, 9, 1, 12, 0)
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const f = await fixture(t, { Builder: builder, Reviewer: reviewer }, { ...collabLimits({}), roomTtlDays: 7 })
  const [alex, sam, old] = [await createReviewed('Alex'), await createReviewed('Sam'), await createReviewed('Old')]
  for (const owner of [alex, sam, old]) await say(owner, `${owner.room.title} page`)
  await f.drain()
  const sessionsOf = async (owner) => Object.values(await f.store.agentSessions(owner.room.id)).map((session) => session.sessionId)
  const [alexSessions, samSessions, oldSessions] = await Promise.all([alex, sam, old].map(sessionsOf))
  assert.deepEqual([alexSessions, samSessions, oldSessions].map((sessions) => sessions.length), [2, 2, 2])
  const deletes = () => f.api.requests.filter((request) => request.method === 'DELETE').length
  const sweep = async () => {
    await get('/api/ampersand')
    await f.drain()
  }

  // Eight days later. A recently used room is kept, but returning after cleanup
  // claims an expired room must not resurrect its sessions or admit paid work.
  t.mock.timers.setTime(start + 8 * DAY)
  const active = await createReviewed('Active')
  await say(active, 'Still here')
  await f.drain()
  const createsBefore = f.api.creates().length
  const alexBefore = await roomOf(alex)
  let checkedCleanup = false
  f.api.intercept((request) => request.method === 'DELETE' && samSessions.some((id) => request.path.endsWith(id)), () => Response.json({ error: { message: 'busy' } }, { status: 503 }), Infinity)
  f.api.intercept((request) => request.method === 'DELETE' && request.path.endsWith(alexSessions[0]), async (_request, respond) => {
    checkedCleanup = true
    const [owner] = (await f.db.query('SELECT cleanup_owner FROM ampersand_rooms WHERE id = $1', [alex.room.id])).rows
    assert.ok(owner.cleanup_owner, 'cleanup ownership is durable before the first external DELETE')
    await refused(await sayAs(alex, 'Too late', undefined, 'during-cleanup'), 409, 'Room cleanup is in progress. Please try again later.')
    await refused(await post({ action: 'join', id: alex.room.id, invite: alex.invite, name: 'Late member' }), 409, 'Room cleanup is in progress. Please try again later.')
    assert.deepEqual(await roomOf(alex), alexBefore, 'a refused return changes neither messages nor membership')
    assert.equal(f.after.length, 0, 'no paid run is scheduled while cleanup holds the room')
    assert.equal(f.api.creates().length, createsBefore)
    return respond()
  })
  await sweep()
  assert.equal(checkedCleanup, true, 'the return was attempted during the external DELETE')
  for (const owner of [alex, old]) assert.equal((await get(`/api/ampersand?room=${owner.room.id}`, owner.cookie)).status, 404, 'expired rooms are retired, not reopened')
  for (const ids of [alexSessions, oldSessions]) assert.deepEqual(ids.map((id) => f.api.sessions.get(id).deleted), [true, true])
  assert.deepEqual(await sessionsOf(sam), samSessions, 'a room whose session delete failed keeps its session IDs for the next sweep')
  assert.equal((await roomOf(active)).messages.at(-1).text, done(1), 'recent activity remains available')
  assert.equal(f.api.creates().length, createsBefore, 'the sweep never starts replacement sessions')

  // The next sweep waits an hour, without a key it waits for one, and a room whose delete failed waits a day.
  const before = deletes()
  await sweep()
  assert.equal(deletes(), before)
  t.mock.timers.setTime(start + 8 * DAY + 2 * 60 * 60 * 1000)
  delete process.env.AMPERSAND_API_KEY
  await sweep()
  assert.equal(deletes(), before)
  process.env.AMPERSAND_API_KEY = f.api.apiKey
  await sweep()
  assert.equal(deletes(), before)
  t.mock.timers.setTime(start + 9 * DAY + 60 * 60 * 1000)
  // Advancing JS Date does not advance the cleanup lease's database clock.
  await f.db.query('UPDATE ampersand_rooms SET cleanup_until = 0 WHERE id = $1', [sam.room.id])
  await sweep()
  assert.equal(deletes(), before + 2, 'a day later Sam\'s two deletes are tried again')
  assert.deepEqual(await sessionsOf(sam), samSessions)
})

test('a poll that already has the room\'s version gets no snapshot', async (t) => {
  const f = await fixture(t)
  const alex = await create('Alex')
  const room = await roomOf(alex)
  const poll = (since, cookie = alex.cookie) => get(`/api/ampersand?room=${alex.room.id}&since=${since}`, cookie)
  assert.deepEqual(await (await poll(room.version)).json(), { unchanged: true })
  assert.deepEqual((await (await poll(room.version - 1)).json()).room, room)
  assert.equal((await poll(room.version, null)).status, 404, 'a version tells a non-member nothing')
  await f.store.appendAssistant(alex.room.id, 'Hi')
  assert.equal((await (await poll(room.version)).json()).room.version, room.version + 1)
})

test('rooms whose session deletes keep failing wait a day, so the sweep reaches the others', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'warn', () => {})
  const info = t.mock.method(console, 'info', () => {})
  const start = Date.UTC(2026, 9, 1, 12, 0)
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const f = await fixture(t, {}, { ...collabLimits({}), roomTtlDays: 7 })
  // Fifty expired rooms hold sessions the API won't delete; the fifty-first, newer, holds none.
  const failing = []
  for (let index = 0; index < 50; index++) {
    t.mock.timers.setTime(start + index)
    const owner = await create(`Room ${index}`)
    await f.store.saveAgentSession(owner.room.id, 'Builder', { sessionId: `sess_stuck_${index}`, deliveredThrough: 0 })
    failing.push(owner)
  }
  t.mock.timers.setTime(start + 50)
  const last = await create('Last')
  f.api.intercept((request) => request.method === 'DELETE' && /sess_stuck_/.test(request.path), () => Response.json({ error: { message: 'busy' } }, { status: 503 }), Infinity)
  const sweep = async (at) => {
    t.mock.timers.setTime(at)
    await get('/api/ampersand')
    await f.drain()
  }
  await sweep(start + 8 * DAY)
  assert.equal((await roomOf(last)).id, last.room.id, 'the first sweep takes the fifty oldest')
  // Model the elapsed cleanup leases in DB time too; the daily backoff must
  // still skip these rooms even though another cleaner could now take them.
  await f.db.query('UPDATE ampersand_rooms SET cleanup_until = 0 WHERE cleanup_owner IS NOT NULL')
  await sweep(start + 8 * DAY + 2 * 60 * 60 * 1000)
  assert.equal((await get(`/api/ampersand?room=${last.room.id}`, last.cookie)).status, 404, 'the next sweep passes over the failing rooms')
  for (const owner of failing) assert.equal((await f.store.agentSessions(owner.room.id)).Builder.sessionId.startsWith('sess_stuck_'), true)
  assert.deepEqual(info.mock.calls.map((call) => call.arguments[1]), [{ deleted: 0, kept: 50, waiting: 1 }, { deleted: 1, kept: 0, waiting: 50 }])
})

test('new rooms start with review off; any member can switch it and the choice survives a restart', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, {
    Builder: async (turn) => {
      const design = await turn.read()
      await turn.call('publish_design', { html: page('Solo'), base_revision: design.revision })
      await turn.call('room_reply', { content: 'Done alone.', addressed_message_ids: requestIds(design) })
    },
  })
  const alex = await create('Alex')
  const outsider = await create('Outsider')
  const id = alex.room.id
  assert.equal(alex.room.review, false, 'new rooms start with the Builder alone')
  await refused(await post({ action: 'review', id, enabled: false }, outsider.cookie), 404, 'Room not found')
  await refused(await post({ action: 'review', id, enabled: 'no' }, alex.cookie), 400, 'enabled must be true or false')
  const joined = await post({ action: 'join', id, invite: alex.invite, name: 'Bob' })
  const bobCookie = cookieOf(joined)
  const enabled = (await (await post({ action: 'review', id, enabled: true }, alex.cookie)).json()).room
  assert.equal(enabled.review, true)
  f.restart()
  assert.equal((await roomOf(alex)).review, true, 'an explicit on preference survives a restart')
  const before = await roomOf(alex)
  const switched = (await (await post({ action: 'review', id, enabled: false }, bobCookie)).json()).room
  assert.equal(switched.review, false)
  assert.equal(switched.version, before.version + 1, 'open tabs see the switch')
  f.restart()
  assert.equal((await roomOf(alex)).review, false, 'an explicit off preference survives a restart')

  await say(alex, 'Make a page.')
  await f.drain()
  const room = await roomOf(alex)
  assert.equal(room.status, 'idle')
  assert.deepEqual(room.messages.map((message) => message.text), ['Make a page.', 'Done alone.'])
  assert.deepEqual(f.api.creates().map((request) => request.body.agent.tools.map((tool) => tool.name)), [['read_design', 'publish_design', 'room_reply', 'pass']])
})

test('one runner holds a room at a time, a lapsed lease can be taken over, and the cap counts other live rooms', async (t) => {
  const f = await fixture(t)
  const [a, b] = [await create('A'), await create('B')]
  const now = Date.now()
  assert.equal(await f.store.claimRun(a.room.id, 'one', now, now + 60_000, null), true)
  assert.equal(await f.store.claimRun(a.room.id, 'one', now, now + 60_000, null), true, 'the holder may extend its own lease')
  assert.equal(await f.store.claimRun(a.room.id, 'two', now, now + 60_000, null), false, 'another process waits')
  assert.equal(await f.store.claimRun(b.room.id, 'two', now, now + 60_000, 1), false, 'the cap counts the other live room')
  assert.equal(await f.store.renewRun(a.room.id, 'two', 60_000), false)
  await f.db.query('UPDATE ampersand_rooms SET runner_until = 0 WHERE id = $1', [a.room.id])
  assert.equal(await f.store.renewRun(a.room.id, 'one', 60_000), false, 'an expired lease cannot renew')
  assert.equal(await f.store.claimRun(a.room.id, 'one', now, now + 60_000, null), false, 'an expired runner cannot resurrect its token')
  assert.equal(await f.store.claimRun(a.room.id, 'two', now, now + 60_000, null), true, 'a new token can take the expired lease')
  assert.equal(await f.store.renewRun(a.room.id, 'one', 60_000), false, 'the old runner learns it lost the lease')
  await f.store.releaseRun(a.room.id, 'one')
  assert.equal(await f.store.claimRun(a.room.id, 'three', now, now + 60_000, null), false, 'only the holder releases')
  await f.store.releaseRun(a.room.id, 'two')
  assert.equal(await f.store.claimRun(b.room.id, 'two', now, now + 60_000, 1), true, 'a released lease frees the slot')
  await f.store.releaseRun(b.room.id, 'two')
})
