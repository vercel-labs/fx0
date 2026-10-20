import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The agent's fetch with the real Gateway transport; libfx, the journal and the
// credential store are replaced, and the network is a stub.
const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`
const forward = (root, names) => names.map((name) =>
  `export const ${name} = (...args) => globalThis.__fx0Agent.${root}.${name}(...args)`).join('\n')
const fakes = {
  libfx: dataUrl(forward('libfx', ['createFxAgent', 'createFxEngine'])),
  './journal': dataUrl(forward('journal', ['appendEvent', 'bindLibfxSession', 'chatOfLibfxSession', 'getActiveTurn'])),
  './draft-store': dataUrl(forward('drafts', ['storedDraftObserver','closeDraftCall'])),
  './turn-credential': dataUrl(forward('credentials', ['readTurnCredential', 'readExecutionFunding'])),
  './turn-budget': dataUrl(forward('budget', ['turnBudget'])),
}
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/lib/')) {
    if (fakes[specifier]) return { url: fakes[specifier], shortCircuit: true }
    if (specifier.startsWith('./') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context)
  }
  return next(specifier, context)
} })
const { durableAgent, modelStepName, runSubagent, turnModelStep, STEP_LIMIT, SIGN_IN_AGAIN } = await import('../lib/libfx-agent.ts')
const { MAX_TURN_MODEL_STEPS } = await import('../lib/session.ts')

const MODEL_URL = 'https://ai-gateway.vercel.sh/v3/ai/language-model'
const stored = new Map()
const executions = new Map()
// Each turn's step names, as tests/turn-budget.integration.mjs checks the real script keeps them.
const turnSteps = new Map()
let agentOptions = null
globalThis.__fx0Agent = {
  libfx: { createFxAgent: (options) => { agentOptions = options; return {} }, createFxEngine: async () => ({}) },
  budget: {
    turnBudget: () => ({
      async reserve(chatId, turnId, step) {
        const key = `${chatId}:${turnId}`
        if (!turnSteps.has(key)) turnSteps.set(key, new Set())
        return turnSteps.get(key).add(step).size
      },
    }),
  },
  journal: {
    chatOfLibfxSession: async (id) => ({ wrun_a: 'chat-a', wrun_b: 'chat-b', wrun_c: 'chat-c' })[id] ?? null,
    bindLibfxSession: async (_chat, id) => id,
    emitLive: () => {},
    getActiveTurn: async () => null,
    appendEvent: async () => { throw new Error('the fetch writes no transcript') },
  },
  credentials: {
    readTurnCredential: async (chatId) => stored.get(chatId) ?? null,
    readExecutionFunding: async (chatId, turnId) => {
      const credential = executions.has(chatId) ? executions.get(chatId).get(turnId) ?? null : stored.get(chatId) ?? null
      return credential ? { ok: true, credential } : { ok: false, refused: executions.has(chatId) ? 'unbound-turn' : 'unusable' }
    },
  },
  drafts: { storedDraftObserver: async () => undefined, closeDraftCall: async () => {} },
}
durableAgent({ toolHost: async () => { throw new Error('no tools here') } }, 'instructions')
const agentFetch = agentOptions.fetch

test('a recovered sponsored chat uses its recorded trial funding instead of requiring a customer card', async (t) => {
  const previous = { key: process.env.AI_GATEWAY_API_KEY, enabled: process.env.FX0_FREE_PROMPTS }
  process.env.AI_GATEWAY_API_KEY = 'synthetic-server-key'
  process.env.FX0_FREE_PROMPTS = '1'
  t.after(() => {
    if (previous.key === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous.key
    if (previous.enabled === undefined) delete process.env.FX0_FREE_PROMPTS; else process.env.FX0_FREE_PROMPTS = previous.enabled
  })
  const trial = { kind: 'trial', userId: 'guest:owner', loginId: 'guest-login', expiresAt: Date.now() + 3600_000 }
  executions.set('chat-a', new Map([[11, trial], [12, credential('later-paid-token')]]))
  stored.set('chat-a', credential('later-paid-token'))
  t.after(() => executions.clear())
  agentOptions.hooks?.onEvent({ type: 'journal.restore', sessionId: 'wrun_a', data: { resumable: true, openTurnId: 'm11' } })
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push([init.headers.get('authorization'), init.headers.get('x-vercel-ai-gateway-team')])
    return Response.json({})
  })
  const response = await agentFetch(MODEL_URL, { method: 'POST', headers: { 'x-session-id': 'wrun_a', 'ai-language-model-id': 'anthropic/claude-opus-5.5-fast' }, body: JSON.stringify({ prompt: [] }) })
  assert.equal(response.status, 200)
  assert.deepEqual(seen, [['Bearer synthetic-server-key', null]])
  agentOptions.onEvent({ type: 'acp.send', message: { method: 'session/prompt', params: { sessionId: 'wrun_a', _meta: { fx: { turnId: 'm12' } } } } })
  assert.equal((await modelRequest('wrun_a')).status, 200)
  assert.deepEqual(seen[1], ['Bearer later-paid-token', 'team_a'])
})

test('missing or expired execution funding cannot use a later paid credential', async (t) => {
  stored.set('chat-a', credential('later-paid-token'))
  executions.set('chat-a', new Map([[21, { ...credential('expired-token'), expiresAt: Date.now() - 1 }]]))
  t.after(() => executions.clear())
  const network = t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  const logged = t.mock.method(console, 'info', () => {})
  for (const turnId of [21, 22]) {
    agentOptions.hooks?.onEvent({ type: 'journal.restore', sessionId: 'wrun_a', data: { resumable: true, openTurnId: `m${turnId}` } })
    assert.equal((await modelRequest('wrun_a')).status, 401)
  }
  assert.equal(network.mock.callCount(), 0)
  // Only the refusal is logged, with its turn and reason and no credential.
  const refusals = logged.mock.calls.map((call) => JSON.parse(call.arguments[0])).filter((line) => line.event === 'funding:refused')
  assert.deepEqual(refusals.map(({ session, turn, reason }) => [session, turn, reason]), [['chat-a', 22, 'unbound-turn']])
  assert.ok(!logged.mock.calls.some((call) => call.arguments[0].includes('token')))
})

test('the executing turn is captured before an asynchronous chat lookup', async (t) => {
  let resolveChat
  t.mock.method(globalThis.__fx0Agent.journal, 'chatOfLibfxSession', () => new Promise(resolve => { resolveChat = resolve }))
  executions.set('snapshot-chat', new Map([[31, credential('original-turn')], [32, credential('queued-turn')]]))
  t.after(() => executions.clear())
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push(init.headers.get('authorization'))
    return Response.json({})
  })
  const restore = id => agentOptions.hooks.onEvent({ type: 'journal.restore', sessionId: 'wrun_snapshot', data: { resumable: true, openTurnId: `m${id}` } })
  restore(31)
  const response = modelRequest('wrun_snapshot')
  restore(32)
  resolveChat('snapshot-chat')
  assert.equal((await response).status, 200)
  assert.deepEqual(seen, ['Bearer original-turn'])
})

test('a subagent keeps its parent turn funding after a paid continuation is queued', async (t) => {
  const previous = { key: process.env.AI_GATEWAY_API_KEY, enabled: process.env.FX0_FREE_PROMPTS }
  process.env.AI_GATEWAY_API_KEY = 'synthetic-server-key'
  process.env.FX0_FREE_PROMPTS = '1'
  t.after(() => {
    if (previous.key === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous.key
    if (previous.enabled === undefined) delete process.env.FX0_FREE_PROMPTS; else process.env.FX0_FREE_PROMPTS = previous.enabled
    executions.clear()
  })
  stored.set('child-chat', credential('later-paid-token'))
  executions.set('child-chat', new Map([[41, { kind: 'trial', userId: 'guest:owner', loginId: 'guest-login', expiresAt: Date.now() + 3600_000 }]]))
  t.mock.method(globalThis.__fx0Agent.libfx, 'createFxEngine', async options => ({
    prompt: () => {
      const result = options.fetch(MODEL_URL, { method: 'POST', headers: { 'ai-language-model-id': options.model.id }, body: '{}' })
        .then(response => { assert.equal(response.status, 200); return { stopReason: 'end_turn' } })
      return { result, async *[Symbol.asyncIterator]() { await result; yield { type: 'text_delta', delta: 'Child done.' } } }
    },
    close: async () => {},
  }))
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push([init.headers.get('authorization'), init.headers.get('x-vercel-ai-gateway-team')])
    return Response.json({})
  })
  const result = await runSubagent({ toolHost: async () => ({}) }, { id: 'child-chat' }, 41, 'instructions', 'task', new AbortController().signal)
  assert.equal(result, 'Child done.')
  assert.deepEqual(seen, [['Bearer synthetic-server-key', null]])
})

function credential(accessToken, teamId = 'team_a') {
  return { userId: 'user-a', loginId: 'login-a', accessToken, teamId, expiresAt: Date.now() + 3_600_000 }
}

function modelRequest(sessionId, prompt = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]) {
  return agentFetch(MODEL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
    body: Buffer.from(JSON.stringify({ prompt })),
  })
}

test('each chat\'s model requests bill the credential stored for that chat', async (t) => {
  stored.set('chat-a', credential('token-a', 'team_a'))
  stored.set('chat-b', credential('token-b', 'team_b'))
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const headers = new Headers(init.headers)
    seen.push([headers.get('authorization'), headers.get('x-vercel-ai-gateway-team')])
    return Response.json({})
  })
  assert.equal((await modelRequest('wrun_a')).status, 200)
  assert.equal((await modelRequest('wrun_b')).status, 200)
  assert.deepEqual(seen, [['Bearer token-a', 'team_a'], ['Bearer token-b', 'team_b']])
  assert.equal(agentOptions.apiKey, 'session-authenticated')
})

test('a request with no chat or no stored credential fails closed and never reaches the network', async (t) => {
  stored.clear()
  const network = t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  for (const sessionId of ['wrun_a', 'wrun_unknown']) {
    const response = await modelRequest(sessionId)
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.message, SIGN_IN_AGAIN)
  }
  stored.set('chat-a', { ...credential('token-a'), expiresAt: Date.now() + 5_000 })
  assert.equal((await modelRequest('wrun_a')).status, 401, 'a credential about to expire is not used')
  assert.equal(network.mock.callCount(), 0)
})

test('the request after a turn\'s 64th model step stops with the step limit, before the network', async (t) => {
  stored.set('chat-a', credential('token-a'))
  const network = t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  const step = (count) => [
    { role: 'system', content: 'x' },
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ...Array.from({ length: count }, () => [{ role: 'assistant', content: [] }, { role: 'tool', content: [] }]).flat(),
  ]
  assert.equal((await modelRequest('wrun_a', step(MAX_TURN_MODEL_STEPS - 1))).status, 200)
  const limited = await modelRequest('wrun_a', step(MAX_TURN_MODEL_STEPS))
  assert.equal(limited.status, 400)
  assert.equal((await limited.json()).error.message, STEP_LIMIT)
  assert.equal(network.mock.callCount(), 1)
})

test('the step limit holds for every form a request body can take, and for one that cannot be read', async (t) => {
  t.after(() => turnSteps.clear())
  const network = t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  const conversation = (count) => [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ...Array.from({ length: count }, () => [{ role: 'assistant', content: [] }, { role: 'tool', content: [] }]).flat(),
  ]
  const forms = {
    string: (json) => json,
    buffer: (json) => Buffer.from(json),
    uint8array: (json) => new Uint8Array(Buffer.from(json)),
    arraybuffer: (json) => new Uint8Array(Buffer.from(json)).buffer,
  }
  let turn = 600
  for (const [form, encode] of Object.entries(forms)) {
    stored.set('chat-a', credential('token-a'))
    agentOptions.hooks?.onEvent({ type: 'journal.restore', sessionId: 'wrun_a', data: { resumable: true, openTurnId: `m${++turn}` } })
    const over = await agentFetch(MODEL_URL, { method: 'POST', headers: { 'x-session-id': 'wrun_a' }, body: encode(JSON.stringify({ prompt: conversation(MAX_TURN_MODEL_STEPS) })) })
    assert.equal(over.status, 400, `${form}: a conversation past the limit is refused`)
    const statuses = []
    for (let step = 0; step < MAX_TURN_MODEL_STEPS + 6; step++) {
      const prompt = [...conversation(1), { role: 'user', content: [{ type: 'text', text: `steer ${step}` }] }]
      statuses.push((await agentFetch(MODEL_URL, { method: 'POST', headers: { 'x-session-id': 'wrun_a' }, body: encode(JSON.stringify({ prompt })) })).status)
    }
    assert.equal(statuses.filter((status) => status === 200).length, MAX_TURN_MODEL_STEPS, `${form}: exactly 64 steps of one turn are allowed`)
    assert.deepEqual(statuses.slice(MAX_TURN_MODEL_STEPS), Array(6).fill(400), `${form}: the rest are refused`)
  }
  stored.set('chat-a', credential('token-a'))
  agentOptions.hooks?.onEvent({ type: 'journal.restore', sessionId: 'wrun_a', data: { resumable: true, openTurnId: `m${++turn}` } })
  const unreadable = []
  for (let step = 0; step < MAX_TURN_MODEL_STEPS + 3; step++) {
    unreadable.push((await agentFetch(MODEL_URL, { method: 'POST', headers: { 'x-session-id': 'wrun_a' }, body: Buffer.from('not json') })).status)
  }
  assert.equal(unreadable.filter((status) => status === 200).length, MAX_TURN_MODEL_STEPS)
  assert.deepEqual(unreadable.slice(MAX_TURN_MODEL_STEPS), [400, 400, 400])
  assert.ok(network.mock.callCount() > 0)
})

test('public model metadata goes out without a credential, even with no session', async (t) => {
  stored.clear()
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), new Headers(init?.headers).get('authorization')])
    return Response.json({ data: [] })
  })
  const response = await agentFetch('https://ai-gateway.vercel.sh/coding-agent/v1/models', { method: 'GET' })
  assert.equal(response.status, 200)
  assert.deepEqual(seen, [['https://ai-gateway.vercel.sh/coding-agent/v1/models', null]])
})

test('a turn\'s step is the assistant messages since the last user message, plus one', () => {
  assert.equal(turnModelStep({ prompt: [{ role: 'user' }] }), 1)
  assert.equal(turnModelStep({ prompt: [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: 'assistant' }, { role: 'tool' }] }), 3)
  assert.equal(turnModelStep({ prompt: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }] }), 2)
  assert.equal(turnModelStep({}), 1)
})

test('Gateway\'s own reason survives a rejection, scrubbed of the credential', async (t) => {
  stored.set('chat-a', credential('token-secret-a'))
  t.mock.method(globalThis, 'fetch', async () => Response.json(
    { error: { type: 'insufficient_credits', message: 'Add credits for token-secret-a' } }, { status: 402 }))
  const response = await modelRequest('wrun_a')
  assert.equal(response.status, 402)
  const { error } = await response.json()
  assert.equal(error.type, 'insufficient_credits')
  assert.ok(!error.message.includes('token-secret-a'))
})

test('a model request is named by its sender and conversation, so only a resend shares a name', () => {
  const body = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] }
  assert.equal(modelStepName('parent', body), modelStepName('parent', JSON.parse(JSON.stringify(body))))
  assert.notEqual(modelStepName('parent', body), modelStepName('subagent:a', body))
  assert.notEqual(modelStepName('parent', body), modelStepName('parent', { prompt: [...body.prompt, { role: 'assistant', content: [] }] }))
  // Compaction can shorten a conversation to a length seen before; its content differs.
  assert.notEqual(modelStepName('parent', { prompt: [{ role: 'user', content: 'summary' }] }), modelStepName('parent', { prompt: [{ role: 'user', content: 'go' }] }))
  assert.notEqual(modelStepName('parent', {}), modelStepName('parent', null))
  assert.match(modelStepName('parent', null), /^parent:unread:/)
  assert.match(modelStepName('parent', body), /^parent:[A-Za-z0-9_-]{22}$/)
})

test('a turn\'s subagents spend its 64 model requests with it, and a retried request counts once', async (t) => {
  stored.set('chat-c', credential('token-c'))
  t.after(() => { stored.delete('chat-c'); turnSteps.clear() })
  agentOptions.onEvent({ type: 'acp.send', message: { method: 'session/prompt', params: { sessionId: 'wrun_c', _meta: { fx: { turnId: 'm51' } } } } })
  const network = t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  // Each step's conversation is the last one plus the model's reply and its tool's result.
  const conversation = (steps, text = 'go') => [
    { role: 'user', content: [{ type: 'text', text }] },
    ...Array.from({ length: steps }, (_, i) => [{ role: 'assistant', content: [{ type: 'text', text: `step ${i}` }] }, { role: 'tool', content: [] }]).flat(),
  ]
  for (let step = 0; step < 40; step++) assert.equal((await modelRequest('wrun_c', conversation(step))).status, 200, `parent step ${step + 1}`)
  // libfx retrying a step, or resending it after a crash, sends the same conversation.
  for (let retry = 0; retry < 3; retry++) assert.equal((await modelRequest('wrun_c', conversation(39))).status, 200)
  assert.equal(turnSteps.get('chat-c:51').size, 40)

  // Subagents of the same turn, each running its own conversation until refused.
  const runs = []
  t.mock.method(globalThis.__fx0Agent.libfx, 'createFxEngine', async (options) => ({
    prompt: () => {
      const result = (async () => {
        const statuses = []
        for (let step = 0; step < 30; step++) {
          const response = await options.fetch(MODEL_URL, { method: 'POST', headers: { 'ai-language-model-id': options.model.id }, body: Buffer.from(JSON.stringify({ prompt: conversation(step, 'subtask') })) })
          statuses.push(response.status)
          if (response.status !== 200) break
        }
        runs.push(statuses)
        return { stopReason: 'end_turn' }
      })()
      return { result, async *[Symbol.asyncIterator]() { await result; yield { type: 'text_delta', delta: 'Child done.' } } }
    },
    close: async () => {},
  }))
  const subagent = () => runSubagent({ toolHost: async () => ({}) }, { id: 'chat-c' }, 51, 'instructions', 'task', new AbortController().signal)
  await subagent()
  await subagent()
  // The first takes the 24 requests left; a second run's same conversations are its own, and none are left.
  assert.deepEqual(runs.map((statuses) => [statuses.filter((status) => status === 200).length, statuses.at(-1)]), [[24, 400], [0, 400]])
  const parent = await modelRequest('wrun_c', conversation(40))
  assert.equal(parent.status, 400)
  assert.equal((await parent.json()).error.message, STEP_LIMIT)
  assert.equal(network.mock.callCount(), 40 + 3 + 24, 'nothing past the limit reaches the network')
})
