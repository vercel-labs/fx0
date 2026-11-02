import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Runtime tests replace external boundaries only: libfx, the Redis journal, the
// sealed credential store, Neon history and Gateway auth. Journal Lua has its
// own integration test; the agent's fetch has tests/libfx-agent.test.mjs.
const journalNames = [
  'answerActiveQuestion', 'appendEvent', 'bindLibfxSession', 'chatOfLibfxSession', 'claimSessionCleanup',
  'awaitCapture', 'clearActiveQuestion', 'closeCapture', 'currentSeq', 'emitLive', 'finishDesignAssetCleanup',
  'finishSessionCleanup', 'finishTurnWork', 'getActiveQuestion', 'getActiveTurn', 'nextQuestionId', 'openCapture',
  'pendingDesignAssetCleanups', 'projectEvents', 'projectedCursor', 'publishDesignArtifact',
  'queueDesignAssetCleanup', 'readDesignArtifact', 'readDesignAssets', 'readDesignMd', 'readEvents',
  'readPreviewWaits', 'readSession', 'readSessionView', 'readTurnWork', 'recordDesignAssets', 'recordPreviewWait',
  'releaseDesignAssets', 'releaseSessionCleanup', 'renewSessionCleanup', 'reserveDesignAssets',
  'setActiveQuestion', 'submitPrompt', 'takeAnswer', 'updateSession',
]
const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`
const forward = (root, names) => names.map((name) =>
  `export const ${name} = (...args) => globalThis.__fx0Runtime.${root}.${name}(...args)`).join('\n')
const journalUrl = dataUrl(`export class SessionCleanupError extends Error {}\nexport const QUESTION_WAIT_MS = 600000\nexport const MAX_CHAT_ASSETS = 50\nexport const MAX_DAILY_ASSETS = 100\n` + forward('journal', journalNames))
const libfxUrl = dataUrl(forward('libfx', ['createFxAgent', 'createFxEngine']))
const credentialUrl = dataUrl(forward('credentialStore', ['saveTurnCredential', 'saveTrialCredential', 'renewLatestCredential', 'readTurnCredential', 'readExecutionFunding', 'dropLoginCredentials', 'dropChatCredential']))
const historyUrl = dataUrl(forward('history', ['recordTurn', 'recordGeneration']))
const gatewayUrl = dataUrl(`import { AuthError } from ${JSON.stringify(new URL('../lib/accounts.ts', import.meta.url).href)}
export const RATE_LIMIT_ATTEMPTS = 3
export const assertGenerationCredential = (host) => {
  if (!host.gatewaySession) throw new AuthError(401, 'authentication required')
  if (globalThis.__fx0Runtime.needsRenewal) throw new AuthError(503, 'Authentication needs renewal; retry shortly')
}
export const gatewayFetch = () => async () => Response.json({})`)
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/lib/') && !context.parentURL.includes('/node_modules/')) {
    const fake = { libfx: libfxUrl, './journal': journalUrl, './turn-credential': credentialUrl, './history': historyUrl, './gateway-session': gatewayUrl }[specifier]
    if (fake) return { url: fake, shortCircuit: true }
    if (specifier.startsWith('./') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context)
  }
  return next(specifier, context)
} })
const { SessionCleanupError } = await import(journalUrl)
const runtime = await import('../lib/agent.ts')
const { getSession, registry } = await import('../lib/session.ts')
const projector = await import('../lib/projector.ts')

const encoder = new TextEncoder()

function credential(userId = 'user-a', loginId = 'login-a', accessToken = 'first-token') {
  return { userId, loginId, loginAt: 1, accessToken, teamId: 'team_a', email: 'test@example.com', expiresAt: Date.now() + 3_600_000, isLoggedIn: true }
}

// A fake libfx session log: lines appended by the test, read by stream(cursor)
// the way libfx serves them (each line carries the cursor after it).
function sessionLog() {
  const lines = []
  const waiters = new Set()
  return {
    lines,
    push(line) { lines.push(line); for (const wake of waiters) wake(); waiters.clear() },
    stream(cursor = 0) {
      let next = cursor
      let cancelled = false
      return new ReadableStream({
        async pull(controller) {
          while (next >= lines.length && !cancelled) await new Promise((resolve) => waiters.add(resolve))
          if (cancelled) return
          next += 1
          controller.enqueue(encoder.encode(`${JSON.stringify({ ...lines[next - 1], cursor: next })}\n`))
        },
        cancel() { cancelled = true; for (const wake of waiters) wake(); waiters.clear() },
      })
    },
  }
}

function fixture(t, stored = { preferredModel: null, preferredEffort: null, preferredFast: null, designMd: null, libfxSessionId: null }) {
  registry().clear()
  delete globalThis.__fx0LibfxAgent
  const calls = []
  const events = []
  const logs = new Map()
  const credentials = new Map()
  const executionCredentials = new Map()
  // `${chatId}:${turnId}` -> who funded the turn; sign-out keeps these.
  const fundings = new Map()
  let active = null
  // Each finished turn's history work, and the design it left, until written.
  const work = new Map()
  const designs = new Map()
  let deleting = false
  let question = null
  let answer = null
  let projected = 0
  let artifactRevision = 0
  let messageSeq = 0
  const state = {
    stored,
    calls, events, logs, credentials, executionCredentials, fundings,
    agentOptions: null,
    engineOptions: [],
    sent: [],
    acceptError: null,
    needsRenewal: false,
    setActive: (value) => { active = value },
    setArtifactRevision: (value) => { artifactRevision = value },
    logOf(id) { if (!logs.has(id)) logs.set(id, sessionLog()); return logs.get(id) },
    journal: {
      ...Object.fromEntries(journalNames.map((name) => [name, async () => null])),
      readSession: async () => state.stored,
      readSessionView: async () => ({ artifactRevision }),
      readDesignArtifact: async () => '<!doctype html><html><head></head><body>old</body></html>',
      readDesignMd: async () => 'Use teal.',
      submitPrompt: async (_id, prompt, _initial, sponsored = false) => {
        if (messageSeq === 0 && sponsored) state.stored = { ...state.stored, trialChat: true }
        const id = ++messageSeq
        // The same idle check as the Lua script: no active turn, and the latest
        // event that isn't a settings notice ends a turn.
        const last = events.slice(-10).filter((item) => !(item.type === 'status' && item.turnId == null)).at(-1)
        const idle = active == null && (!last || last.type === 'done' || (last.type === 'error' && last.turnId != null))
        const event = { type: 'user', id, text: prompt.text, author: prompt.author, seq: events.length + 1 }
        events.push(event)
        return { id, event, idle, trialChat: state.stored?.trialChat === true }
      },
      bindLibfxSession: async (_id, candidate) => {
        if (deleting) throw new SessionCleanupError()
        state.stored = { ...state.stored, libfxSessionId: state.stored?.libfxSessionId ?? candidate }
        return state.stored.libfxSessionId
      },
      appendEvent: async (_id, entry) => { const item = { ...entry, seq: events.length + 1 }; events.push(item); return item },
      publishDesignArtifact: async (...args) => { calls.push(['publish', ...args]); return { ok: true, revision: 2, changed: true } },
      getActiveTurn: async () => active,
      readTurnWork: async () => [...work.values()].map((item) => ({ ...item, ...(designs.has(item.turnId) ? { design: designs.get(item.turnId) } : {}) }))
        .concat([...designs].filter(([turnId]) => !work.has(turnId)).map(([turnId, design]) => ({ turnId, design })))
        .sort((a, b) => a.turnId - b.turnId),
      finishTurnWork: async (_id, turnId) => { work.delete(turnId); designs.delete(turnId) },
      nextQuestionId: async () => 7,
      setActiveQuestion: async (_id, value) => { question = value },
      getActiveQuestion: async () => question,
      answerActiveQuestion: async (_id, qid, answers) => {
        if (question?.qid !== qid) return false
        question = null
        answer = { qid, answers }
        return true
      },
      takeAnswer: async (_id, qid) => {
        if (answer?.qid !== qid) return null
        const taken = answer.answers
        answer = null
        return taken
      },
      clearActiveQuestion: async (_id, qid) => { if (question?.qid !== qid) return false; question = null; return true },
      projectedCursor: async () => projected,
      // The same cursor check and turn bookkeeping as the Lua script; its own
      // behavior against real Redis is tests/turn-work.integration.mjs.
      projectEvents: async (_id, from, to, entries, starts = {}) => {
        if (deleting || projected !== from) return null
        projected = to
        return entries.map((entry) => {
          const item = { ...entry, seq: events.length + 1 }
          events.push(item)
          if (item.type === 'turn_start' && starts[item.id]) active = { ...starts[item.id], startSeq: item.seq }
          else if ((item.type === 'done' || item.type === 'error') && item.id) {
            const turn = active?.id === item.id ? active : undefined
            if (turn) active = null
            work.set(item.id, { turnId: item.id, type: item.type, stopReason: item.stopReason, usage: item.usage, at: item.at, ...(turn ? { turn } : {}) })
            if (state.stored?.artifactTurn === item.id) {
              designs.set(item.id, { revision: artifactRevision, html: '<!doctype html><html><head></head><body>old</body></html>' })
              state.stored = { ...state.stored, artifactTurn: null }
            }
          }
          return item
        })
      },
      readEvents: async (_id, after = 0) => events.filter((item) => item.seq > after),
      updateSession: async (_id, fields) => {
        if (deleting) throw new SessionCleanupError()
        calls.push(['update', fields])
        state.stored = { ...state.stored, ...fields }
      },
      claimSessionCleanup: async (_id, token) => {
        calls.push(['claimCleanup', token])
        if (active) return 'busy'
        deleting = true
        return 'claimed'
      },
      finishSessionCleanup: async (_id, token, libfxSessionId) => {
        calls.push(['finishCleanup', token, libfxSessionId])
        state.stored = null
        return true
      },
      releaseSessionCleanup: async (_id, token) => { calls.push(['releaseCleanup', token]) },
      renewSessionCleanup: async () => true,
    },
    libfx: {
      createFxAgent(options) {
        state.agentOptions = options
        let ids = 0
        return {
          newSessionId: async () => `wrun_${++ids}`,
          session(id, sessionOptions) {
            return {
              steer(input, steerOptions) {
                state.sent.push({ id, input, steerOptions, sessionOptions })
                return state.acceptError ? Promise.reject(state.acceptError) : Promise.resolve({ messageId: steerOptions.messageId })
              },
              prompt(input, promptOptions) {
                state.sent.push({ id, input, promptOptions, sessionOptions })
                return {
                  accepted: state.acceptError ? Promise.reject(state.acceptError) : Promise.resolve({ messageId: promptOptions.messageId }),
                  result: Promise.resolve({ stopReason: 'end_turn' }),
                }
              },
              stream: (cursor) => state.logOf(id).stream(cursor),
              cancel: async () => { calls.push(['cancel', id]) },
            }
          },
          wakeHandler: () => async () => new Response(null),
        }
      },
      async createFxEngine(options) {
        state.engineOptions.push(options)
        return {
          prompt: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'text_delta', delta: 'sub done' } }, result: Promise.resolve({ stopReason: 'end_turn' }) }),
          close: async () => {},
        }
      },
    },
    credentialStore: {
      saveTurnCredential: async (chatId, session, turnId) => {
        credentials.set(chatId, session)
        executionCredentials.set(`${chatId}:${turnId}`, session)
        fundings.set(`${chatId}:${turnId}`, { kind: 'user', userId: session.userId, loginId: session.loginId, teamId: session.teamId })
      },
      saveTrialCredential: async (chatId, credential, turnId) => {
        executionCredentials.set(`${chatId}:${turnId}`, credential)
        fundings.set(`${chatId}:${turnId}`, { kind: 'trial', userId: credential.userId, loginId: credential.loginId })
      },
      renewLatestCredential: async (chatId, session) => { credentials.set(chatId, session) },
      readTurnCredential: async (chatId) => credentials.get(chatId) ?? null,
      readExecutionFunding: async (chatId, turnId) => {
        const credential = executionCredentials.get(`${chatId}:${turnId}`) ?? credentials.get(chatId) ?? null
        return credential ? { ok: true, credential } : { ok: false, refused: 'unusable' }
      },
      dropLoginCredentials: async (loginId) => {
        const chatOf = (key) => key.slice(0, key.lastIndexOf(':'))
        const dropped = []
        for (const chatId of new Set([...credentials.keys(), ...[...fundings.keys()].map(chatOf)])) {
          const latestWasLogin = credentials.get(chatId)?.loginId === loginId
          const turns = [...fundings].filter(([key, funding]) => chatOf(key) === chatId && funding.loginId === loginId)
          if (!latestWasLogin && !turns.length) continue
          if (latestWasLogin) credentials.delete(chatId)
          const deleted = turns.filter(([key]) => executionCredentials.delete(key)).length
          dropped.push({ chatId, turns: deleted, latest: latestWasLogin ? 'deleted' : 'not-this-login' })
        }
        return dropped
      },
      dropChatCredential: async (chatId) => { credentials.delete(chatId); calls.push(['dropCredential', chatId]) },
    },
    history: {
      recordTurn: async (turn) => { calls.push(['history', turn]); return true },
      recordGeneration: async (...args) => { calls.push(['generation', ...args]); return true },
    },
  }
  globalThis.__fx0Runtime = state
  t.mock.method(console, 'info', () => {})
  return state
}

function boundHost(id, session = credential()) {
  const host = getSession(id)
  host.gatewaySession = session
  return host
}

async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

// How fx0 handed a message to libfx: prompt() runs it in the request, steer() queues it.
const sendKind = (message) => (message.promptOptions ? 'prompt' : 'steer')
const messageIdOf = (message) => (message.promptOptions ?? message.steerOptions).messageId

test('trial-chat inputs each keep their admission funding and cannot steer into a different billing mode', async (t) => {
  const f = fixture(t)
  const host = boundHost('mixed-funding')
  const free = { kind: 'trial', userId: host.gatewaySession.userId, loginId: host.gatewaySession.loginId, expiresAt: Date.now() + 86400000 }
  await runtime.submitPrompt(host, 'Ada', 'Free design', 'free-1', undefined, undefined, undefined, free)
  await runtime.submitPrompt(host, 'Ada', 'Paid follow-up', 'paid-2')
  assert.deepEqual(f.sent.map(sendKind), ['prompt', 'prompt'])
  assert.equal(f.executionCredentials.get('mixed-funding:1').kind, 'trial')
  assert.equal(f.executionCredentials.get('mixed-funding:2').accessToken, host.gatewaySession.accessToken)
  assert.equal(f.executionCredentials.get('mixed-funding:1').accessToken, undefined)
})

test('an awaiting admission cannot pick up another request\'s later credential binding', async (t) => {
  const f = fixture(t)
  const host = boundHost('binding-race')
  const sender = host.gatewaySession
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const original = f.journal.submitPrompt
  f.journal.submitPrompt = async (...args) => { const result = await original(...args); await barrier; return result }
  const pending = runtime.submitPrompt(host, 'Ada', 'First')
  host.gatewaySession = { ...credential('user-a', 'later-login', 'later-token'), teamId: 'team_later' }
  release()
  await pending
  assert.equal(f.credentials.get('binding-race').accessToken, sender.accessToken)
  assert.equal(f.credentials.get('binding-race').teamId, sender.teamId)
})

test('the route\'s explicit sender survives another request rebinding the host before submission', async (t) => {
  const f = fixture(t)
  const sender = credential('user-a', 'original-login', 'original-token')
  const host = boundHost('before-submit-race', credential('user-a', 'later-login', 'later-token'))
  await runtime.submitPrompt(host, 'Ada', 'First', undefined, undefined, undefined, undefined, undefined, sender)
  assert.equal(f.credentials.get('before-submit-race').accessToken, sender.accessToken)
  assert.equal(f.credentials.get('before-submit-race').loginId, sender.loginId)
})

test('every paid message is pinned to the turn it starts, in a paid-only chat too', async (t) => {
  const f = fixture(t)
  const host = boundHost('paid-chat', credential('user-a', 'login-laptop', 'laptop-token'))
  await runtime.submitPrompt(host, 'Ada', 'Long design')
  // Another team's image prompt queues behind the running turn.
  const phone = { ...credential('user-a', 'login-phone', 'phone-token'), teamId: 'team_b' }
  await runtime.submitPrompt(host, 'Ada', 'Use this', undefined, [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }], undefined, undefined, undefined, phone)
  assert.notEqual(f.stored?.trialChat, true)
  assert.deepEqual([...f.fundings], [
    ['paid-chat:1', { kind: 'user', userId: 'user-a', loginId: 'login-laptop', teamId: 'team_a' }],
    ['paid-chat:2', { kind: 'user', userId: 'user-a', loginId: 'login-phone', teamId: 'team_b' }],
  ])
  assert.equal(f.executionCredentials.get('paid-chat:1').accessToken, 'laptop-token')
})

// Keep these tests sequential: each fixture owns the fake external boundaries.
test('a prompt goes to the chat\'s one libfx session with its message id, settings and context', async (t) => {
  const f = fixture(t)
  const host = boundHost('prompt-chat')
  await runtime.submitPrompt(host, 'Ada', 'Design a page')
  f.stored = { ...f.stored, preferredModel: 'test/other', preferredEffort: 'high', preferredFast: true }
  await runtime.submitPrompt(host, 'Ada', 'Again')

  // The first message finds the chat idle; the second arrives while the first waits.
  assert.deepEqual(f.sent.map((message) => [message.id, message.input, sendKind(message), messageIdOf(message)]), [
    ['wrun_1', '[Ada] Design a page', 'prompt', 'm1'],
    ['wrun_1', '[Ada] Again', 'steer', 'm2'],
  ])
  assert.deepEqual(f.sent[0].sessionOptions.context, { chatId: 'prompt-chat', turnId: 1 })
  assert.deepEqual(f.sent[1].sessionOptions.model, { id: 'test/other', effort: 'high', fast: true })
  assert.equal(f.credentials.get('prompt-chat').accessToken, 'first-token', 'the sender\'s credential bills the turn')
  assert.equal(f.agentOptions.apiKey, 'session-authenticated', 'never the deployment\'s key')
})

test('a message to an idle chat is a prompt; one sent while a turn runs or waits steers it', async (t) => {
  const f = fixture(t)
  const host = boundHost('idle-chat')
  const record = (item) => f.events.push({ ...item, seq: f.events.length + 1 })

  await runtime.submitPrompt(host, 'Ada', 'One') // empty chat
  await runtime.submitPrompt(host, 'Ada', 'Two') // One has not started yet
  f.setActive({ id: 1, startedAt: 1, billingTeamId: null, prompt: 'One', startSeq: 1 })
  await runtime.submitPrompt(host, 'Ada', 'Three') // One is running
  f.setActive(null)
  record({ type: 'done', id: 1, turnId: 1, stopReason: 'end_turn' })
  await runtime.submitPrompt(host, 'Ada', 'Four') // One ended
  record({ type: 'done', id: 4, turnId: 4, stopReason: 'end_turn' })
  record({ type: 'status', text: 'model set to test/other' })
  await runtime.submitPrompt(host, 'Ada', 'Five') // a settings notice since the end
  record({ type: 'error', id: 5, turnId: 5, text: 'This message did not finish. Resend to retry.' })
  await runtime.submitPrompt(host, 'Ada', 'Six') // Five failed
  record({ type: 'text', id: 6, turnId: 6, delta: 'Hel' })
  await runtime.submitPrompt(host, 'Ada', 'Seven') // Six is streaming, not yet marked active

  assert.deepEqual(f.sent.map((message) => [messageIdOf(message), sendKind(message)]), [
    ['m1', 'prompt'], ['m2', 'steer'], ['m3', 'steer'], ['m4', 'prompt'], ['m5', 'prompt'], ['m6', 'prompt'], ['m7', 'steer'],
  ])
})

test('a chat started with a DESIGN.md carries it in the instructions of every prompt', async (t) => {
  const f = fixture(t, { designMd: { name: 'Teal', source: 'upload', sha: 'abc', bytes: 9 }, libfxSessionId: null })
  await runtime.submitPrompt(boundHost('design-chat'), 'Ada', 'Design a page')
  assert.match(f.sent[0].sessionOptions.instructions, /<design_md>\nUse teal\.\n<\/design_md>/)
})

test('the instructions make the agent screenshot its design when implementing or replicating one', async (t) => {
  const f = fixture(t)
  await runtime.submitPrompt(boundHost('reference-chat'), 'Ada', 'Reimplement this exactly')
  const { instructions } = f.sent[0].sessionOptions
  assert.match(instructions, /asks to implement, replicate, recreate, clone, or match a design, page, or site, whether from an attached image, a URL, or a description, or asks for an exact copy, verify before reporting: after publishing, call screenshot_design/)
  assert.match(instructions, /at the width the reference was made at when there is one/)
  assert.match(instructions, /After an edit that changes size, alignment, spacing, layout, or cropping, including a fix the user asked for after looking, call screenshot_design after the edit/)
  assert.match(instructions, /A screenshot taken before the edit does not verify it\./)
  const tool = f.agentOptions.tools.find((candidate) => candidate.name === 'screenshot_design')
  assert.match(tool.description, /asks to implement, replicate, or match a design, page, or site \(from an image, a URL, or a description\)/)
})

test('image messages use prompt admission and retain their images, identity and chat context', async (t) => {
  const f = fixture(t)
  const host = boundHost('image-chat')
  const images = [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }]
  await runtime.submitPrompt(host, 'Ada', 'Use this reference', 'client-image', images)
  await runtime.submitPrompt(host, 'Ada', 'Make it blue')

  assert.deepEqual(f.sent[0].input, [{ type: 'text', text: '[Ada] Use this reference' }, ...images])
  assert.deepEqual(f.sent[0].promptOptions, { messageId: 'm1' })
  assert.equal(f.sent[0].steerOptions, undefined)
  assert.deepEqual(f.sent[0].sessionOptions.context, { chatId: 'image-chat', turnId: 1 })
  assert.equal(f.sent[1].id, f.sent[0].id)
  assert.deepEqual(f.sent[1].steerOptions, { messageId: 'm2' })
})

test('an image prompt rejected during admission produces a visible error', async (t) => {
  const f = fixture(t)
  f.acceptError = new Error('image admission failed')
  await runtime.submitPrompt(boundHost('image-error'), 'Ada', '', undefined, [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }])
  assert.deepEqual(f.sent[0].promptOptions, { messageId: 'm1' })
  assert.ok(f.events.some(item => item.type === 'error' && item.text === 'prompt rejected: image admission failed'))
})

test('attached images upload while libfx admits the prompt; the model gets their references at once', async (t) => {
  const f = fixture(t)
  const images = [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }]
  let finishUpload
  const stored = new Promise((resolve) => { finishUpload = resolve })
  const submitted = runtime.submitPrompt(boundHost('asset-chat'), 'Ada', 'Use my logo', undefined, images, undefined, undefined, undefined, undefined,
    { handles: ['AbCdEfGhIjKlMnOpQrStUvWx'], stored })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(f.sent.length, 1, 'libfx has the prompt before the upload finished')
  assert.equal(f.sent[0].input[0].text, '[Ada] Use my logo\n\n[Attached images the design can show: Image #1 = fx0-asset:AbCdEfGhIjKlMnOpQrStUvWx]')
  finishUpload()
  await submitted
  assert.ok(!f.events.some((item) => item.type === 'error'))
  assert.equal(f.calls.filter((call) => call[0] === 'cancel').length, 0)
})

test('if the upload fails after libfx admitted the prompt, the turn is cancelled with a visible error', async (t) => {
  const f = fixture(t)
  const stored = Promise.reject(new Error('Unable to store the attached images'))
  stored.catch(() => {})
  await runtime.submitPrompt(boundHost('asset-fail'), 'Ada', 'Use my logo', undefined, [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }],
    undefined, undefined, undefined, undefined, { handles: ['AbCdEfGhIjKlMnOpQrStUvWx'], stored })
  assert.equal(f.calls.filter((call) => call[0] === 'cancel').length, 1, 'the admitted turn is stopped')
  assert.ok(f.events.some((item) => item.type === 'error' && item.text === 'The attached images could not be stored. Send the message again.'))
})

test('a prompt libfx rejects ends its message with an error, and one needing renewal is refused before any write', async (t) => {
  const f = fixture(t)
  f.acceptError = new Error('input too large')
  const { id } = await runtime.submitPrompt(boundHost('rejected-chat'), 'Ada', 'Design a page')
  await until(() => f.events.some((item) => item.type === 'error'), 'the error item')
  assert.deepEqual(f.events.find((item) => item.type === 'error'), { type: 'error', id, turnId: id, text: 'prompt rejected: input too large', instance: f.events.at(-1).instance, seq: 2 })

  f.needsRenewal = true
  await assert.rejects(runtime.submitPrompt(boundHost('renewal-chat'), 'Ada', 'Design'), /needs renewal/)
  assert.equal(f.sent.length, 1)
})

test('the agent offers HTML and common tools only; a tool runs on the chat its turn names', async (t) => {
  const f = fixture(t)
  runtime.agent()
  const names = f.agentOptions.tools.map((tool) => tool.name)
  assert.deepEqual(names, ['read_design', 'publish_design', 'edit_design', 'screenshot_design', 'web_fetch', 'ask_user_question', 'read_tool_result', 'capability_search', 'subagent', 'web_search'])
  const edit = f.agentOptions.tools.find((tool) => tool.name === 'edit_design')
  assert.equal(edit.idempotent, false)
  assert.equal(edit.writes, true)
  assert.equal(f.agentOptions.tools.find((tool) => tool.name === 'read_design').idempotent, true)
  assert.equal(f.agentOptions.tools.find((tool) => tool.name === 'screenshot_design').idempotent, true)

  const ctx = { signal: new AbortController().signal, executionId: 'call-1', sessionId: 'wrun_1', context: { chatId: 'tool-chat', turnId: 4 } }
  const result = await edit.execute({ edits: [{ old_string: 'old', new_string: 'new' }, { old_string: '<body>', new_string: '<body class="x">' }] }, ctx)
  assert.equal(result.ok, true)
  assert.deepEqual(f.calls.filter((call) => call[0] === 'publish'), [['publish', 'tool-chat', '<!doctype html><html><head></head><body class="x">new</body></html>', 4]])
  await assert.rejects(edit.execute({ edits: [] }, { ...ctx, context: undefined }), /without its chat context/)
})

test('a subagent is an in-memory engine billed to the same chat, without a nested subagent', async (t) => {
  const f = fixture(t)
  runtime.agent()
  const subagent = f.agentOptions.tools.find((tool) => tool.name === 'subagent')
  const ctx = { signal: new AbortController().signal, executionId: 'call-2', sessionId: 'wrun_1', context: { chatId: 'sub-chat', turnId: 3 } }
  assert.match(JSON.stringify(await subagent.execute({ task: 'make a button' }, ctx)), /sub done/)
  assert.equal(f.engineOptions[0].apiKey, 'session-authenticated')
  assert.ok(!f.engineOptions[0].tools.some((tool) => tool.name === 'subagent'))
})

test('ask_user_question waits for the open question\'s answer and rejects answers to any other', async (t) => {
  const f = fixture(t)
  runtime.agent()
  const ask = f.agentOptions.tools.find((tool) => tool.name === 'ask_user_question')
  const ctx = { signal: new AbortController().signal, executionId: 'call-3', sessionId: 'wrun_1', context: { chatId: 'ask-chat', turnId: 2 } }
  const asking = ask.execute({ questions: [{ question: 'Color?', options: [{ label: 'Teal' }, { label: 'Red' }] }] }, ctx)
  await until(() => f.events.some((item) => item.type === 'question'), 'the question')
  const host = getSession('ask-chat')
  assert.equal(await runtime.answerQuestion(host, 99, { 'Color?': 'Red' }), false)
  assert.equal(await runtime.answerQuestion(host, 7, { 'Color?': 'Teal' }), true)
  assert.match(JSON.stringify(await asking), /Teal/)
  assert.deepEqual(f.events.filter((item) => item.type === 'question_resolved').map((item) => [item.qid, item.answers]), [[7, { 'Color?': 'Teal' }]])
  assert.equal(await runtime.answerQuestion(host, 7, { 'Color?': 'Red' }), false, 'an answer is accepted once')

  const controller = new AbortController()
  const cancelled = ask.execute({ questions: [{ question: 'Size?', options: [{ label: 'S' }, { label: 'L' }] }] }, { ...ctx, signal: controller.signal })
  await until(() => f.events.filter((item) => item.type === 'question').length === 2, 'the second question')
  controller.abort()
  await assert.rejects(cancelled, /cancelled/)
  assert.equal(f.events.at(-1).cancelled, true)
})

test('cancel always reaches libfx, even when fx0 has no running turn on record', async (t) => {
  const f = fixture(t, { libfxSessionId: 'wrun_9' })
  const host = boundHost('cancel-chat')
  // No marker: its turn_start may not be projected yet, or the turn outlived the
  // marker's TTL. libfx stops whatever turn is open, and ignores it if none is.
  assert.equal(await runtime.cancelCurrent(host), true)
  f.setActive({ id: 3 })
  assert.equal(await runtime.cancelCurrent(host), true)
  assert.deepEqual(f.calls.filter((call) => call[0] === 'cancel'), [['cancel', 'wrun_9'], ['cancel', 'wrun_9']])
  // A chat no prompt has reached libfx for has nothing to cancel.
  f.stored = { ...f.stored, libfxSessionId: null }
  assert.equal(await runtime.cancelCurrent(host), false)
  assert.equal(f.calls.filter((call) => call[0] === 'cancel').length, 2)
})

test('sign-out drops only this login\'s chat credentials and cancels no turn', async (t) => {
  const f = fixture(t, { libfxSessionId: 'wrun_5' })
  f.credentials.set('laptop-chat', credential('user-a', 'login-laptop'))
  f.credentials.set('phone-chat', credential('user-a', 'login-phone'))
  const laptop = boundHost('laptop-chat', credential('user-a', 'login-laptop'))
  const phone = boundHost('phone-chat', credential('user-a', 'login-phone'))
  f.setActive({ id: 1 })
  await runtime.cancelUserRuntime('user-a', 'login-laptop')
  assert.equal(laptop.gatewaySession, null)
  assert.equal(phone.gatewaySession?.loginId, 'login-phone')
  assert.deepEqual([...f.credentials.keys()], ['phone-chat'])
  assert.deepEqual(f.calls.filter((call) => call[0] === 'cancel'), [], 'its turn stops at its next model request instead')
})

test('in a trial-marked chat, each login\'s sign-out drops only its own turns\' credentials and cancels nothing', async (t) => {
  const f = fixture(t, { libfxSessionId: 'wrun_6' })
  const host = boundHost('shared-chat', credential('user-a', 'login-laptop', 'laptop-token'))
  const free = { kind: 'trial', userId: 'user-a', loginId: 'login-laptop', expiresAt: Date.now() + 86400000 }
  await runtime.submitPrompt(host, 'Ada', 'Free design', 'free-1', undefined, undefined, undefined, free)
  await runtime.submitPrompt(host, 'Ada', 'Paid follow-up', 'paid-2', undefined, undefined, undefined, undefined, credential('user-a', 'login-phone', 'phone-token'))
  assert.equal(f.stored.trialChat, true)
  f.setActive({ id: 2 }) // the phone's paid turn is running

  await runtime.cancelUserRuntime('user-a', 'login-laptop')
  assert.deepEqual([...f.executionCredentials.keys()], ['shared-chat:2'], 'the phone\'s turn keeps its credential')
  assert.equal(f.credentials.get('shared-chat')?.loginId, 'login-phone')
  await runtime.cancelUserRuntime('user-a', 'login-phone')
  assert.deepEqual([...f.executionCredentials.keys()], [])
  assert.equal(f.credentials.has('shared-chat'), false)

  assert.deepEqual(f.calls.filter((call) => call[0] === 'cancel'), [])
  const signOuts = console.info.mock.calls.map((call) => JSON.parse(call.arguments[0])).filter((line) => line.event === 'signout:credentials')
  assert.deepEqual(signOuts.map(({ session, turns, latest }) => [session, turns, latest]), [
    ['shared-chat', 1, 'not-this-login'],
    ['shared-chat', 1, 'deleted'],
  ])
})

test('deletion refuses a chat with a running turn and otherwise drops its records, mapping and credential', async (t) => {
  const f = fixture(t, { libfxSessionId: 'wrun_2' })
  const host = boundHost('delete-chat')
  f.setActive({ id: 1 })
  assert.equal(await runtime.deleteDesignSession(host), false)
  f.setActive(null)
  assert.equal(await runtime.deleteDesignSession(host), true)
  const finish = f.calls.find((call) => call[0] === 'finishCleanup')
  assert.equal(finish[2], 'wrun_2')
  assert.deepEqual(f.calls.find((call) => call[0] === 'dropCredential'), ['dropCredential', 'delete-chat'])
  assert.equal(registry().has('delete-chat'), false)
})

test('a renewed token reaches the stored credential only from the same login and team', async (t) => {
  const f = fixture(t)
  const stored = credential('user-a', 'login-a', 'old-token')
  f.credentials.set('renew-chat', stored)
  const host = boundHost('renew-chat', { ...credential('user-a', 'login-a', 'other-team-token'), teamId: 'team_b', expiresAt: stored.expiresAt + 60_000 })
  await runtime.renewTurnCredential(host)
  assert.equal(f.credentials.get('renew-chat').accessToken, 'old-token', 'a team switch waits for the next prompt')
  host.gatewaySession = { ...credential('user-a', 'login-b', 'other-login-token'), expiresAt: stored.expiresAt + 60_000 }
  await runtime.renewTurnCredential(host)
  assert.equal(f.credentials.get('renew-chat').accessToken, 'old-token', 'another login waits for its own prompt')
  host.gatewaySession = { ...credential('user-a', 'login-a', 'renewed-token'), expiresAt: stored.expiresAt + 60_000 }
  await runtime.renewTurnCredential(host)
  assert.equal(f.credentials.get('renew-chat').accessToken, 'renewed-token')
})

test('a settings change is one guarded write that the next prompt carries', async (t) => {
  const f = fixture(t)
  const host = boundHost('settings-chat')
  assert.deepEqual(await runtime.setSessionGeneration(host, { model: 'anthropic/test-model' }), { ok: true })
  assert.deepEqual(f.calls.filter((call) => call[0] === 'update'), [['update', { preferredModel: 'anthropic/test-model', preferredFast: false }]])
  await runtime.submitPrompt(host, 'Ada', 'Go')
  assert.equal(f.sent[0].sessionOptions.model.id, 'anthropic/test-model')
})

test('a settings change while a turn runs is accepted and says it applies from the next reply', async (t) => {
  const f = fixture(t)
  const host = boundHost('busy-settings')
  f.setActive({ id: 4, startedAt: 1, billingTeamId: 'team_a', prompt: 'Go', startSeq: 1 })
  assert.deepEqual(await runtime.setSessionGeneration(host, { model: 'anthropic/next-model' }), { ok: true })
  assert.deepEqual(f.calls.filter((call) => call[0] === 'update'), [['update', { preferredModel: 'anthropic/next-model', preferredFast: false }]])
  await until(() => f.events.some((item) => item.type === 'status'), 'settings notice')
  assert.equal(f.events.find((item) => item.type === 'status').text, 'model set to anthropic/next-model, from the next reply')
})

test('a turn\'s history and subagents keep the settings it started with after a mid-turn change', async (t) => {
  const f = fixture(t, { libfxSessionId: 'wrun_paid', preferredModel: 'anthropic/start-model', preferredEffort: 'high', preferredFast: false })
  const host = boundHost('paid-history')
  const log = f.logOf('wrun_paid')
  const following = projector.project(runtime.agent(), host, 'wrun_paid', { idleMs: 60 })
  log.push({ type: 'turn_start', messageId: 'm1', sessionId: 'wrun_paid', input: '[Ada] Go' })
  // The turn is marked running in the same commit that projects its turn_start.
  await until(() => f.events.some((item) => item.type === 'turn_start'), 'turn start')
  const started = await f.journal.getActiveTurn('paid-history')
  assert.equal(started.startSeq, f.events.find((item) => item.type === 'turn_start').seq)
  assert.deepEqual(started.settings, { model: 'anthropic/start-model', effort: 'high', fast: false })
  assert.deepEqual(await runtime.setSessionGeneration(host, { model: 'anthropic/next-model', effort: 'low' }), { ok: true })

  const subagent = f.agentOptions.tools.find((tool) => tool.name === 'subagent')
  const ctx = { signal: new AbortController().signal, executionId: 'call-1', sessionId: 'wrun_paid', context: { chatId: 'paid-history', turnId: 1 } }
  await subagent.execute({ task: 'make a button' }, ctx)
  assert.deepEqual(f.engineOptions[0].model, { id: 'anthropic/start-model', effort: 'high', fast: false })

  log.push({ type: 'text_delta', messageId: 'm1', delta: 'Done' })
  log.push({ type: 'turn_end', messageId: 'm1', stopReason: 'end_turn' })
  await following
  const history = f.calls.find((call) => call[0] === 'history')?.[1]
  assert.ok(history)
  assert.equal(history.model, 'anthropic/start-model')
  assert.equal(history.effort, 'high')
  assert.equal(history.fast, false)
})

test('the projector puts the preview wait of a screenshot call on its tool_end, and only there', async (t) => {
  const f = fixture(t)
  const entries = [
    { type: 'tool_end', name: 'screenshot_design', toolCallId: 'shot', turnId: 1, at: 1 },
    { type: 'tool_end', name: 'read_design', toolCallId: 'read', turnId: 1, at: 2 },
    { type: 'tool_end', name: 'screenshot_design', toolCallId: 'unrecorded', turnId: 1, at: 3 },
  ]
  const asked = []
  f.journal.readPreviewWaits = async (_id, ids) => { asked.push(...ids); return new Map([['shot', 515], ['read', 9]]) }
  await projector.addPreviewWaits('chat', entries)
  assert.deepEqual(asked, ['shot', 'unrecorded'], 'only screenshot calls are looked up')
  assert.deepEqual(entries.map((entry) => entry.previewWaitMs), [515, undefined, undefined])
})

test('the projector copies a turn once however many follow it, then records its history and design', async (t) => {
  const f = fixture(t, { libfxSessionId: 'wrun_7', preferredModel: null, preferredEffort: null, preferredFast: null })
  const host = boundHost('project-chat')
  f.credentials.set('project-chat', credential())
  const log = f.logOf('wrun_7')
  const agent = runtime.agent()
  const first = projector.project(agent, host, 'wrun_7', { idleMs: 60 })
  const second = projector.project(agent, getSession('project-chat'), 'wrun_7', { idleMs: 60 })
  log.push({ type: 'turn_start', messageId: 'm4', sessionId: 'wrun_7', input: '[Ada] Make it teal' })
  log.push({ type: 'text_delta', messageId: 'm4', delta: 'Making ' })
  log.push({ type: 'text_delta', messageId: 'm4', delta: 'it teal.' })
  log.push({ type: 'tool_start', messageId: 'm4', id: 'c1', name: 'edit_design', input: { edits: [] } })
  f.setArtifactRevision(3)
  f.stored = { ...f.stored, artifactTurn: 4 }
  log.push({ type: 'tool_end', messageId: 'm4', id: 'c1', name: 'edit_design', isError: false, content: '{"ok":true}' })
  log.push({ type: 'turn_end', messageId: 'm4', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4 } })
  await Promise.all([first, second])

  const kinds = f.events.map((item) => item.type)
  assert.deepEqual(kinds, ['turn_start', 'text', 'tool_start', 'tool_end', 'done'])
  assert.equal(f.events[1].delta, 'Making it teal.')
  assert.equal(f.events[4].id, 4)
  const history = f.calls.filter((call) => call[0] === 'history')
  assert.equal(history.length, 1)
  assert.equal(history[0][1].prompt, 'Make it teal')
  assert.equal(history[0][1].response, 'Making it teal.')
  assert.equal(history[0][1].billingTeamId, 'team_a')
  assert.deepEqual(f.calls.filter((call) => call[0] === 'generation').map((call) => call.slice(1, 4)), [['project-chat', 3, 4]])
})

test('the projector commits a line after a quiet spell at once and batches the lines right behind it', async (t) => {
  const f = fixture(t, { libfxSessionId: 'wrun_quick', preferredModel: null, preferredEffort: null, preferredFast: null })
  const host = boundHost('quick-chat')
  const log = f.logOf('wrun_quick')
  const following = projector.project(runtime.agent(), host, 'wrun_quick', { idleMs: 200 })
  log.push({ type: 'turn_start', messageId: 'm1', sessionId: 'wrun_quick', input: '[Ada] Hi' })
  await until(() => f.events.some((item) => item.type === 'turn_start'), 'turn start')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const pushed = performance.now()
  log.push({ type: 'text_delta', messageId: 'm1', delta: 'Hel' })
  await until(() => f.events.some((item) => item.type === 'text'), 'first text')
  assert.ok(performance.now() - pushed < 30, 'the first text does not wait out a batch window')
  log.push({ type: 'text_delta', messageId: 'm1', delta: 'lo' })
  log.push({ type: 'text_delta', messageId: 'm1', delta: ' there' })
  log.push({ type: 'turn_end', messageId: 'm1', stopReason: 'end_turn' })
  await following
  assert.deepEqual(f.events.filter((item) => item.type === 'text').map((item) => item.delta), ['Hel', 'lo there'])
  assert.deepEqual(f.events.map((item) => item.seq), f.events.map((_, index) => index + 1), 'each item lands once, in order')
})

test('a turn\'s history waits when the database fails, and a later follower writes it once', async (t) => {
  const f = fixture(t, { libfxSessionId: 'wrun_retry', preferredModel: null, preferredEffort: null, preferredFast: null })
  const host = boundHost('retry-chat')
  f.credentials.set('retry-chat', credential())
  let failing = true
  const recordTurn = f.history.recordTurn
  f.history.recordTurn = async (turn) => { if (failing) throw new Error('database unavailable'); return recordTurn(turn) }
  const log = f.logOf('wrun_retry')
  const following = projector.project(runtime.agent(), host, 'wrun_retry', { idleMs: 60 })
  log.push({ type: 'turn_start', messageId: 'm2', sessionId: 'wrun_retry', input: '[Ada] Keep this' })
  log.push({ type: 'text_delta', messageId: 'm2', delta: 'Kept.' })
  f.setArtifactRevision(5)
  f.stored = { ...f.stored, artifactTurn: 2 }
  log.push({ type: 'turn_end', messageId: 'm2', stopReason: 'end_turn' })
  await following
  // The transcript and the turn's end committed; its history did not, so its work stays.
  assert.equal(await f.journal.getActiveTurn('retry-chat'), null)
  const waiting = await f.journal.readTurnWork('retry-chat')
  assert.deepEqual(waiting.map((item) => [item.turnId, item.turn?.prompt, item.design?.revision]), [[2, 'Keep this', 5]])
  assert.deepEqual(f.calls.filter((call) => call[0] === 'history'), [])

  failing = false
  await projector.finishTurns(host)
  await projector.finishTurns(host)
  const history = f.calls.filter((call) => call[0] === 'history')
  assert.equal(history.length, 1)
  assert.equal(history[0][1].prompt, 'Keep this')
  assert.equal(history[0][1].response, 'Kept.')
  // The design is written again with its retry; the insert ignores a repeat.
  assert.ok(f.calls.filter((call) => call[0] === 'generation').every((call) => call[1] === 'retry-chat' && call[2] === 5 && call[3] === 2))
  assert.deepEqual(await f.journal.readTurnWork('retry-chat'), [])
})

test('sponsored history keeps the actual free model even after later settings change', async (t) => {
  const f = fixture(t, { libfxSessionId: 'wrun_trial', preferredModel: 'paid/other-model', preferredEffort: 'high', preferredFast: false })
  const host = boundHost('trial-history')
  f.executionCredentials.set('trial-history:1', { kind: 'trial', userId: 'guest:owner', loginId: 'guest-login', expiresAt: Date.now() + 86400000 })
  const log = f.logOf('wrun_trial')
  const following = projector.project(runtime.agent(), host, 'wrun_trial', { idleMs: 60 })
  log.push({ type: 'turn_start', messageId: 'm1', sessionId: 'wrun_trial', input: '[You] Free' })
  log.push({ type: 'text_delta', messageId: 'm1', delta: 'Done' })
  log.push({ type: 'turn_end', messageId: 'm1', stopReason: 'end_turn' })
  await following
  const history = f.calls.find(call => call[0] === 'history')?.[1]
  assert.ok(history)
  assert.equal(history.model, 'anthropic/claude-opus-5.5-fast')
  assert.equal(history.effort, 'low')
  assert.equal(history.fast, true)
  assert.equal(history.billingTeamId, null)
})

test('a turn Gateway refused ends as an error with the reason the agent\'s fetch gave', () => {
  const [item] = projector.itemsOf({ type: 'turn_end', messageId: 'm2', stopReason: 'refused', error: { message: 'AI Gateway returned 402: Add credits.' } }, 5)
  assert.deepEqual(item, { type: 'error', id: 2, turnId: 2, text: 'AI Gateway returned 402: Add credits.', at: 5 })
  assert.deepEqual(projector.itemsOf({ type: 'turn_end', messageId: 'm2', stopReason: 'cancelled' }, 5)[0].type, 'done')
  assert.deepEqual(projector.itemsOf({ type: 'text_delta', messageId: 'other', delta: 'x' }, 5), [], 'lines of turns fx0 did not start are skipped')
})

test('a message that joins the running turn is shown as part of that turn', () => {
  assert.deepEqual(
    projector.itemsOf({ type: 'user_message', messageId: 'm2', id: 'm3', text: '[Ada] make it teal' }, 5),
    [{ type: 'status', id: 3, turnId: 2, text: 'steering the running turn', at: 5 }],
  )
  assert.deepEqual(projector.itemsOf({ type: 'user_message', messageId: 'm2', text: 'no id' }, 5), [], 'steering fx0 did not send is skipped')
})
