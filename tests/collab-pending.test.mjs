import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import timers from 'node:timers/promises'
import test from 'node:test'
import { createAmpersandClient } from '../lib/collab/ampersand.ts'
import { runDesignGroup } from '../lib/collab/group.ts'
import { collabLimits, DAILY_LIMIT_MESSAGE } from '../lib/collab/limits.ts'
import { createRoomStore } from '../lib/collab/store.ts'
import { createAgentsApi, delivered } from './fixtures/agents-api.mjs'

// The runtime uses Next's extensionless source imports; no request scope is needed here.
const root = new URL('../', import.meta.url)
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/') && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { createCollabRuntime, runRoom } = await import('../lib/collab/runtime.ts')

const ALICE = { id: 'alice', name: 'Alice' }
const BOB = { id: 'bob', name: 'Bob' }
const page = (body) => `<!doctype html><html><head><title>Team board</title></head><body>${body}</body></html>`
const message = (id, text, author) => ({ id, text, authorId: author.id, author: author.name, role: 'user', createdAt: 1_790_000_000_000 + id * 1000 })
const requestIds = (design) => design.pending_requests.map((request) => request.id)

const reviewLatestPublish = async (turn) => {
  if (!turn.has('notice', /^Builder published revision \d+\./)) return
  const design = await turn.read()
  await turn.call('finish_review', { revision: design.revision, summary: 'Checked every pending request.', addressed_message_ids: requestIds(design) })
}

function runtimeFixture(t, scripts, limits = { ...collabLimits({}), dailyMessages: 3 }) {
  const store = createRoomStore(':memory:')
  const aliceToken = 'a'.repeat(43)
  const bobToken = 'b'.repeat(43)
  const { room, invite } = store.createRoom({ name: 'Alice', title: 'Meetup', token: aliceToken })
  store.setReview(room.id, aliceToken, true)
  store.joinRoom({ id: room.id, invite, name: 'Bob', token: bobToken, maxMembers: 8 })
  const append = (token, text, requestId) => store.appendMessage(room.id, token, { text, requestId, dailyLimit: limits.dailyMessages, admit() {} }).room.messages.at(-1)
  const api = createAgentsApi({ scripts })
  const client = createAmpersandClient({ baseUrl: 'https://ampersand.test/v1', apiKey: api.apiKey, fetch: api.fetch })
  const priorRuntime = globalThis.__fx0CollabRuntime
  const priorKey = process.env.AMPERSAND_API_KEY
  const priorModel = process.env.AMPERSAND_MODEL
  const runtime = { ...createCollabRuntime(store, limits), client }
  globalThis.__fx0CollabRuntime = runtime
  process.env.AMPERSAND_API_KEY = api.apiKey
  process.env.AMPERSAND_MODEL = 'ampersand-test'
  t.after(() => {
    globalThis.__fx0CollabRuntime = priorRuntime
    if (priorKey === undefined) delete process.env.AMPERSAND_API_KEY
    else process.env.AMPERSAND_API_KEY = priorKey
    if (priorModel === undefined) delete process.env.AMPERSAND_MODEL
    else process.env.AMPERSAND_MODEL = priorModel
    store.close()
  })
  return { store, room, api, runtime, append, aliceToken, bobToken }
}

test('a reviewed page and a room reply cannot settle a two-person batch that omits the earlier request', { timeout: 10_000 }, async () => {
  const first = message(1, 'Add a visible RSVP button.', ALICE)
  const second = message(2, 'Make the heading say Tuesday meetup.', BOB)
  const api = createAgentsApi({ scripts: {
    Builder: async (turn) => {
      if (turn.messages('room').length) {
        const design = await turn.read()
        // This is the problematic model behavior: it sees both messages, then addresses only the last.
        await turn.call('publish_design', { html: page('<h1>Tuesday meetup</h1>'), base_revision: design.revision })
      }
      if (turn.has('notice', /^Reviewer approved/)) await turn.call('room_reply', { content: 'The Tuesday meetup heading is ready.', addressed_message_ids: [second.id] })
    },
    Reviewer: async (turn) => {
      if (!turn.has('notice', /^Builder published/)) return
      const design = await turn.read()
      await turn.call('finish_review', { revision: design.revision, summary: 'Checked the Tuesday heading.', addressed_message_ids: [second.id] })
    },
  } })
  const client = createAmpersandClient({ baseUrl: 'https://ampersand.test/v1', apiKey: api.apiKey, fetch: api.fetch })
  const published = []
  const replies = []
  const run = runDesignGroup({
    client, model: 'ampersand-test', timeoutMs: 2_000,
    room: { title: 'Meetup', review: true, members: [ALICE, BOB], messages: [first, second], pending: [first, second], html: '', revision: 0, sessions: {} },
    hooks: { onSession() {}, onActivity() {}, onPublish: (html) => published.push(html), onText: (text) => replies.push(text) },
  })
  // Checking only input delivery, a revision approval, and a reply allowed this omission before.
  await assert.rejects(run, /request|pending|address|cover|reply|approv/i)
  assert.deepEqual(api.scriptErrors, [])
  for (const seat of ['Builder', 'Reviewer']) {
    assert.deepEqual(delivered(api.bySeat(seat)[0]).filter((item) => item.channel === 'room').map((item) => item.id), ['message-1', 'message-2'])
  }
  assert.deepEqual(replies, [], 'unaccounted-for requests prevent a success reply')
})

for (const notifyWorker of [true, false]) {
test(`a second person writing before a commit retains both requests (${notifyWorker ? 'worker notified' : 'deferred callback pending'})`, { timeout: 10_000 }, async (t) => {
  const firstPublish = Promise.withResolvers()
  const finishFirstPublish = Promise.withResolvers()
  const batches = []
  const { store, room, api, append, aliceToken, bobToken } = runtimeFixture(t, {
    Builder: async (turn) => {
      const requests = turn.messages('room')
      if (requests.length) {
        batches.push(requests.filter((item) => item.metadata.sender !== 'builder').map((item) => item.metadata.id))
        const design = await turn.read()
        if (batches.length === 1) {
          firstPublish.resolve()
          await finishFirstPublish.promise
        }
        const wantsRsvp = design.pending_requests.some((request) => /RSVP/.test(request.text)) || design.html.includes('<button>RSVP</button>')
        const wantsHeading = design.pending_requests.some((request) => /Tuesday/.test(request.text)) || design.html.includes('<h1>Tuesday meetup</h1>')
        await turn.call('publish_design', { html: page(`${wantsHeading ? '<h1>Tuesday meetup</h1>' : ''}${wantsRsvp ? '<button>RSVP</button>' : ''}`), base_revision: design.revision })
      }
      if (turn.has('notice', /^Reviewer approved/)) await turn.call('room_reply', { content: 'Kept the RSVP button and added the Tuesday meetup heading.', addressed_message_ids: requestIds(await turn.read()) })
    },
    Reviewer: reviewLatestPublish,
  })
  const accepted = append(aliceToken, 'Add a visible RSVP button.', 'alice-rsvp')
  const worker = runRoom(room.id)
  await firstPublish.promise
  const later = append(bobToken, 'Make the heading say Tuesday meetup.', 'bob-heading')
  assert.deepEqual(store.pendingMessages(room.id).map((item) => item.id), [accepted.id, later.id])
  if (notifyWorker) assert.equal(runRoom(room.id), worker, 'another sender reuses the existing room worker')
  finishFirstPublish.resolve()
  await worker
  assert.deepEqual(api.scriptErrors, [])
  assert.deepEqual(batches, [[`message-${accepted.id}`], [`message-${accepted.id}`, `message-${later.id}`]])
  assert.deepEqual(store.pendingMessages(room.id), [])
  assert.deepEqual([store.snapshotInternal(room.id).status, store.snapshotInternal(room.id).error], ['idle', null])
  const design = store.latestDesign(room.id)
  assert.equal(design.revision, 1, 'stale work was rejected before it could publish')
  assert.match(design.html, /<button>RSVP<\/button>/)
  assert.match(design.html, /<h1>Tuesday meetup<\/h1>/)
  assert.equal(api.bySeat('Builder')[0].cancels, 1, 'the superseded provider turn is cancelled once')
  const newest = append(bobToken, 'Make the heading blue.', 'bob-blue')
  assert.deepEqual(store.pendingMessages(room.id).map((item) => item.id), [newest.id], 'only the exact settled batch moved the durable cursor')
  assert.throws(() => append(bobToken, 'One more.', 'bob-fourth'), { message: DAILY_LIMIT_MESSAGE }, 'catch-up did not charge another daily unit: three accepted messages use three units')
})
}

for (const cleanupFails of [false, true]) {
  test(`new input accepted during error handoff ${cleanupFails ? 'waits when cleanup is uncertain' : 'starts a fresh batch after ordinary failure'}`, { timeout: 10_000 }, async (t) => {
    let firstAttempt = true
    const { store, room, api, runtime, append, aliceToken, bobToken } = runtimeFixture(t, {
      Builder: async (turn) => {
        if (firstAttempt) {
          if (cleanupFails) return new Promise(() => {})
          firstAttempt = false
          throw new Error('the first model turn failed')
        }
        if (turn.messages('room').length) {
          const design = await turn.read()
          await turn.call('publish_design', { html: page(`<h1>${design.pending_requests.map((request) => request.text).join(' | ')}</h1>`), base_revision: design.revision })
        }
        if (turn.has('notice', /^Reviewer approved/)) await turn.call('room_reply', { content: 'Handled both pending requests.', addressed_message_ids: requestIds(await turn.read()) })
      },
      Reviewer: async (turn) => {
        if (cleanupFails && firstAttempt) {
          firstAttempt = false
          throw new Error('the first model turn failed')
        }
        await reviewLatestPublish(turn)
      },
    })
    if (cleanupFails) {
      t.mock.method(console, 'warn', () => {})
      api.intercept((request) => request.body?.events?.[0]?.type === 'agent.session.input.cancel', () => Response.json({ error: { message: 'unavailable' } }, { status: 503 }))
    }
    const first = append(aliceToken, 'Keep the RSVP button.', 'alice-first')
    const setStatus = store.setStatus
    let second
    let worker
    store.setStatus = (id, status, error) => {
      setStatus(id, status, error)
      if (status === 'error' && !second) {
        second = append(bobToken, 'Add a Tuesday heading.', 'bob-late')
        assert.equal(runRoom(id), worker, 'the deferred callback still sees the old worker during error storage')
      }
    }
    worker = runRoom(room.id)
    await worker
    assert.ok(second, 'the second message arrived during the terminal error handoff')
    assert.equal(runtime.running.size, 0)
    const result = store.snapshotInternal(room.id)
    if (cleanupFails) {
      assert.equal(result.status, 'error')
      assert.match(result.error, /Could not stop a previous Ampersand run/)
      assert.deepEqual(store.pendingMessages(room.id).map((item) => item.id), [first.id, second.id])
      assert.equal(api.creates().length, 2, 'uncertain cleanup cannot trigger automatic replacement')
      assert.equal(store.latestDesign(room.id).revision, 0)
    } else {
      assert.deepEqual([result.status, result.error], ['idle', null])
      assert.deepEqual(store.pendingMessages(room.id), [])
      assert.equal(api.creates().length, 4, 'the newer accepted message starts a fresh two-seat batch')
      assert.match(store.latestDesign(room.id).html, /Keep the RSVP button\. \| Add a Tuesday heading\./)
    }
    assert.equal(api.scriptErrors.length, 1, 'only the deliberately failed first model turn failed')
  })
}

test('an admitted session whose created event outlasts cleanup blocks automatic catch-up', { timeout: 12_000 }, async (t) => {
  const admitted = Promise.withResolvers()
  const { store, room, api, runtime, append, aliceToken, bobToken } = runtimeFixture(t, {
    Builder: () => new Promise(() => {}),
    Reviewer: () => new Promise(() => {}),
  })
  api.intercept((request) => request.path === '/v1/agents/sessions' && request.body.agent.tools.some((tool) => tool.name === 'finish_review'), async (_request, respond) => {
    const response = await respond()
    admitted.resolve()
    // The provider admitted the session, but no created event reaches the client before
    // the three-second bounded cleanup expires. Its unknown ID must block replacement.
    return new Response(response.body.pipeThrough(new TransformStream({ start: () => timers.setTimeout(4_000) })), response)
  })
  const first = append(aliceToken, 'Keep the RSVP button.', 'alice-first')
  const worker = runRoom(room.id)
  await admitted.promise
  await timers.setTimeout(25)
  const second = append(bobToken, 'Add a Tuesday heading.', 'bob-second')
  assert.equal(runRoom(room.id), worker)
  await worker
  const result = store.snapshotInternal(room.id)
  assert.equal(result.status, 'error')
  assert.match(result.error, /Could not confirm an Ampersand session creation/)
  assert.deepEqual(store.pendingMessages(room.id).map((item) => item.id), [first.id, second.id])
  assert.equal(api.creates().length, 2, 'an unconfirmed admitted create cannot launch replacement sessions')
  assert.equal(runtime.running.size, 0)
  assert.equal(store.latestDesign(room.id).revision, 0)
  assert.equal(api.bySeat('Builder')[0].cancels, 1, 'known busy sessions are still stopped')
  assert.equal(store.agentSessions(room.id).Reviewer, undefined, 'the unknown session ID was not invented')
  assert.deepEqual(api.scriptErrors, [])
})
