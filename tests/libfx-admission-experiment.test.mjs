import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFxAgent } from 'libfx'
import { local } from 'libfx/durable-local'

// EXPERIMENT ONLY: proves the patched libfx admission (scripts/patch-libfx-experiment.mjs)
// keeps its invariants on the real installed SDK, with a local World instrumented at the
// calls Vercel's World serves over the network, and the request running its own turn as on
// Vercel (queueLeases, runInRequest). The queue records each send and delivers nothing, as
// Vercel Queues holds an in-request backstop until after the request's deadline.

const sse = text => new Response([
  `data: ${JSON.stringify({ type: 'text-delta', id: 'answer', delta: text })}`,
  'data: {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":1},"outputTokens":{"total":1}}}',
  'data: [DONE]', '',
].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function observed(dir, { failWrites = 0, viewerStartDelayMs = 40, writeDelayMs = 30, queueDelayMs = 60 } = {}) {
  const base = local({ dir })
  const timeline = []
  const queued = []
  let writeFailures = failWrites
  const track = (name, call) => async (...args) => {
    timeline.push(`start ${name}`)
    try {
      const value = await call(...args)
      timeline.push(`end ${name}`)
      return value
    } catch (error) {
      timeline.push(`fail ${name}`)
      throw error
    }
  }
  const world = () => {
    const w = base.world()
    return {
      ...w,
      events: {
        ...w.events,
        create: track('write', async (runId, event, ...rest) => {
          await delay(writeDelayMs)
          if (event?.eventType === 'step_created' && writeFailures > 0) { writeFailures--; throw new Error('synthetic log write failure') }
          return w.events.create(runId, event, ...rest)
        }),
        list: track('read', (...a) => w.events.list(...a)),
      },
      streams: { ...w.streams, getInfo: track('viewerStart', async (...a) => { await delay(viewerStartDelayMs); return w.streams.getInfo(...a) }) },
      queue: track('queue', async (name, payload, options) => {
        await delay(queueDelayMs)
        queued.push({ messageId: payload?.requestId, options })
        return { messageId: `msg_backstop_${queued.length}` }
      }),
    }
  }
  return { durability: { ...base, world, queueLeases: true, runInRequest: true, maxDurationMs: 60_000 }, timeline, queued }
}

function agentWith(durability, requests) {
  return createFxAgent({
    durability, apiKey: 'synthetic-experiment-key', model: 'sdk/experiment-model', instructions: 'Reply briefly.', tools: [],
    fetch: async (_url, init = {}) => {
      if ((init.method ?? 'GET') === 'GET') return Response.json({ data: [{ id: 'sdk/experiment-model', type: 'language' }] })
      requests.push(1)
      return sse('OK')
    },
  })
}

async function drain(turn) {
  const result = turn.result
  void result.catch(() => {})
  let text = ''
  try { for await (const event of turn) if (event.type === 'text_delta') text += event.delta } catch {}
  return { result: await result.catch(error => error), text }
}

test('the backstop is queued alongside the log write, the viewer start lands first, and acceptance waits for both', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fx0-admission-'))
  const { durability, timeline, queued } = observed(dir)
  const requests = []
  const agent = agentWith(durability, requests)
  try {
    const turn = agent.session().prompt('Hello', { messageId: 'm1', signal: AbortSignal.timeout(10_000) })
    await turn.accepted
    timeline.push('accepted')
    const { result, text } = await drain(turn)
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(text, 'OK', 'the viewer sees the whole turn from its start')
    assert.equal(requests.length, 1, 'the request ran the turn itself; the queue delivered nothing')
    assert.equal(queued.length, 1)
    assert.ok(queued[0].options.delaySeconds >= 60, `the backstop waits for the request's deadline: ${JSON.stringify(queued[0].options)}`)
    const at = label => timeline.indexOf(label)
    const lastBefore = (label, end) => timeline.lastIndexOf(label, end)
    assert.ok(at('end viewerStart') >= 0 && at('start write') > at('end viewerStart'), `no write before the viewer start lands: ${timeline.join(', ')}`)
    assert.ok(at('start read') < at('end viewerStart'), `send()'s read overlaps the viewer start: ${timeline.join(', ')}`)
    assert.ok(at('start queue') < at('end read'), `the backstop leaves before the log read and write finish: ${timeline.join(', ')}`)
    assert.ok(at('accepted') > at('end queue') && at('accepted') > lastBefore('end write', at('accepted')), `accepted only after the backstop and the write: ${timeline.join(', ')}`)
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed log write rejects acceptance and runs nothing; a retry of the same messageId runs once', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fx0-admission-fail-'))
  const { durability, timeline, queued } = observed(dir, { failWrites: 1 })
  const requests = []
  const agent = agentWith(durability, requests)
  try {
    const session = agent.session()
    const first = session.prompt('Hello', { messageId: 'm1', signal: AbortSignal.timeout(10_000) })
    await assert.rejects(first.accepted, /synthetic log write failure/)
    void first.result.catch(() => {})
    await delay(100)
    assert.equal(requests.length, 0, 'nothing runs when the input never reached the log')
    assert.ok(timeline.includes('fail write'))
    assert.equal(queued.length, 1, 'the early backstop went out; its delivery would find no input and be refused')

    const again = session.prompt('Hello', { messageId: 'm1', signal: AbortSignal.timeout(10_000) })
    await again.accepted
    const { result, text } = await drain(again)
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(text, 'OK')
    assert.equal(requests.length, 1, 'the retry runs the turn exactly once')
    assert.deepEqual(queued.map(q => q.messageId), ['m1', 'm1'], 'both backstops name the same message, under the same idempotency key')
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})
