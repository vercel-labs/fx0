import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Keep the journal, draft store, and session logger isolated from real services.
const fake = globalThis.__fx0EventStream = { localEvents: new EventEmitter(), reads: 0, read: null, readDraft: null, logs: [] }
const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`
const fakes = {
  './journal': dataUrl(`export const localEvents = globalThis.__fx0EventStream.localEvents
export const readEvents = async () => { const fake = globalThis.__fx0EventStream; fake.reads += 1; return fake.read ? fake.read() : [] }`),
  './draft-store': dataUrl('export const readDraft = async () => globalThis.__fx0EventStream.readDraft?.() ?? null'),
  './session': dataUrl('export const log = (session, event, detail) => globalThis.__fx0EventStream.logs.push({ session, event, ...detail })'),
}
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/lib/event-stream.ts') && fakes[specifier]) return { url: fakes[specifier], shortCircuit: true }
  return next(specifier, context)
} })
const { createSessionEventStream } = await import('../lib/event-stream.ts')

test('a stream with a lifetime ends cleanly on its own and stops reading and listening', async () => {
  const started = Date.now()
  const reader = createSessionEventStream('chat-a', { maxLifetimeMs: 80 }).getReader()
  assert.equal(fake.localEvents.listenerCount('chat-a'), 1)
  const { done } = await reader.read()
  assert.equal(done, true)
  assert.ok(Date.now() - started >= 70)
  assert.equal(fake.localEvents.listenerCount('chat-a'), 0)
  assert.equal(fake.localEvents.listenerCount('chat-a:live'), 0)
  // Polling backs off from 150ms, so a stream still running would read again here.
  const reads = fake.reads
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(fake.reads, reads)
})

// A journal read the test fails by hand, and the rejections nothing handled.
function pendingRead(t) {
  let fail
  fake.read = () => new Promise((_resolve, reject) => { fail = reject })
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => {
    fake.read = null
    process.off('unhandledRejection', onUnhandled)
  })
  return {
    unhandled,
    async fail() {
      fail(new Error('redis down'))
      await new Promise((resolve) => setTimeout(resolve, 50))
    },
  }
}

test('a read that fails after the client left is dropped, not left unhandled', async (t) => {
  const read = pendingRead(t)
  const reader = createSessionEventStream('chat-left').getReader()
  assert.equal(fake.localEvents.listenerCount('chat-left'), 1)
  await reader.cancel()
  await read.fail()
  assert.deepEqual(read.unhandled, [])
  const reads = fake.reads
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(fake.reads, reads, 'a stopped stream reads no more')
})

test('a read that fails after a terminal item closed the stream is dropped, not left unhandled', async (t) => {
  const read = pendingRead(t)
  const reader = createSessionEventStream('chat-ended', { closeWhen: (item) => item.type === 'done' }).getReader()
  fake.localEvents.emit('chat-ended', { type: 'done', seq: 1, turnId: 1 })
  const { value } = await reader.read()
  assert.match(value, /"type":"done"/)
  assert.equal((await reader.read()).done, true)
  await read.fail()
  assert.deepEqual(read.unhandled, [])
})

test('a local capture logs delivery once without logging its payload', async (t) => {
  let resolveJournal
  fake.logs = []
  fake.read = () => new Promise((resolve) => { resolveJournal = resolve })
  t.after(() => { fake.read = null })
  const wallNow = 1_800_000_000_400
  t.mock.method(Date, 'now', () => wallNow)
  const session = 'b0d05174-a3bd-4d84-8233-89c1758239e7'
  const item = {
    type: 'capture', seq: 1, cid: 'b365859e-5264-4e72-b814-d19163d2f716',
    instance: 'a123', at: wallNow - 400, text: 'must not be logged',
    content: 'must not be logged either',
  }
  const reader = createSessionEventStream(session).getReader()
  t.after(() => reader.cancel())
  fake.localEvents.emit(session, item)
  assert.equal((await reader.read()).value, `id: 1\ndata: ${JSON.stringify(item)}\n\n`)
  fake.localEvents.emit(session, item)
  resolveJournal([item])
  await new Promise(setImmediate)
  fake.localEvents.emit(session, { type: 'status', seq: 2, text: 'not a capture' })
  assert.deepEqual(fake.logs, [{
    session, event: 'capture:delivery', source: 'local', seq: 1,
    cid: item.cid, writerInstance: item.instance, eventAgeWallEstimateMs: 400,
  }])
})

test('a polled capture is delivered before an unrelated draft read finishes', async (t) => {
  let resolveJournal
  let resolveDraft
  let journalReads = 0
  let draftReads = 0
  let elapsed = 0
  fake.logs = []
  fake.read = () => ++journalReads === 1 ? [] : new Promise((resolve) => { resolveJournal = resolve })
  fake.readDraft = () => ++draftReads === 1 ? null : new Promise((resolve) => { resolveDraft = resolve })
  t.after(() => { fake.read = null; fake.readDraft = null })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(performance, 'now', () => elapsed)
  const wallNow = 1_800_000_000_500
  t.mock.method(Date, 'now', () => wallNow)
  const session = 'fe4272cd-5973-49ca-8571-07b84befa449'
  const item = {
    type: 'capture', seq: 1, cid: 'a41c1e4e-4783-435b-b296-c34db501e62d',
    instance: 'b456', at: wallNow - 500, text: 'must not be logged',
  }
  const reader = createSessionEventStream(session).getReader()
  t.after(() => reader.cancel())
  await new Promise(setImmediate)
  assert.equal(journalReads, 1)
  t.mock.timers.tick(149)
  assert.equal(journalReads, 1)
  t.mock.timers.tick(1)
  assert.equal(journalReads, 2)
  elapsed = 12
  resolveJournal([item])
  await new Promise(setImmediate)
  assert.equal(fake.logs.length, 1, 'a ready capture does not wait for the pending draft')
  assert.equal((await reader.read()).value, `id: 1\ndata: ${JSON.stringify(item)}\n\n`)
  assert.equal(fake.logs[0].draftReadMs, undefined, 'an unfinished read is not reported as a zero-duration read')
  elapsed = 89
  resolveDraft(null)
  await new Promise(setImmediate)
  fake.localEvents.emit(session, item)
  t.mock.timers.tick(100)
  elapsed = 101
  resolveJournal([item])
  resolveDraft(null)
  await new Promise(setImmediate)
  assert.deepEqual(fake.logs, [{
    session, event: 'capture:delivery', source: 'poll', seq: 1,
    cid: item.cid, writerInstance: item.instance, eventAgeWallEstimateMs: 500,
    journalReadMs: 12, pollScheduledDelayMs: 150,
  }])
})

test('a read that fails while the stream is open still ends it with an error line', async (t) => {
  const read = pendingRead(t)
  const reader = createSessionEventStream('chat-open').getReader()
  await read.fail()
  const { value } = await reader.read()
  assert.equal(value, `data: ${JSON.stringify({ type: 'error', text: 'event journal unavailable: redis down' })}\n\n`)
  assert.equal((await reader.read()).done, true)
  assert.deepEqual(read.unhandled, [])
})

for (const activeSource of ['journal', 'draft']) {
  test(`${activeSource} activity polls at 50/75ms and done restores 100/1000ms idle polling`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    let journalReads = 0
    let items = activeSource === 'journal' ? [{ type: 'turn_start', seq: 1, turnId: 1 }] : []
    let draft = activeSource === 'draft' ? {
      cursor: { id: 'active', count: 1, closed: false, revision: 1, turnId: 1, base: 0 },
      item: { type: 'design_draft', draftId: 'active', turnId: 1, draftClosed: false, delta: '<body>' },
    } : null
    fake.read = () => {
      journalReads += 1
      const ready = items
      items = []
      return ready
    }
    fake.readDraft = () => {
      const ready = draft
      draft = null
      return ready
    }
    t.after(() => { fake.read = null; fake.readDraft = null })
    const reader = createSessionEventStream(`chat-poll-${activeSource}`).getReader()
    t.after(() => reader.cancel())
    await new Promise(setImmediate)
    assert.equal(journalReads, 1)
    assert.match((await reader.read()).value, activeSource === 'journal' ? /"type":"turn_start"/ : /"type":"design_draft"/)

    const advancePoll = async (delay) => {
      const before = journalReads
      t.mock.timers.tick(delay - 1)
      await new Promise(setImmediate)
      assert.equal(journalReads, before, `no poll before ${delay}ms`)
      t.mock.timers.tick(1)
      await new Promise(setImmediate)
      assert.equal(journalReads, before + 1, `poll at ${delay}ms`)
    }
    await advancePoll(50)
    await advancePoll(75)
    items = [{ type: 'text', seq: 2, turnId: 1, delta: 'active' }]
    await advancePoll(75)
    assert.match((await reader.read()).value, /"type":"text"/)
    items = [{ type: 'done', seq: 3, turnId: 1 }]
    await advancePoll(50)
    assert.match((await reader.read()).value, /"type":"done"/)
    for (const delay of [100, 150, 225, 338, 507, 761, 1000, 1000]) await advancePoll(delay)
  })
}

for (const first of ['journal', 'draft']) {
  test(`journal events precede draft bytes when ${first} completes first`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    let resolveJournal
    let resolveDraft
    fake.read = () => new Promise((resolve) => { resolveJournal = resolve })
    fake.readDraft = () => new Promise((resolve) => { resolveDraft = resolve })
    t.after(() => { fake.read = null; fake.readDraft = null })
    const reader = createSessionEventStream(`chat-order-${first}`).getReader()
    t.after(() => reader.cancel())
    assert.equal(typeof resolveJournal, 'function')
    assert.equal(typeof resolveDraft, 'function', 'both reads start concurrently')
    const items = [
      { type: 'turn_start', seq: 1, turnId: 1 },
      { type: 'text', seq: 2, turnId: 1, delta: 'journal' },
    ]
    const draft = {
      cursor: { id: 'ordered', count: 1, closed: false, revision: 1, turnId: 1, base: 0 },
      item: { type: 'design_draft', draftId: 'ordered', turnId: 1, delta: '<body>' },
    }
    const delivered = []
    const reads = [reader.read(), reader.read(), reader.read()].map((read) => read.then(({ value }) => delivered.push(value)))
    const journalChunks = items.map((item) => `id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`)
    if (first === 'draft') resolveDraft(draft)
    else resolveJournal(items)
    await new Promise(setImmediate)
    assert.deepEqual(delivered, first === 'draft' ? [] : journalChunks)
    if (first === 'draft') resolveJournal(items)
    else resolveDraft(draft)
    await new Promise(setImmediate)
    assert.deepEqual(delivered, [...journalChunks, `id: \ndata: ${JSON.stringify(draft.item)}\n\n`])
    await Promise.all(reads)
  })
}

for (const ending of ['cancel', 'local terminal', 'journal terminal']) {
  for (const settlement of ['resolve', 'reject']) {
    test(`${ending} with a pending draft ignores its late ${settlement}`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
      const enqueue = t.mock.method(ReadableStreamDefaultController.prototype, 'enqueue')
      let resolveJournal
      let resolveDraft
      let rejectDraft
      let journalReads = 0
      let draftReads = 0
      fake.read = () => {
        journalReads += 1
        return new Promise((resolve) => { resolveJournal = resolve })
      }
      fake.readDraft = () => {
        draftReads += 1
        return new Promise((resolve, reject) => { resolveDraft = resolve; rejectDraft = reject })
      }
      const unhandled = []
      const onUnhandled = (reason) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      t.after(() => {
        fake.read = null
        fake.readDraft = null
        process.off('unhandledRejection', onUnhandled)
      })
      const session = `chat-pending-draft-${ending}-${settlement}`
      const reader = createSessionEventStream(session, { closeWhen: (item) => item.type === 'done' }).getReader()
      t.after(() => reader.cancel())
      const done = { type: 'done', seq: 1, turnId: 1 }
      resolveJournal(ending === 'journal terminal' ? [done] : [])
      await new Promise(setImmediate)
      assert.equal(draftReads, 1, 'draft read is still pending at shutdown')
      if (ending === 'cancel') await reader.cancel()
      else {
        if (ending === 'local terminal') fake.localEvents.emit(session, done)
        assert.equal((await reader.read()).value, `id: 1\ndata: ${JSON.stringify(done)}\n\n`)
      }
      assert.equal((await reader.read()).done, true)
      assert.equal(fake.localEvents.listenerCount(session), 0)
      assert.equal(fake.localEvents.listenerCount(`${session}:live`), 0)
      const writesAtClose = enqueue.mock.callCount()
      if (settlement === 'reject') rejectDraft(new Error('draft store unavailable'))
      else resolveDraft({
        cursor: { id: 'late', count: 1, closed: false, revision: 1, turnId: 1, base: 0 },
        item: { type: 'design_draft', draftId: 'late', turnId: 1, delta: 'must not enqueue' },
      })
      await new Promise(setImmediate)
      t.mock.timers.tick(30_000)
      await new Promise(setImmediate)
      assert.equal(enqueue.mock.callCount(), writesAtClose, 'no enqueue is attempted after shutdown')
      assert.equal((await reader.read()).done, true)
      assert.equal(journalReads, 1, 'shutdown never schedules another journal read')
      assert.equal(draftReads, 1, 'shutdown never schedules another draft read')
      assert.deepEqual(unhandled, [])
    })
  }
}
