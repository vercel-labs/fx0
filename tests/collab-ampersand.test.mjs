import assert from 'node:assert/strict'
import test from 'node:test'
import { AmpersandError, cancelSession, createAmpersandClient, createSession, deleteSession, postEvents, redactedErrorMessage, retrieveSession } from '../lib/collab/ampersand.ts'
import { MAX_ERROR_LENGTH } from '../lib/collab/types.ts'
import { createAgentsApi } from './fixtures/agents-api.mjs'

const BASE_URL = 'https://ampersand.test/v1'
const agent = { model: 'ampersand-test', instructions: 'Help.', tools: [], ampersand: { allow_silent_completion: true } }
const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }], metadata: { id: 'message-1', source: 'fx0-collab', sender: 'alice', sender_name: 'Alice', channel: 'room', timestamp: 1 } }]
const start = { agent, input, metadata: { fx0_config: 'a'.repeat(64) } }

function harness() {
  const api = createAgentsApi()
  return { api, client: createAmpersandClient({ baseUrl: BASE_URL, apiKey: api.apiKey, fetch: api.fetch }) }
}

test('the client accepts HTTPS, or HTTP on loopback, without credentials or a query', () => {
  for (const baseUrl of ['https://ampersand.example/v1', 'http://127.0.0.1:8080/v1', 'http://localhost/v1', 'http://[::1]:9000/v1']) {
    assert.ok(createAmpersandClient({ baseUrl, apiKey: 'key' }))
  }
  for (const baseUrl of ['http://ampersand.example/v1', 'https://user:pass@ampersand.example/v1', 'https://ampersand.example/v1?tenant=a', 'https://ampersand.example/v1#x', 'ftp://ampersand.example/v1']) {
    assert.throws(() => createAmpersandClient({ baseUrl, apiKey: 'key' }), { message: 'Ampersand API URL must use HTTPS, or HTTP on localhost, without credentials or a query' })
  }
  assert.throws(() => createAmpersandClient({ baseUrl: BASE_URL, apiKey: '' }), { message: 'Ampersand API key is required' })
})

test('request failures name only the HTTP status and stage, and redirects are refused', async () => {
  const { api, client } = harness()
  const secretBody = () => Response.json({ error: { message: `internal detail ${api.apiKey}` } }, { status: 500, headers: { 'retry-after-ms': '0' } })
  api.intercept((request) => request.path === '/v1/agents/sessions/sess_x', secretBody, Infinity)
  const failure = await retrieveSession(client, 'sess_x', AbortSignal.timeout(5_000)).catch((error) => error)
  assert.ok(failure instanceof AmpersandError)
  assert.equal(failure.message, 'Ampersand API request failed (HTTP 500) [retrieve]')
  assert.equal(failure.status, 500)
  assert.equal(api.requests.length, 6, 'reads are retried five times')
  assert.deepEqual(new Set(api.requests.map((request) => request.redirect)), new Set(['error']), 'the key stays on its origin')

  const missing = await retrieveSession(client, 'sess_missing', AbortSignal.timeout(5_000)).catch((error) => error)
  assert.equal(missing.message, 'Ampersand API request failed (HTTP 404) [retrieve]')
  assert.equal(missing.status, 404)

  // A malformed success body is reported without any of its text.
  api.intercept((request) => request.path === '/v1/agents/sessions/sess_y', () => new Response(`upstream proxy page for ${api.apiKey}`, { status: 200, headers: { 'content-type': 'application/json' } }))
  const malformed = await retrieveSession(client, 'sess_y', AbortSignal.timeout(5_000)).catch((error) => error)
  assert.ok(malformed instanceof AmpersandError)
  assert.equal(malformed.message, 'Ampersand API request failed (no response) [retrieve]')
  assert.equal(malformed.status, null)

  let attempts = 0
  const offline = createAmpersandClient({ baseUrl: BASE_URL, apiKey: api.apiKey, fetch: async () => {
    attempts++
    throw new TypeError(`connect failed with ${api.apiKey}`)
  } })
  const unreachable = await createSession(offline, start, AbortSignal.timeout(5_000)).catch((error) => error)
  assert.equal(unreachable.message, 'Ampersand API request failed (no response) [create]')
  assert.equal(unreachable.status, null)
  assert.equal(attempts, 1, 'a create lost in transit may have succeeded, so it is not retried')
})

test('session creation retries only a definite 429, preferring retry-after-ms, at most five times', async () => {
  const { api, client } = harness()
  // retry-after-ms wins over Retry-After; honoring the 60 s header instead would time the test out.
  api.intercept((request) => request.path === '/v1/agents/sessions', () => new Response(null, { status: 429, headers: { 'retry-after': '60', 'retry-after-ms': '1' } }), 2)
  const events = await createSession(client, start, AbortSignal.timeout(5_000))
  events.controller.abort()
  assert.equal(api.creates().length, 3)
  assert.equal(new Set(api.creates().map((request) => request.text)).size, 1)
  assert.deepEqual(api.creates()[2].body.agent.ampersand, { allow_silent_completion: true }, 'Ampersand extensions reach the wire')
  assert.deepEqual(api.creates()[2].body.input[0].metadata.id, 'message-1')
  assert.deepEqual(api.creates()[2].body.metadata, { fx0_config: 'a'.repeat(64) })

  const exhausted = harness()
  exhausted.api.intercept((request) => request.path === '/v1/agents/sessions', () => new Response(null, { status: 429, headers: { 'retry-after': '0' } }), Infinity)
  await assert.rejects(createSession(exhausted.client, start, AbortSignal.timeout(5_000)), { message: 'Ampersand API request failed (HTTP 429) [create]' })
  assert.equal(exhausted.api.creates().length, 6)

  for (const status of [500, 503, 408]) {
    const failing = harness()
    failing.api.intercept((request) => request.path === '/v1/agents/sessions', () => new Response(null, { status, headers: { 'retry-after-ms': '0' } }), Infinity)
    await assert.rejects(createSession(failing.client, start, AbortSignal.timeout(5_000)), { message: `Ampersand API request failed (HTTP ${status}) [create]` })
    assert.equal(failing.api.creates().length, 1, `HTTP ${status} might have created a session, so it is not retried`)
  }

  // Event posts are idempotent, so they ride out a run of rate limits with the same key and body.
  const posts = harness()
  posts.api.intercept((request) => request.method === 'POST', () => Response.json({ error: { message: 'slow down' } }, { status: 429, headers: { 'retry-after-ms': '0' } }), 4)
  posts.api.intercept((request) => request.method === 'POST', () => new Response(null, { status: 202 }))
  await postEvents(posts.client, 'sess_x', [{ type: 'agent.session.input.message', input }], 'fx0-stable-key', AbortSignal.timeout(5_000))
  assert.deepEqual(posts.api.requests.map((request) => request.headers.get('idempotency-key')), Array(5).fill('fx0-stable-key'))
  assert.equal(new Set(posts.api.requests.map((request) => request.text)).size, 1)
})

test('a cancel or delete is one bounded, best-effort attempt that is never retried', { timeout: 10_000 }, async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const limited = harness()
  limited.api.intercept(() => true, () => new Response(null, { status: 429, headers: { 'retry-after-ms': '0' } }), Infinity)
  assert.equal(await cancelSession(limited.client, 'sess_x'), false)
  assert.deepEqual(limited.api.requests.map((request) => request.body), [{ events: [{ type: 'agent.session.input.cancel' }] }])
  assert.deepEqual(warn.mock.calls[0].arguments, ['[fx0] collab cancel skipped', { name: 'RateLimitError' }])

  const { api, client } = harness()
  // Never answers: each request fails only when its own abort signal fires, as a stalled connection would.
  api.intercept(() => true, (request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
  }), Infinity)
  const started = Date.now()
  assert.deepEqual(await Promise.all([cancelSession(client, 'sess_x'), deleteSession(client, 'sess_y')]), [false, false])
  assert.ok(Date.now() - started < 5_000, 'neither waits for the client\'s default timeout')
  assert.deepEqual(api.requests.map((request) => request.method).sort(), ['DELETE', 'POST'], 'each is one attempt')
  assert.deepEqual(warn.mock.calls.slice(1).map((call) => call.arguments[0]).sort(), ['[fx0] collab cancel skipped', '[fx0] collab session delete skipped'])
})

test('a delete reports success, and a session that is already gone counts as deleted', async () => {
  const { api, client } = harness()
  const session = api.seedSession('Builder', 'idle')
  assert.equal(await deleteSession(client, session.id), true)
  assert.equal(api.sessions.get(session.id).deleted, true)
  assert.equal(await deleteSession(client, 'sess_never_existed'), true)
})

test('room errors are redacted before they are capped', () => {
  const key = 'collab-test-key'
  assert.equal(redactedErrorMessage(new Error(`failed for ${key} with Bearer abc.def`), key), 'failed for [redacted] with Bearer [redacted]')
  assert.equal(redactedErrorMessage(new Error(`token ${'a'.repeat(40)} leaked\0`), key), 'token [redacted] leaked')
  assert.equal(redactedErrorMessage(new Error(key), key), '[redacted]')
  for (const blank of [new Error('  '), new Error('\0'), 'not an error', undefined]) {
    assert.equal(redactedErrorMessage(blank, key), 'Ampersand could not finish this turn.')
  }
  // A key straddling the cap must not leave a prefix behind.
  const straddling = redactedErrorMessage(new Error('x '.repeat((MAX_ERROR_LENGTH - 4) / 2) + key), key)
  assert.equal(straddling.length, MAX_ERROR_LENGTH)
  assert.ok(!straddling.includes(key.slice(0, 4)))
  assert.equal(redactedErrorMessage(new Error(`no key configured ${key}`), undefined), `no key configured ${key}`)
})
