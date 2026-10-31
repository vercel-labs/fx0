import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import timers from 'node:timers/promises'
import test from 'node:test'
import { createAmpersandClient } from '../lib/collab/ampersand.ts'
import { runDesignGroup } from '../lib/collab/group.ts'
import { collabLimits, DAILY_LIMIT_MESSAGE } from '../lib/collab/limits.ts'
import { createRoomsDatabase, storeOn } from './fixtures/rooms-db.mjs'
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

const publishPendingRequests = async (turn) => {
  if (turn.messages('room').length) {
    const design = await turn.read()
    await turn.call('publish_design', { html: page(`<h1>${design.pending_requests.map((request) => request.text).join(' | ')}</h1>`), base_revision: design.revision })
  }
  if (turn.has('notice', /^Reviewer approved/)) await turn.call('room_reply', { content: 'Handled every pending request.', addressed_message_ids: requestIds(await turn.read()) })
}

async function runtimeFixture(t, scripts, limits = { ...collabLimits({}), dailyMessages: 3 }) {
  const db = await createRoomsDatabase()
  const store = storeOn(db)
  const aliceToken = 'a'.repeat(43)
  const bobToken = 'b'.repeat(43)
  const { room, invite } = await store.createRoom({ name: 'Alice', title: 'Meetup', token: aliceToken })
  await store.setReview(room.id, aliceToken, true)
  await store.joinRoom({ id: room.id, invite, name: 'Bob', token: bobToken, maxMembers: 8 })
  const append = async (token, text, requestId) => (await store.appendMessage(room.id, token, { text, requestId, dailyLimit: limits.dailyMessages, admit() {} })).room.messages.at(-1)
  const api = createAgentsApi({ scripts })
  const client = createAmpersandClient({ baseUrl: 'https://ampersand.test/v1', apiKey: api.apiKey, fetch: api.fetch })
  const priorRuntime = globalThis.__fx0CollabRuntime
  const priorKey = process.env.AMPERSAND_API_KEY
  const priorModel = process.env.AMPERSAND_MODEL
  const runtime = { ...createCollabRuntime(store, limits), client }
  globalThis.__fx0CollabRuntime = runtime
  process.env.AMPERSAND_API_KEY = api.apiKey
  process.env.AMPERSAND_MODEL = 'ampersand-test'
  t.after(async () => {
    globalThis.__fx0CollabRuntime = priorRuntime
    if (priorKey === undefined) delete process.env.AMPERSAND_API_KEY
    else process.env.AMPERSAND_API_KEY = priorKey
    if (priorModel === undefined) delete process.env.AMPERSAND_MODEL
    else process.env.AMPERSAND_MODEL = priorModel
    await store.close()
    await db.close()
  })
  return { db, store, room, api, runtime, append, aliceToken, bobToken }
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
  const { store, room, api, append, aliceToken, bobToken } = await runtimeFixture(t, {
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
  const accepted = await append(aliceToken, 'Add a visible RSVP button.', 'alice-rsvp')
  const worker = runRoom(room.id)
  await firstPublish.promise
  const later = await append(bobToken, 'Make the heading say Tuesday meetup.', 'bob-heading')
  assert.deepEqual((await store.pendingMessages(room.id)).map((item) => item.id), [accepted.id, later.id])
  if (notifyWorker) assert.equal(runRoom(room.id), worker, 'another sender reuses the existing room worker')
  finishFirstPublish.resolve()
  await worker
  assert.deepEqual(api.scriptErrors, [])
  assert.deepEqual(batches, [[`message-${accepted.id}`], [`message-${accepted.id}`, `message-${later.id}`]])
  assert.deepEqual(await store.pendingMessages(room.id), [])
  assert.deepEqual([(await store.snapshotInternal(room.id)).status, (await store.snapshotInternal(room.id)).error], ['idle', null])
  const design = await store.latestDesign(room.id)
  assert.equal(design.revision, 1, 'stale work was rejected before it could publish')
  assert.match(design.html, /<button>RSVP<\/button>/)
  assert.match(design.html, /<h1>Tuesday meetup<\/h1>/)
  assert.equal(api.bySeat('Builder')[0].cancels, 1, 'the superseded provider turn is cancelled once')
  const newest = await append(bobToken, 'Make the heading blue.', 'bob-blue')
  assert.deepEqual((await store.pendingMessages(room.id)).map((item) => item.id), [newest.id], 'only the exact settled batch moved the durable cursor')
  await assert.rejects(() => append(bobToken, 'One more.', 'bob-fourth'), { message: DAILY_LIMIT_MESSAGE }, 'catch-up did not charge another daily unit: three accepted messages use three units')
})
}

for (const cleanupFails of [false, true]) {
  test(`new input accepted during error handoff ${cleanupFails ? 'waits when cleanup is uncertain' : 'starts a fresh batch after ordinary failure'}`, { timeout: 10_000 }, async (t) => {
    let firstAttempt = true
    const { db, store, room, api, runtime, append, aliceToken, bobToken } = await runtimeFixture(t, {
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
    }, { ...collabLimits({}), dailyMessages: 4 })
    if (cleanupFails) {
      t.mock.method(console, 'warn', () => {})
      api.intercept((request) => request.body?.events?.[0]?.type === 'agent.session.input.cancel', () => Response.json({ error: { message: 'unavailable' } }, { status: 503 }))
    }
    const first = await append(aliceToken, 'Keep the RSVP button.', 'alice-first')
    const terminalMethod = cleanupFails ? 'blockRunCleanup' : 'setStatus'
    const terminalWrite = store[terminalMethod]
    let second
    let worker
    t.mock.method(store, terminalMethod, async (...args) => {
      const result = await terminalWrite(...args)
      if ((cleanupFails || args[1] === 'error') && !second) {
        assert.equal(args[cleanupFails ? 3 : 5], first.id, 'the failure watermark belongs to the attempted batch')
        if (cleanupFails) assert.equal(result, true, 'cleanup blocking is persisted before the handoff')
        second = await append(bobToken, 'Add a Tuesday heading.', 'bob-late')
        assert.equal(runRoom(args[0]), worker, 'the deferred callback still sees the old worker during error storage')
      }
      return result
    })
    worker = runRoom(room.id)
    await worker
    assert.ok(second, 'the second message arrived during the terminal error handoff')
    assert.equal(runtime.running.size, 0)
    const result = await store.snapshotInternal(room.id)
    if (cleanupFails) {
      assert.equal(result.status, 'error')
      assert.match(result.error, /Could not stop a previous Ampersand run/)
      assert.deepEqual((await store.pendingMessages(room.id)).map((item) => item.id), [first.id, second.id])
      assert.equal(api.creates().length, 2, 'uncertain cleanup cannot trigger automatic replacement')
      assert.equal((await store.latestDesign(room.id)).revision, 0)
      const third = await append(aliceToken, 'Also keep the footer.', 'alice-after-cleanup')
      const blocked = async () => (await db.query('SELECT cleanup_blocked FROM ampersand_rooms WHERE id = $1', [room.id])).rows[0].cleanup_blocked
      assert.equal(await blocked(), true, 'normal message admission preserves the cleanup barrier')
      await runRoom(room.id)
      assert.equal(api.creates().length, 2, 'a later message cannot automatically replace uncertain sessions')

      const restartedStore = storeOn(db)
      const restarted = { ...createCollabRuntime(restartedStore, runtime.limits), client: runtime.client }
      globalThis.__fx0CollabRuntime = restarted
      assert.equal((await restartedStore.poll(room.id, aliceToken, Date.now() + 60_000, 0)).stalled, false, 'a restarted process cannot resume the blocked room from a poll')
      await runRoom(room.id)
      assert.equal(await blocked(), true)
      assert.equal(api.creates().length, 2, 'the cleanup barrier survives a runtime restart')
      assert.deepEqual((await restartedStore.pendingMessages(room.id)).map((item) => item.id), [first.id, second.id, third.id])

      assert.equal((await restartedStore.retryRoom(room.id, aliceToken, runtime.limits.dailyMessages)).started, true)
      assert.equal(await blocked(), false, 'only an explicit counted retry clears the barrier')
      await runRoom(room.id)
      assert.equal(restarted.running.size, 0)
      assert.equal((await restartedStore.snapshotInternal(room.id)).status, 'idle')
      assert.deepEqual(await restartedStore.pendingMessages(room.id), [])
      assert.equal(api.creates().length, 4, 'the retry replaces both saved sessions exactly once')
      assert.match((await restartedStore.latestDesign(room.id)).html, /Keep the RSVP button\. \| Add a Tuesday heading\. \| Also keep the footer\./)
      await assert.rejects(() => append(aliceToken, 'Over quota', 'alice-over-quota'), { message: DAILY_LIMIT_MESSAGE }, 'three messages and one retry use four daily units')
    } else {
      assert.deepEqual([result.status, result.error], ['idle', null])
      assert.deepEqual(await store.pendingMessages(room.id), [])
      assert.equal(api.creates().length, 4, 'the newer accepted message starts a fresh two-seat batch')
      assert.match((await store.latestDesign(room.id)).html, /Keep the RSVP button\. \| Add a Tuesday heading\./)
    }
    assert.equal(api.scriptErrors.length, 1, 'only the deliberately failed first model turn failed')
  })
}

test('an admitted session whose created event outlasts cleanup blocks automatic catch-up', { timeout: 12_000 }, async (t) => {
  const admitted = Promise.withResolvers()
  const { store, room, api, runtime, append, aliceToken, bobToken } = await runtimeFixture(t, {
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
  const first = await append(aliceToken, 'Keep the RSVP button.', 'alice-first')
  const worker = runRoom(room.id)
  await admitted.promise
  await timers.setTimeout(25)
  const second = await append(bobToken, 'Add a Tuesday heading.', 'bob-second')
  assert.equal(runRoom(room.id), worker)
  await worker
  const result = await store.snapshotInternal(room.id)
  assert.equal(result.status, 'error')
  assert.match(result.error, /Could not confirm an Ampersand session creation/)
  assert.deepEqual((await store.pendingMessages(room.id)).map((item) => item.id), [first.id, second.id])
  assert.equal(api.creates().length, 2, 'an unconfirmed admitted create cannot launch replacement sessions')
  assert.equal(runtime.running.size, 0)
  assert.equal((await store.latestDesign(room.id)).revision, 0)
  assert.equal(api.bySeat('Builder')[0].cancels, 1, 'known busy sessions are still stopped')
  assert.equal((await store.agentSessions(room.id)).Reviewer, undefined, 'the unknown session ID was not invented')
  assert.deepEqual(api.scriptErrors, [])
})

test('renewal transport failure persists uncertain session cleanup before releasing the locally lost lease', { timeout: 12_000 }, async (t) => {
  const admitted = Promise.withResolvers()
  const knownSession = Promise.withResolvers()
  const { db, store, room, api, runtime, append, aliceToken, bobToken } = await runtimeFixture(t, {
    Builder: () => new Promise(() => {}),
    Reviewer: () => new Promise(() => {}),
  })
  const interval = { unref() {} }
  const setInterval = globalThis.setInterval
  const clearInterval = globalThis.clearInterval
  let renew
  t.mock.method(globalThis, 'setInterval', (callback, delay, ...rest) => {
    if (delay !== 20_000) return setInterval(callback, delay, ...rest)
    renew = callback
    return interval
  })
  const cleared = t.mock.method(globalThis, 'clearInterval', (handle) => {
    if (handle !== interval) return clearInterval(handle)
  })
  const renewal = t.mock.method(store, 'renewRun', async () => { throw new Error('renewal transport unavailable') })
  const saveAgentSession = store.saveAgentSession
  t.mock.method(store, 'saveAgentSession', async (id, seat, ...rest) => {
    await saveAgentSession(id, seat, ...rest)
    if (seat === 'Builder') knownSession.resolve()
  })
  api.intercept((request) => request.path === '/v1/agents/sessions' && request.body.agent.tools.some((tool) => tool.name === 'finish_review'), async (_request, respond) => {
    const response = await respond()
    admitted.resolve()
    // Admit at the provider, but keep its ID unknown beyond bounded cleanup.
    return new Response(response.body.pipeThrough(new TransformStream({ start: () => timers.setTimeout(4_000) })), response)
  })
  const first = await append(aliceToken, 'Keep the RSVP button.', 'before-renewal-loss')
  const terminal = async () => (await db.query('SELECT status, cleanup_blocked, failed_through, runner, processed_through FROM ampersand_rooms WHERE id = $1', [room.id])).rows[0]
  const releaseRun = store.releaseRun
  let beforeRelease
  t.mock.method(store, 'releaseRun', async (...args) => {
    beforeRelease = await terminal()
    return releaseRun(...args)
  })
  const worker = runRoom(room.id)
  await Promise.all([admitted.promise, knownSession.promise])
  assert.equal(api.creates().length, 2)
  const active = runtime.currentRuns.get(room.id)
  assert.ok(active)
  assert.equal(typeof renew, 'function')
  renew()
  await worker
  assert.equal(renewal.mock.callCount(), 1, 'the renewal transport failed without waiting twenty seconds')
  assert.equal(active.controller.signal.aborted, true)
  assert.equal(active.controller.signal.reason.name, 'LeaseLostError', 'the local worker considers its lease lost')
  assert.ok(beforeRelease, 'the release path was exercised')
  assert.deepEqual([beforeRelease.status, beforeRelease.cleanup_blocked, beforeRelease.failed_through, beforeRelease.processed_through], ['error', true, first.id, 0], 'uncertain cleanup is durable before releasing ownership, despite the local lease loss')
  assert.equal(beforeRelease.runner, renewal.mock.calls[0].arguments[1])
  assert.equal((await terminal()).runner, null)
  assert.match((await store.snapshotInternal(room.id)).error, /Could not confirm an Ampersand session creation/)
  assert.equal((await store.agentSessions(room.id)).Reviewer, undefined, 'an unreported ID is not invented')
  assert.equal(api.bySeat('Builder')[0].cancels, 1)
  assert.equal(runtime.running.size, 0)
  assert.equal(cleared.mock.calls.some((call) => call.arguments[0] === interval), true)
  const later = await append(bobToken, 'Add a Tuesday heading.', 'after-renewal-loss')
  const restartedStore = storeOn(db)
  globalThis.__fx0CollabRuntime = { ...createCollabRuntime(restartedStore, runtime.limits), client: runtime.client }
  await runRoom(room.id)
  assert.equal((await restartedStore.poll(room.id, aliceToken, Date.now() + 60_000, 0)).stalled, false)
  assert.equal(api.creates().length, 2, 'a normal later message and a restart cannot launch replacements while cleanup is uncertain')
  assert.equal((await terminal()).cleanup_blocked, true)
  assert.deepEqual((await restartedStore.pendingMessages(room.id)).map((item) => item.id), [first.id, later.id])
  assert.deepEqual(await restartedStore.latestDesign(room.id), { html: '', revision: 0 })
  assert.deepEqual(api.scriptErrors, [])
})

for (const readFailsAfterCommit of [false, true]) {
test(`a successful batch stays idle after its atomic commit (${readFailsAfterCommit ? 'next queue read fails' : 'no redundant idle write'})`, { timeout: 10_000 }, async (t) => {
  const { db, store, room, api, runtime, append, aliceToken } = await runtimeFixture(t, { Builder: publishPendingRequests, Reviewer: reviewLatestPublish })
  const first = await append(aliceToken, 'Build the complete page.', 'atomic-success')
  const setStatus = store.setStatus
  const statuses = t.mock.method(store, 'setStatus', async (id, status, ...rest) => {
    if (status === 'idle') throw new Error('a redundant final idle write must never run')
    return setStatus(id, status, ...rest)
  })
  const markProcessed = store.markProcessed
  let committed
  let rejectedRead = false
  const pendingMessages = store.pendingMessages
  t.mock.method(store, 'pendingMessages', async (...args) => {
    if (readFailsAfterCommit && committed && !rejectedRead) {
      rejectedRead = true
      throw new Error('a transient queue read failed after the successful commit')
    }
    return pendingMessages(...args)
  })
  const commits = t.mock.method(store, 'markProcessed', async (...args) => {
    await markProcessed(...args)
    committed = (await db.query('SELECT processed_through, status, error, runner FROM ampersand_rooms WHERE id = $1', [room.id])).rows[0]
    assert.equal(committed.runner, args[2].runner, 'the terminal state commits while this runner still owns the lease')
    assert.deepEqual([committed.processed_through, committed.status, committed.error], [first.id, 'idle', null], 'cursor and visible success state commit together')
  })
  await runRoom(room.id)
  assert.ok(committed)
  assert.equal(commits.mock.callCount(), 1)
  assert.deepEqual(statuses.mock.calls.map((call) => call.arguments[1]), readFailsAfterCommit ? ['working', 'error'] : ['working'])
  assert.equal(rejectedRead, readFailsAfterCommit)
  const retry = await store.retryRoom(room.id, aliceToken, 1)
  assert.equal(retry.started, false, 'settled work needs no retry')
  assert.deepEqual(await store.pendingMessages(room.id), [])
  const result = await store.snapshotInternal(room.id)
  assert.deepEqual([result.status, result.error], ['idle', null])
  assert.match((await store.latestDesign(room.id)).html, /Build the complete page\./)
  assert.equal(result.messages.filter((item) => item.role === 'assistant').length, 1)
  assert.equal(runtime.running.size, 0)
  assert.equal(api.creates().length, 2)
  assert.deepEqual(api.scriptErrors, [])
})

}

test('an old runtime runner cannot publish after another runner replaces its lease', { timeout: 10_000 }, async (t) => {
  const { db, store, room, api, runtime, append, aliceToken } = await runtimeFixture(t, { Builder: publishPendingRequests, Reviewer: reviewLatestPublish })
  const first = await append(aliceToken, 'Keep this request pending.', 'before-takeover')
  const replacement = storeOn(db)
  const publishDesign = store.publishDesign
  let rejected = false
  t.mock.method(store, 'publishDesign', async (id, html, ...rest) => {
    assert.ok(rest[0]?.runner, 'the runtime forwards its runner token to the write')
    assert.equal(rest[0].throughId, first.id)
    await store.assertRun(id, rest[0])
    await db.query('UPDATE ampersand_rooms SET runner_until = 0 WHERE id = $1', [id])
    const now = Date.now()
    assert.equal(await replacement.claimRun(id, 'replacement-runner', now, now + 60_000, null), true)
    await replacement.setStatus(id, 'working', null, { runner: 'replacement-runner' })
    await replacement.saveAgentSession(id, 'Builder', { sessionId: 'replacement-session', deliveredThrough: first.id }, { runner: 'replacement-runner' })
    try {
      return await publishDesign(id, html, ...rest)
    } catch (error) {
      assert.equal(error.name, 'LeaseLostError')
      rejected = true
      throw error
    }
  })
  await runRoom(room.id)
  assert.equal(rejected, true, 'the stale write reaches the DB fence and is refused')
  assert.deepEqual(await store.latestDesign(room.id), { html: '', revision: 0 })
  assert.deepEqual((await store.pendingMessages(room.id)).map((item) => item.id), [first.id])
  const result = await store.snapshotInternal(room.id)
  assert.deepEqual([result.status, result.error], ['working', null], 'the old worker cannot overwrite the replacement status with an error')
  assert.deepEqual(result.messages.filter((item) => item.role === 'assistant'), [])
  assert.deepEqual(result.activity.filter((item) => item.kind === 'publish'), [])
  assert.equal((await store.agentSessions(room.id)).Builder.sessionId, 'replacement-session')
  await replacement.assertRun(room.id, { runner: 'replacement-runner' })
  assert.equal(runtime.running.size, 0)
  assert.equal(api.creates().length, 2, 'the stale worker does not start another batch')
  assert.deepEqual(api.scriptErrors, [])
  await replacement.releaseRun(room.id, 'replacement-runner')
})

for (const effect of ['publishDesign', 'appendAssistant', 'recordActivity', 'markProcessed']) {
  test(`new input between the runtime check and ${effect} is rejected at the write, then both requests settle`, { timeout: 10_000 }, async (t) => {
    const { db, store, room, api, append, aliceToken, bobToken } = await runtimeFixture(t, { Builder: publishPendingRequests, Reviewer: reviewLatestPublish })
    const first = await append(aliceToken, 'Keep the RSVP button.', 'before-write')
    const write = store[effect]
    let later
    let rejected = false
    t.mock.method(store, effect, async (id, value, ...rest) => {
      // For activity, target the visible publish rather than an earlier private note.
      if (later || (effect === 'recordActivity' && value.kind !== 'publish')) return write(id, value, ...rest)
      const guard = rest[0]
      assert.ok(guard?.runner)
      assert.equal(guard.throughId, first.id)
      await store.assertRun(id, guard)
      const before = await store.snapshotInternal(id)
      const cursor = async () => (await db.query('SELECT processed_through FROM ampersand_rooms WHERE id = $1', [id])).rows[0].processed_through
      const processedBefore = await cursor()
      later = await append(bobToken, 'Add a Tuesday heading.', 'between-check-and-write')
      try {
        return await write(id, value, ...rest)
      } catch (error) {
        assert.equal(error.name, 'InputsChangedError')
        rejected = true
        const after = await store.snapshotInternal(id)
        assert.deepEqual(after.revisions, before.revisions, 'a stale effect cannot add a revision')
        assert.deepEqual(after.messages.filter((item) => item.role === 'assistant'), before.messages.filter((item) => item.role === 'assistant'), 'a stale effect cannot add a reply')
        assert.deepEqual(after.activity, before.activity, 'a stale effect cannot add activity')
        assert.equal(await cursor(), processedBefore, 'a stale effect cannot settle the queue')
        throw error
      }
    })
    await runRoom(room.id)
    assert.ok(later, 'the newer input arrived after a successful assertion, immediately before the write')
    assert.equal(rejected, true, 'forwarded guard rejects the first batch inside its write')
    assert.deepEqual(await store.pendingMessages(room.id), [])
    const result = await store.snapshotInternal(room.id)
    assert.deepEqual([result.status, result.error], ['idle', null])
    assert.match((await store.latestDesign(room.id)).html, /Keep the RSVP button\. \| Add a Tuesday heading\./)
    assert.equal((await store.latestDesign(room.id)).revision, effect === 'publishDesign' ? 1 : 2, 'only admitted publishes become revisions')
    assert.equal(result.messages.filter((item) => item.role === 'assistant').length, effect === 'markProcessed' ? 2 : 1, 'only replies admitted before the newer input may persist')
    assert.equal(api.creates().length, 4, 'one replacement batch handles both pending requests')
    assert.deepEqual(api.scriptErrors, [])
  })
}
