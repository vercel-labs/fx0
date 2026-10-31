import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createRoomStore, LeaseLostError } from '../lib/collab/store.ts'
import { InputsChangedError } from '../lib/collab/input-batch.ts'
import { DAILY_LIMIT_MESSAGE, HOURLY_MESSAGE_LIMIT_MESSAGE, HOURLY_ROOM_LIMIT_MESSAGE, ROOM_FULL_MESSAGE } from '../lib/collab/limits.ts'
import { createRoomsDatabase, storeOn, databaseText } from './fixtures/rooms-db.mjs'

const token = (letter) => letter.repeat(43)
const uses = [{ key: 'shared-address', limit: 1 }]
const send = (store, id, requestId, extra = {}) => store.appendMessage(id, token('a'), { text: 'Build this', requestId, dailyLimit: 20, ...extra })
async function fixture(t) {
  const db = await createRoomsDatabase()
  t.after(() => db.close())
  const store = storeOn(db)
  const { room, invite } = await store.createRoom({ name: 'Alice', title: 'Board', token: token('a') })
  return { db, store, id: room.id, invite }
}
const counts = async (db) => ({
  daily: (await db.query('SELECT COALESCE(SUM(units), 0)::int AS n FROM ampersand_usage')).rows[0].n,
  hourly: (await db.query('SELECT COALESCE(SUM(count), 0)::int AS n FROM ampersand_hourly')).rows[0].n,
})

test('concurrent duplicate requests reserve daily/hourly once, before checking exhausted quotas', async (t) => {
  const { db, store, id } = await fixture(t)
  const result = await Promise.all(Array.from({ length: 6 }, () => send(store, id, 'same', { dailyLimit: 1, hourlyUses: uses })))
  assert.equal(result.filter((r) => r.inserted).length, 1)
  assert.deepEqual(await counts(db), { daily: 1, hourly: 1 })
  await assert.rejects(send(store, id, 'same', { text: 'Different' }), /Message request ID already used/)
  assert.deepEqual(await counts(db), { daily: 1, hourly: 1 })
  assert.equal((await store.snapshot(id, token('a'))).messages.length, 1)
})

test('atomic hourly admission across rooms refuses without consuming daily or other hourly keys', async (t) => {
  const { db, store, id } = await fixture(t)
  const other = await store.createRoom({ name: 'Alice', title: 'Other', token: token('a') })
  const results = await Promise.allSettled([id, other.room.id].map((room, i) => send(store, room, `request-${i}`, {
    hourlyUses: [...uses, { key: `browser-${i}`, limit: 10 }],
  })))
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.find((r) => r.status === 'rejected').reason.message, HOURLY_MESSAGE_LIMIT_MESSAGE)
  assert.deepEqual(await counts(db), { daily: 1, hourly: 2 })
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM ampersand_messages')).rows[0].n, 1)
})

test('atomic daily admission across rooms refuses without consuming hourly quota', async (t) => {
  const { db, store, id } = await fixture(t)
  const other = await store.createRoom({ name: 'Alice', title: 'Other', token: token('a') })
  const results = await Promise.allSettled([id, other.room.id].map((room, i) => send(store, room, `request-${i}`, {
    dailyLimit: 1, hourlyUses: [{ key: `browser-${i}`, limit: 10 }],
  })))
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.find((r) => r.status === 'rejected').reason.message, DAILY_LIMIT_MESSAGE)
  assert.deepEqual(await counts(db), { daily: 1, hourly: 1 })
})

test('create/join reserve hourly only with membership effects, and max-members races have one winner', async (t) => {
  const { db, store, id, invite } = await fixture(t)
  const created = await store.createRoom({ name: 'Alice', title: 'Limited', token: token('a'), hourlyUses: uses })
  await assert.rejects(store.createRoom({ name: 'Alice', title: 'Denied', token: token('a'), hourlyUses: uses }), { message: HOURLY_ROOM_LIMIT_MESSAGE })
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM ampersand_rooms')).rows[0].n, 2)
  const results = await Promise.allSettled(['b', 'c', 'd'].map((letter) => store.joinRoom({ id, invite, name: letter, token: token(letter), maxMembers: 2,
    hourlyUses: [{ key: `join-${letter}`, limit: 1 }],
  })))
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.message === ROOM_FULL_MESSAGE))
  const winner = results.findIndex((r) => r.status === 'fulfilled')
  const letter = ['b', 'c', 'd'][winner]
  const prior = await store.joinRoom({ id, invite, name: letter, token: token(letter), maxMembers: 2, hourlyUses: [{ key: `join-${letter}`, limit: 1 }] })
  assert.equal(prior.memberId, results[winner].value.memberId)
  assert.deepEqual(await counts(db), { daily: 0, hourly: 2 })
  assert.ok(created.room.id)
})

test('a failed SQL effect rolls back all reservations in the batch', async (t) => {
  const { db, store, id } = await fixture(t)
  await db.exec("ALTER TABLE ampersand_messages ADD CONSTRAINT reject_message CHECK (text <> 'Build this')")
  await assert.rejects(send(store, id, 'rollback', { hourlyUses: uses }), /reject_message/)
  assert.deepEqual(await counts(db), { daily: 0, hourly: 0 })
  assert.equal((await store.snapshot(id, token('a'))).messages.length, 0)
})

test('every trusted effect rejects stale ownership and expired leases with redacted errors', async (t) => {
  const { db, store, id } = await fixture(t)
  const now = Date.now()
  assert.equal(await store.claimRun(id, 'old-secret', now, now + 60_000, 1), true)
  await store.releaseRun(id, 'old-secret')
  assert.equal(await store.claimRun(id, 'new-secret', now, now + 60_000, 1), true)
  const stale = { runner: 'old-secret' }
  const effects = [
    () => store.assertRun(id, stale),
    () => store.setStatus(id, 'error', 'should not persist', stale, true),
    () => store.markProcessed(id, 900, stale),
    () => store.appendAssistant(id, 'should not persist', stale),
    () => store.publishDesign(id, '<p>should not persist</p>', stale),
    () => store.recordActivity(id, { agent: 'Builder', kind: 'message', text: 'should not persist' }, stale),
    () => store.saveAgentSession(id, 'Builder', { sessionId: 'should not persist', deliveredThrough: 900 }, stale),
  ]
  for (const effect of effects) await assert.rejects(effect(), (error) => error instanceof LeaseLostError && error.message === 'Room run lease lost')
  await store.releaseRun(id, 'old-secret')
  await store.assertRun(id, { runner: 'new-secret' })
  await db.query('UPDATE ampersand_rooms SET runner_until = 1 WHERE id = $1', [id])
  assert.equal(await store.renewRun(id, 'new-secret', 60_000), false)
  assert.equal(await store.claimRun(id, 'new-secret', now, now + 60_000, 1), false, 'an expired owner cannot revive its own token')
  await assert.rejects(store.appendAssistant(id, 'should not persist', { runner: 'new-secret' }), LeaseLostError)
  assert.doesNotMatch(await databaseText(db), /should not persist/)
})

test('watermark fences every visible effect but retains superseded run session IDs', async (t) => {
  const { db, store, id } = await fixture(t)
  await send(store, id, 'first')
  const throughId = await store.newestPendingId(id)
  const now = Date.now()
  assert.equal(await store.claimRun(id, 'runner', now, now + 60_000, 1), true)
  const guard = { runner: 'runner', throughId }
  await store.assertRun(id, guard)
  await store.publishDesign(id, '<p>Current</p>', guard)
  await send(store, id, 'second')
  for (const effect of [
    () => store.assertRun(id, guard),
    () => store.appendAssistant(id, 'stale effect', guard),
    () => store.markProcessed(id, throughId, guard),
    () => store.publishDesign(id, 'stale effect', guard),
    () => store.recordActivity(id, { agent: 'Builder', kind: 'message', text: 'stale effect' }, guard),
    () => store.setStatus(id, 'idle', 'stale effect', guard),
  ]) await assert.rejects(effect(), InputsChangedError)
  await store.saveAgentSession(id, 'Builder', { sessionId: 'retained', deliveredThrough: throughId }, guard)
  assert.equal((await store.agentSessions(id)).Builder.sessionId, 'retained')
  assert.equal((await store.pendingMessages(id)).length, 2)
  assert.doesNotMatch(await databaseText(db), /stale effect/)
})

test('run cap races across rooms have one winner; renewal requires an unexpired owner', async (t) => {
  const { store, id } = await fixture(t)
  const other = await store.createRoom({ name: 'Alice', title: 'Other', token: token('a') })
  const now = Date.now()
  const ids = [id, other.room.id]
  const claimed = await Promise.all(ids.map((room, i) => store.claimRun(room, `runner-${i}`, now, now + 60_000, 1)))
  assert.equal(claimed.filter(Boolean).length, 1)
  const winner = claimed.findIndex(Boolean), loser = 1 - winner
  assert.equal(await store.renewRun(ids[winner], `runner-${winner}`, 90_000), true)
  assert.equal(await store.renewRun(ids[winner], 'wrong', 90_000), false)
  await store.releaseRun(ids[winner], `runner-${winner}`)
  assert.equal(await store.claimRun(ids[loser], `runner-${loser}`, now, now + 60_000, 1), true)
})

test('run allocation, cap, polling and renewal use DB time despite old/future caller clocks', async (t) => {
  const { db, store, id } = await fixture(t)
  const other = await store.createRoom({ name: 'Alice', title: 'Other', token: token('a') })
  await send(store, id, 'pending')
  const remaining = async () => (await db.query(`SELECT runner_until - EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS ms
    FROM ampersand_rooms WHERE id = $1`, [id])).rows[0].ms
  for (const [i, now] of [1, Date.UTC(2100, 0, 1)].entries()) {
    const runner = `skew-${i}`
    assert.equal(await store.claimRun(id, runner, now, now + 60_000, 1), true)
    assert.ok(await remaining() > 55_000 && await remaining() <= 60_000)
    await store.assertRun(id, { runner })
    assert.equal(await store.claimRun(id, runner, now, now + 60_000, 1), true, 'a still-live owner may extend')
    assert.equal(await store.claimRun(other.room.id, 'other', now, now + 60_000, 1), false, 'DB-live leases count regardless of caller clock')
    assert.equal((await store.poll(id, token('a'), Date.UTC(2100, 0, 1), 0)).stalled, false)
    assert.equal(await store.renewRun(id, runner, 90_000), true)
    assert.ok(await remaining() > 85_000 && await remaining() <= 90_000)
    // Expire the durable lease, not merely the JS inputs to the next claim.
    await db.query('UPDATE ampersand_rooms SET runner_until = EXTRACT(EPOCH FROM clock_timestamp()) * 1000 - 1 WHERE id = $1', [id])
    await assert.rejects(store.assertRun(id, { runner }), LeaseLostError)
    assert.equal(await store.renewRun(id, runner, 60_000), false)
    assert.equal(await store.claimRun(id, runner, now, now + 60_000, 1), false, 'same expired token cannot resurrect')
    assert.equal(await store.claimRun(other.room.id, 'other', now, now + 60_000, 1), true, 'DB-expired leases do not count')
    await store.releaseRun(other.room.id, 'other')
    assert.equal(await store.claimRun(id, `takeover-${i}`, now, now + 60_000, 1), true)
    await store.releaseRun(id, `takeover-${i}`)
  }
})

test('unguarded trusted methods remain available for fixture seeding without a runner', async (t) => {
  const { store, id } = await fixture(t)
  await send(store, id, 'seed')
  const throughId = await store.newestPendingId(id)
  await store.appendAssistant(id, 'Seed reply')
  const revision = await store.publishDesign(id, '<p>Seed</p>')
  await store.recordActivity(id, { agent: 'Builder', kind: 'publish', text: 'Seed event', revision: revision.id })
  await store.saveAgentSession(id, 'Builder', { sessionId: 'seed-session', deliveredThrough: throughId })
  await store.markProcessed(id, throughId)
  await store.setStatus(id, 'idle')
  const room = await store.snapshotInternal(id)
  assert.equal(room.messages.at(-1).text, 'Seed reply')
  assert.equal(room.revisions.length, 1)
  assert.equal(room.activity[0].text, 'Seed event')
  assert.equal((await store.agentSessions(id)).Builder.sessionId, 'seed-session')
  assert.deepEqual(await store.pendingMessages(id), [])
  await assert.rejects(store.appendAssistant(id, 'Not seeded', { runner: 'not-held' }), LeaseLostError)
})

test('cleanup duration is allocated from DB time and expired ownership supports takeover', async (t) => {
  const { db, store, id } = await fixture(t)
  const cutoff = Date.now() + 60_000
  assert.equal(await store.claimCleanup(id, 'first', cutoff, 60_000), true)
  const remaining = (await db.query(`SELECT cleanup_until - EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS ms
    FROM ampersand_rooms WHERE id = $1`, [id])).rows[0].ms
  assert.ok(remaining > 55_000 && remaining <= 60_000)
  assert.equal(await store.claimCleanup(id, 'second', cutoff, 60_000), false)
  await db.query('UPDATE ampersand_rooms SET cleanup_until = EXTRACT(EPOCH FROM clock_timestamp()) * 1000 - 1 WHERE id = $1', [id])
  await assert.rejects(store.assertCleanup(id, 'first'), LeaseLostError)
  assert.equal(await store.claimCleanup(id, 'second', cutoff, 60_000), true)
  await store.assertCleanup(id, 'second')
  assert.equal(await store.deleteIdleRoom(id, cutoff, 'first'), false)
  assert.equal(await store.deleteIdleRoom(id, cutoff, 'second'), true)
})

test('cleanup locks out messages, membership and runs, persists beyond expiry, and permits fenced takeover', async (t) => {
  const { db, store, id, invite } = await fixture(t)
  const cutoff = Date.now() + 60_000
  assert.equal(await store.claimCleanup(id, 'cleanup-old', cutoff, 60_000), true)
  await store.assertCleanup(id, 'cleanup-old')
  const before = await databaseText(db)
  await assert.rejects(store.setReview(id, token('a'), true), /cleanup is in progress/)
  await assert.rejects(store.createInvite(id, token('a')), /cleanup is in progress/)
  assert.equal(await databaseText(db), before, 'review/invite refusals store nothing during cleanup')
  await assert.rejects(send(store, id, 'denied'), /cleanup is in progress/)
  await assert.rejects(store.joinRoom({ id, invite, name: 'Bob', token: token('b'), maxMembers: 10 }), /cleanup is in progress/)
  assert.equal(await store.claimRun(id, 'runner', Date.now(), Date.now() + 60_000, null), false)
  assert.equal(await store.deleteIdleRoom(id, cutoff), false)
  await db.query('UPDATE ampersand_rooms SET cleanup_until = 1 WHERE id = $1', [id])
  await assert.rejects(send(store, id, 'still-denied'), /cleanup is in progress/)
  assert.equal(await store.claimRun(id, 'runner', Date.now(), Date.now() + 60_000, null), false)
  await assert.rejects(store.assertCleanup(id, 'cleanup-old'), LeaseLostError)
  assert.equal(await store.deleteIdleRoom(id, cutoff, 'cleanup-old'), false)
  assert.equal(await store.claimCleanup(id, 'cleanup-new', cutoff, 60_000), true)
  await store.releaseCleanup(id, 'cleanup-old')
  await assert.rejects(store.assertCleanup(id, 'cleanup-old'), LeaseLostError)
  assert.equal(await store.deleteIdleRoom(id, cutoff, 'cleanup-old'), false)
  assert.equal(await store.deleteIdleRoom(id, cutoff, 'cleanup-new'), true)
})

test('cleanup rechecks age, pending input and live runners, and explicit release reopens a kept room', async (t) => {
  const { store, id } = await fixture(t)
  const now = Date.now(), cutoff = now + 60_000
  assert.equal(await store.claimCleanup(id, 'cleaner', 0, 60_000), false)
  assert.equal(await store.deleteIdleRoom(id, cutoff), false, 'deletion requires a cleanup owner even when idle')
  await send(store, id, 'pending')
  assert.equal(await store.claimCleanup(id, 'cleaner', cutoff, 60_000), false)
  assert.equal(await store.deleteIdleRoom(id, cutoff), false)
  await store.markProcessed(id, await store.newestPendingId(id))
  assert.equal(await store.claimRun(id, 'runner', now, now + 60_000, null), true)
  assert.equal(await store.claimCleanup(id, 'cleaner', cutoff, 60_000), false)
  await store.releaseRun(id, 'runner')
  assert.equal(await store.claimCleanup(id, 'cleaner', cutoff, 60_000), true)
  await store.releaseCleanup(id, 'cleaner')
  assert.equal((await send(store, id, 'after-cleanup')).inserted, true)
  assert.equal((await store.setReview(id, token('a'), true)).review, true)
  assert.equal(typeof await store.createInvite(id, token('a')), 'string')
})

test('failed batches reject delayed duplicate claims across restart; newer pending input and explicit retry admit', async (t) => {
  const { db, store, id } = await fixture(t)
  await send(store, id, 'failed', { dailyLimit: null })
  const firstId = await store.newestPendingId(id)
  const now = Date.now()
  assert.equal(await store.claimRun(id, 'first', now, now + 60_000, null), true)
  // Fixtures may omit failedThroughId: default to the newest pending input under the room lock.
  await store.setStatus(id, 'error', 'Attempt failed', { runner: 'first' })
  await store.releaseRun(id, 'first')
  assert.equal((await db.query('SELECT failed_through FROM ampersand_rooms WHERE id = $1', [id])).rows[0].failed_through, firstId)
  const restarted = storeOn(db)
  assert.equal((await send(restarted, id, 'failed', { dailyLimit: null })).inserted, false)
  const claims = await Promise.all(Array.from({ length: 4 }, (_, i) => restarted.claimRun(id, `delayed-${i}`, now, now + 60_000, null)))
  assert.deepEqual(claims, [false, false, false, false])
  assert.equal((await restarted.poll(id, token('a'), now + 60_000, 0)).stalled, false)
  await send(restarted, id, 'newer', { dailyLimit: null })
  const secondId = await restarted.newestPendingId(id)
  assert.equal(await restarted.claimRun(id, 'new-input', now, now + 60_000, null), true)
  await restarted.setStatus(id, 'error', 'New attempt failed', { runner: 'new-input' }, undefined, secondId)
  await restarted.releaseRun(id, 'new-input')
  assert.equal(await restarted.claimRun(id, 'duplicate-newer', now, now + 60_000, null), false)
  assert.equal((await restarted.retryRoom(id, token('a'), 1, uses)).started, true)
  assert.deepEqual(await counts(db), { daily: 1, hourly: 1 })
  assert.equal(await restarted.claimRun(id, 'explicit-retry', now, now + 60_000, null), true)
})

test('error status ignores a superseded watermark but still requires live ownership', async (t) => {
  const { db, store, id } = await fixture(t)
  await send(store, id, 'attempted')
  const attempted = await store.newestPendingId(id)
  const now = Date.now()
  assert.equal(await store.claimRun(id, 'first', now, now + 60_000, null), true)
  await send(store, id, 'arrived-during-failure')
  const newest = await store.newestPendingId(id)
  await store.setStatus(id, 'error', 'Attempt failed', { runner: 'first', throughId: attempted }, undefined, attempted)
  assert.deepEqual((await db.query('SELECT status, failed_through FROM ampersand_rooms WHERE id = $1', [id])).rows,
    [{ status: 'error', failed_through: attempted }])
  assert.ok(newest > attempted)
  await store.releaseRun(id, 'first')
  assert.equal(await store.claimRun(id, 'replacement', now, now + 60_000, null), true)
  const before = await databaseText(db)
  await assert.rejects(store.setStatus(id, 'error', 'Stale failure', { runner: 'first', throughId: attempted }, undefined, attempted), LeaseLostError)
  assert.equal(await databaseText(db), before)
  await db.query('UPDATE ampersand_rooms SET runner_until = 1 WHERE id = $1', [id])
  const expired = await databaseText(db)
  await assert.rejects(store.setStatus(id, 'error', 'Expired failure', { runner: 'replacement' }, undefined, newest), LeaseLostError)
  assert.equal(await databaseText(db), expired)
})

test('markProcessed settles watermark, idle status, cleared error and version in one fenced effect', async (t) => {
  const { db, store, id } = await fixture(t)
  await send(store, id, 'first')
  const firstId = await store.newestPendingId(id)
  const now = Date.now()
  assert.equal(await store.claimRun(id, 'runner', now, now + 60_000, null), true)
  await store.setStatus(id, 'error', 'Previous attempt failed', { runner: 'runner' }, undefined, firstId)
  await store.setStatus(id, 'working', 'Previous attempt failed', { runner: 'runner' })
  await send(store, id, 'second')
  const newest = await store.newestPendingId(id)
  const state = async () => (await db.query('SELECT processed_through, status, error, version FROM ampersand_rooms WHERE id = $1', [id])).rows[0]
  const before = await state()
  await assert.rejects(store.markProcessed(id, firstId, { runner: 'runner', throughId: firstId }), InputsChangedError)
  assert.deepEqual(await state(), before)
  // Force SQL failure to prove all success fields roll back together.
  await db.exec("ALTER TABLE ampersand_rooms ADD CONSTRAINT refuse_settlement CHECK (status <> 'idle' OR processed_through = 0)")
  await assert.rejects(store.markProcessed(id, newest, { runner: 'runner', throughId: newest }), /refuse_settlement/)
  assert.deepEqual(await state(), before)
  await db.exec('ALTER TABLE ampersand_rooms DROP CONSTRAINT refuse_settlement')
  await store.markProcessed(id, newest, { runner: 'runner', throughId: newest })
  assert.deepEqual(await state(), { processed_through: newest, status: 'idle', error: null, version: before.version + 1 })
  assert.deepEqual(await store.pendingMessages(id), [])
  await db.query('UPDATE ampersand_rooms SET runner_until = 1 WHERE id = $1', [id])
  await assert.rejects(store.assertRun(id, { runner: 'runner' }), LeaseLostError)
  assert.deepEqual(await state(), { processed_through: newest, status: 'idle', error: null, version: before.version + 1 })
})

test('same expired run owner can persist uncertain cleanup, never lower its failure watermark, and requires retry', async (t) => {
  const { db, store, id } = await fixture(t)
  await send(store, id, 'attempted', { dailyLimit: null })
  const firstId = await store.newestPendingId(id)
  const now = Date.now()
  assert.equal(await store.claimRun(id, 'uncertain', now, now + 60_000, null), true)
  await send(store, id, 'newer', { dailyLimit: null })
  const newest = await store.newestPendingId(id)
  await db.query('UPDATE ampersand_rooms SET runner_until = 1 WHERE id = $1', [id])
  await assert.rejects(store.setStatus(id, 'error', 'Expired ordinary write', { runner: 'uncertain' }, true, newest), LeaseLostError)
  const version = (await store.snapshotInternal(id)).version
  assert.equal(await store.blockRunCleanup(id, 'uncertain', 'Cancellation uncertain', newest), true)
  assert.equal(await store.blockRunCleanup(id, 'uncertain', 'Cancellation still uncertain', firstId), true)
  assert.deepEqual((await db.query('SELECT status, error, cleanup_blocked, failed_through, version FROM ampersand_rooms WHERE id = $1', [id])).rows,
    [{ status: 'error', error: 'Cancellation still uncertain', cleanup_blocked: true, failed_through: newest, version: version + 2 }])
  await store.releaseRun(id, 'uncertain')
  const restarted = storeOn(db)
  await send(restarted, id, 'more-input', { dailyLimit: null })
  assert.equal(await restarted.claimRun(id, 'automatic', now, now + 60_000, null), false, 'new input cannot bypass uncertain cleanup')
  assert.equal((await restarted.retryRoom(id, token('a'), 1, uses)).started, true)
  assert.equal(await restarted.claimRun(id, 'explicit', now, now + 60_000, null), true)
})

test('cleanup error marker cannot override a replacement runner, a released owner, or cleanup ownership', async (t) => {
  const { db, store, id } = await fixture(t)
  const now = Date.now()
  assert.equal(await store.claimRun(id, 'old', now, now + 60_000, null), true)
  await db.query('UPDATE ampersand_rooms SET runner_until = 1 WHERE id = $1', [id])
  assert.equal(await store.claimRun(id, 'replacement', now, now + 60_000, null), true)
  let before = await databaseText(db)
  assert.equal(await store.blockRunCleanup(id, 'old', 'Must not persist', 100), false)
  assert.equal(await databaseText(db), before)
  await store.assertRun(id, { runner: 'replacement' })
  await store.releaseRun(id, 'replacement')
  before = await databaseText(db)
  assert.equal(await store.blockRunCleanup(id, 'replacement', 'Must not persist', 100), false)
  assert.equal(await databaseText(db), before)
  assert.equal(await store.claimRun(id, 'expired', now, now + 60_000, null), true)
  await db.query('UPDATE ampersand_rooms SET runner_until = 1 WHERE id = $1', [id])
  assert.equal(await store.claimCleanup(id, 'cleaner', now + 60_000, 60_000), true)
  before = await databaseText(db)
  assert.equal(await store.blockRunCleanup(id, 'expired', 'Must not persist', 100), false)
  assert.equal(await databaseText(db), before)
})

test('cleanupBlocked survives restart and new messages; only one explicit retry clears it and charges', async (t) => {
  const { db, store, id } = await fixture(t)
  await send(store, id, 'pending', { dailyLimit: null })
  const now = Date.now()
  await store.claimRun(id, 'runner', now, now + 60_000, null)
  await store.setStatus(id, 'error', 'Cleanup uncertain', { runner: 'runner' }, true)
  await store.releaseRun(id, 'runner')
  const restarted = storeOn(db)
  await send(restarted, id, 'more', { dailyLimit: null })
  assert.equal((await restarted.poll(id, token('a'), Date.now() + 60_000, 0)).stalled, false)
  assert.equal(await restarted.claimRun(id, 'new-runner', now, now + 60_000, null), false)
  const results = await Promise.all(Array.from({ length: 4 }, () => restarted.retryRoom(id, token('a'), 1, uses)))
  assert.equal(results.filter((r) => r.started).length, 1)
  assert.deepEqual(await counts(db), { daily: 1, hourly: 1 })
  const room = await restarted.snapshot(id, token('a'))
  assert.equal(room.status, 'idle')
  assert.equal(room.error, null)
  assert.equal(await restarted.claimRun(id, 'new-runner', now, now + 60_000, null), true)
  assert.equal((await restarted.retryRoom(id, token('a'), 1, uses)).started, false)
})

test('retry quota refusal preserves error/barrier; no pending or live runner makes retry a free no-op', async (t) => {
  const { db, store, id } = await fixture(t)
  assert.equal((await store.retryRoom(id, token('a'), 1, uses)).started, false)
  await send(store, id, 'pending', { dailyLimit: 1 })
  await store.setStatus(id, 'error', 'Uncertain', undefined, true)
  await assert.rejects(store.retryRoom(id, token('a'), 1, uses), { message: DAILY_LIMIT_MESSAGE })
  assert.equal((await store.snapshot(id, token('a'))).error, 'Uncertain')
  assert.equal((await db.query('SELECT cleanup_blocked FROM ampersand_rooms WHERE id = $1', [id])).rows[0].cleanup_blocked, true)
  await store.setStatus(id, 'error', 'Uncertain', undefined, false)
  await send(store, id, 'newer-pending', { dailyLimit: null })
  const now = Date.now()
  assert.equal(await store.claimRun(id, 'live', now, now + 60_000, null), true)
  assert.equal((await store.retryRoom(id, token('a'), 1, uses)).started, false)
  assert.deepEqual(await counts(db), { daily: 1, hourly: 0 })
})

test('semicolon-split migration upgrades the previous rooms schema and is idempotent', async (t) => {
  const db = await createRoomsDatabase()
  t.after(() => db.close())
  const prior = await storeOn(db).createRoom({ name: 'Alice', title: 'Existing', token: token('a') })
  await db.exec(`ALTER TABLE ampersand_rooms DROP COLUMN failed_through;
    ALTER TABLE ampersand_rooms DROP COLUMN cleanup_blocked;
    ALTER TABLE ampersand_rooms DROP COLUMN cleanup_owner;
    ALTER TABLE ampersand_rooms DROP COLUMN cleanup_until;
    DROP TABLE ampersand_coordination`)
  const schema = readFileSync(new URL('../migrations/006_ampersand_rooms.sql', import.meta.url), 'utf8')
  const statements = schema.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
    .split(';').map((text) => text.trim()).filter(Boolean)
  for (let pass = 0; pass < 2; pass++) await db.transaction(async (tx) => {
    for (const text of statements) await tx.query(text)
  })
  const store = storeOn(db)
  const { room } = await store.createRoom({ name: 'Alice', title: 'Migrated', token: token('a') })
  assert.deepEqual((await db.query('SELECT failed_through, cleanup_blocked, cleanup_owner, cleanup_until FROM ampersand_rooms WHERE id = $1', [room.id])).rows,
    [{ failed_through: 0, cleanup_blocked: false, cleanup_owner: null, cleanup_until: null }])
  assert.deepEqual((await db.query('SELECT failed_through FROM ampersand_rooms WHERE id = $1', [prior.room.id])).rows, [{ failed_through: 0 }])
  assert.deepEqual((await db.query('SELECT id FROM ampersand_coordination')).rows, [{ id: 1 }])
})

test('batch structure acquires locks in separate statements before count/check snapshots', async (t) => {
  // PGlite has one connection: concurrency tests above prove SQL effects/rollback,
  // NOT multi-connection PostgreSQL lock scheduling. This asserts the snapshot boundary.
  const db = await createRoomsDatabase()
  t.after(() => db.close())
  const batches = []
  const query = async (text, values) => (await db.query(text, values)).rows
  query.transaction = (statements) => {
    batches.push(statements)
    return db.transaction(async (tx) => {
      const results = []
      for (const { text, values } of statements) results.push((await tx.query(text, values)).rows)
      return results
    })
  }
  const store = createRoomStore(query)
  const { room, invite } = await store.createRoom({ name: 'A', title: 'Board', token: token('a') })
  await store.joinRoom({ id: room.id, invite, name: 'B', token: token('b'), maxMembers: 2 })
  await send(store, room.id, 'first', { hourlyUses: uses })
  await store.claimRun(room.id, 'runner', Date.now(), Date.now() + 60_000, 1)
  await store.appendAssistant(room.id, 'Reply', { runner: 'runner' })
  await store.blockRunCleanup(room.id, 'runner', 'Cancellation uncertain', 0)
  const [create, join, message, claim, guarded, cleanupBlock] = batches
  for (const batch of [create, join, message, claim]) {
    assert.match(batch[0].text, /FROM ampersand_coordination .*FOR UPDATE/)
    assert.doesNotMatch(batch[0].text, /COUNT\(|ampersand_members|ampersand_hourly/)
  }
  for (const batch of [join, message, claim]) {
    assert.match(batch[1].text, /FROM ampersand_rooms .*FOR UPDATE/)
    assert.doesNotMatch(batch[1].text, /COUNT\(/)
  }
  assert.match(join[2].text, /COUNT\(\*\) FROM ampersand_members/)
  assert.match(message[2].text, /ampersand_hourly/)
  assert.match(claim[2].text, /COUNT\(\*\) FROM ampersand_rooms/)
  assert.match(guarded[0].text, /FOR UPDATE/)
  assert.match(guarded[1].text, /clock_timestamp\(\)/)
  assert.match(cleanupBlock[0].text, /FOR UPDATE/)
  assert.match(cleanupBlock[1].text, /runner = \$2 AND cleanup_owner IS NULL/)
  assert.doesNotMatch(cleanupBlock[1].text, /runner_until|processed_through\s*=/)
})
