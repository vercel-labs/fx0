import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { neonConfig } from '@neondatabase/serverless'

const root = new URL('../', import.meta.url)
const id = 'a'.repeat(22)
const databaseUrl = 'postgres://test:test@database.test/db'
// Neon HTTP returns raw text cells in arrays; the real driver decodes fields/OIDs.
const result = (name, dataTypeID, rows, command = 'SELECT') => ({
  fields: name ? [{ name, dataTypeID }] : [], rows, command, rowCount: rows.length,
})

test('production collabRuntime Neon HTTP wiring (no external I/O)', async (t) => {
  const savedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === 'DATABASE_URL' || key.startsWith('FX0_COLLAB_')))
  const savedRuntime = Object.getOwnPropertyDescriptor(globalThis, '__fx0CollabRuntime')
  const savedFetch = globalThis.fetch
  const savedNeonFetch = neonConfig.fetchFunction
  const requests = [], replies = []
  let fallbackCalls = 0
  const blockedFetch = () => { fallbackCalls++; throw new Error('External fetch forbidden') }
  const fakeFetch = async (url, options) => {
    assert.equal(String(url), 'https://api.test/sql')
    assert.equal(options.method, 'POST')
    const headers = new Headers(options.headers)
    assert.equal(headers.get('Neon-Connection-String'), databaseUrl)
    requests.push({ headers, body: JSON.parse(options.body) })
    assert.ok(replies.length, 'every HTTP request must have an explicitly queued fake response')
    return Response.json(replies.shift())
  }
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return next(`${specifier}.ts`, context)
    }
    return next(specifier, context)
  } })
  t.after(() => {
    hooks.deregister()
    neonConfig.fetchFunction = savedNeonFetch
    globalThis.fetch = savedFetch
    delete globalThis.__fx0CollabRuntime
    if (savedRuntime) Object.defineProperty(globalThis, '__fx0CollabRuntime', savedRuntime)
    for (const key of Object.keys(process.env)) {
      if (key === 'DATABASE_URL' || key.startsWith('FX0_COLLAB_')) delete process.env[key]
    }
    Object.assign(process.env, savedEnv)
  })
  for (const key of Object.keys(savedEnv)) delete process.env[key]
  // Clear the singleton: never inject a test store in place of production neonQuery().
  delete globalThis.__fx0CollabRuntime
  globalThis.fetch = blockedFetch
  neonConfig.fetchFunction = fakeFetch
  const { collabRuntime } = await import('../lib/collab/runtime.ts')
  // Prove interception is installed before constructing or calling the real store.
  assert.equal(neonConfig.fetchFunction, fakeFetch)
  assert.equal(globalThis.fetch, blockedFetch)
  assert.equal(globalThis.__fx0CollabRuntime, undefined)
  assert.equal(requests.length, 0)
  const runtime = collabRuntime()
  assert.equal(collabRuntime(), runtime)
  assert.equal(requests.length, 0, 'runtime construction is lazy')

  await t.test('missing DATABASE_URL rejects reads and transactions without HTTP', async () => {
    await assert.rejects(runtime.store.newestPendingId(id), { message: 'DATABASE_URL is required' })
    await assert.rejects(runtime.store.claimRun(id, 'runner', 1000, 61000, 2), { message: 'DATABASE_URL is required' })
    assert.equal(requests.length, 0)
    assert.equal(fallbackCalls, 0)
  })
  process.env.DATABASE_URL = databaseUrl

  await t.test('single query binds parameters and decodes named numeric rows', async () => {
    replies.push(result('newest', 23, [['42']]))
    assert.equal(await runtime.store.newestPendingId(id), 42)
    assert.equal(requests.length, 1)
    const { headers, body } = requests[0]
    assert.equal(body.queries, undefined)
    assert.match(body.query, /^SELECT COALESCE\(/)
    assert.match(body.query, /AS newest FROM ampersand_rooms r WHERE r.id = \$1$/)
    assert.deepEqual(body.params, [id])
    assert.equal(headers.get('Neon-Batch-Isolation-Level'), null)
  })

  await t.test('claimRun sends locks then data in one ReadCommitted HTTP batch', async () => {
    replies.push({ results: [result(null, 0, []), result(null, 0, []), result('id', 25, [[id]], 'UPDATE')] })
    assert.equal(await runtime.store.claimRun(id, 'runner', 1000, 61000, 2), true)
    assert.equal(requests.length, 2, 'exactly one additional HTTP request, not BEGIN/query/COMMIT')
    const { headers, body } = requests[1]
    assert.equal(headers.get('Neon-Batch-Isolation-Level'), 'ReadCommitted')
    assert.equal(body.query, undefined)
    assert.equal(body.queries.length, 3)
    assert.deepEqual(body.queries[0], { query: 'SELECT id FROM ampersand_coordination WHERE id = 1 FOR UPDATE', params: [] })
    assert.deepEqual(body.queries[1], { query: 'SELECT id FROM ampersand_rooms WHERE id = $1 FOR UPDATE', params: [id] })
    assert.match(body.queries[2].query, /^UPDATE ampersand_rooms r SET runner = \$2,/)
    assert.match(body.queries[2].query, /RETURNING r.id$/)
    // Neon serializes bound numeric values as text before sending them.
    assert.deepEqual(body.queries[2].params, [id, 'runner', '60000', '2'])
  })

  await t.test('an empty claim result remains false through the real driver', async () => {
    replies.push({ results: [result(null, 0, []), result(null, 0, []), result('id', 25, [], 'UPDATE')] })
    assert.equal(await runtime.store.claimRun(id, 'other-runner', 1000, 61000, null), false)
    assert.equal(requests.length, 3)
    assert.equal(requests[2].headers.get('Neon-Batch-Isolation-Level'), 'ReadCommitted')
    assert.deepEqual(requests[2].body.queries[2].params, [id, 'other-runner', '60000', null])
  })

  for (const { body } of requests) {
    for (const statement of body.queries ?? [body]) assert.doesNotMatch(statement.query, /\b(?:BEGIN|COMMIT)\b/i)
  }
  assert.equal(replies.length, 0)
  assert.equal(fallbackCalls, 0, 'all I/O used neonConfig.fetchFunction, never global fetch')
})
