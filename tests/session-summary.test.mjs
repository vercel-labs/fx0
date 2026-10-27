import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// readSessionSummaries reads each chat's state hash, activity flag and message count in
// one pipeline. The fake answers HMGET like Upstash: an object of the requested fields.
globalThis.__summaryState = new Map()
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@upstash/redis' && context.parentURL?.endsWith('/lib/journal.ts')) {
      const fake = `export class Redis {
        pipeline() {
          const queued = []
          const pipeline = {
            hmget: (key, ...fields) => { const hash = globalThis.__summaryState.get(key) ?? {}; queued.push(Object.fromEntries(fields.map((field) => [field, hash[field] ?? null]))); return pipeline },
            exists: () => { queued.push(0); return pipeline },
            get: () => { queued.push('2'); return pipeline },
            exec: async () => queued,
          }
          return pipeline
        }
      }`
      return { url: `data:text/javascript,${encodeURIComponent(fake)}`, shortCircuit: true }
    }
    return next(specifier, context)
  },
})
process.env.KV_REST_API_URL ??= 'https://redis.invalid'
process.env.KV_REST_API_TOKEN ??= 'test-token'
process.env.FX0_REDIS_PREFIX = 'summary-test'
const { readSessionSummaries } = await import('../lib/journal.ts')

test('history summaries carry the latest design revision only when a design exists', async () => {
  const state = (id, extra) => globalThis.__summaryState.set(`summary-test:session:${id}:state`, { id, createdAt: '1', lastActivity: '2', title: id, ...extra })
  state('designed', { artifactRevision: '3' })
  state('empty', { artifactRevision: '0' })
  state('broken', { artifactRevision: 'x' })
  state('unset', {})
  const summaries = Object.fromEntries((await readSessionSummaries(['designed', 'empty', 'broken', 'unset'])).map((summary) => [summary.id, summary]))
  assert.equal(summaries.designed.artifactRevision, 3)
  for (const id of ['empty', 'broken', 'unset']) assert.equal('artifactRevision' in summaries[id], false, `${id} has no revision`)
  assert.deepEqual(summaries.designed.generation, { model: '', effort: '', fast: false }, 'other fields are unchanged')
})
