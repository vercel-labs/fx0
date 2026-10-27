import assert from 'node:assert/strict'
import test from 'node:test'
import timers from 'node:timers/promises'
import { createAmpersandClient } from '../lib/collab/ampersand.ts'
import { runDesignGroup } from '../lib/collab/group.ts'
import { InputsChangedError } from '../lib/collab/input-batch.ts'
import { createAgentsApi, delivered } from './fixtures/agents-api.mjs'

const HTML = '<!doctype html><html><head><title>Shared</title></head><body><h1>Hello team</h1><button>RSVP</button></body></html>'
const BASE_TIME = 1_790_000_000_000
const ALICE = { id: 'member-alice', name: 'Alice', joinedAt: BASE_TIME }
const BOB = { id: 'member-bob', name: 'Bob', joinedAt: BASE_TIME }

const message = (id, text, author = ALICE) => ({ id, authorId: author.id, author: author.name, role: 'user', text, createdAt: BASE_TIME + id * 1000 })
const reply = (id, text) => ({ id, authorId: 'assistant', author: 'Assistant', role: 'assistant', text, createdAt: BASE_TIME + id * 1000 })
const never = () => new Promise(() => {})
const requestIds = (design) => design.pending_requests.map((request) => request.id)

// The group's real transport runs against the fake API; hooks record what the runtime would store.
function harness(scripts, apiOptions = {}) {
  const api = createAgentsApi({ scripts, ...apiOptions })
  const client = createAmpersandClient({ baseUrl: 'https://ampersand.test/v1', apiKey: api.apiKey, fetch: api.fetch })
  const state = { sessions: {}, text: [], published: [], activity: [] }
  const hooks = {
    onSession: (seat, session) => { state.sessions[seat] = session },
    onText: (text) => { state.text.push(text) },
    onPublish: (html) => { state.published.push(html) },
    onActivity: (event) => { state.activity.push(event) },
  }
  const run = ({ messages, pending = messages, html = '', revision = 0, sessions = state.sessions, model = 'ampersand-test', timeoutMs = 5_000, signal, members = [ALICE, BOB], review = true }) => runDesignGroup({
    client, model, hooks, timeoutMs, signal,
    room: { title: 'Launch page', review, members, messages, pending, html, revision, sessions: { ...sessions } },
  })
  return { api, state, run }
}

// Call IDs repeat across turns, so a result belongs to a call only when both IDs match.
const resultOf = (session, call) => session.results.find((result) => result.turn_id === call.turn_id && result.call_id === call.call_id)
const results = (session, name) => session.turns.flatMap((turn) => turn.calls).filter((call) => call.name === name).map((call) => resultOf(session, call))
const seatSession = (api, seat) => api.bySeat(seat).at(-1)
const isCreate = (tool) => (request) => request.path === '/v1/agents/sessions' && request.body.agent.tools.some((definition) => definition.name === tool)
// An input post to the seat's session whose first message matches the pattern.
const inputPost = (seat, pattern) => (request) => request.method === 'POST' && new RegExp(`sess_${seat.toLowerCase()}_\\d+/events$`).test(request.path)
  && pattern.test(request.body.events[0].input?.[0].content[0].text ?? '')
// Message IDs in each input post to a session, so ignored repeats still show up.
const postedIds = (api, session) => api.eventPosts(session.id).map((request) => request.body.events[0]).filter((event) => event.type === 'agent.session.input.message')
  .map((event) => event.input.map((item) => item.metadata.id.replace(/[0-9a-f-]{36}$/, 'uuid')))

// The usual collaboration: build on room messages, review each publish, reply once approved.
const builder = ({ html = HTML, text = 'The page is ready.' } = {}) => async (turn) => {
  if (turn.messages('room').length) {
    const design = await turn.read()
    await turn.call('publish_design', { html, base_revision: design.revision })
    await turn.call('send_message', { content: 'Published. Please check the heading and button.' })
  }
  if (turn.has('notice', /^Reviewer approved revision \d+\./)) await turn.call('room_reply', { content: text, addressed_message_ids: requestIds(await turn.read()) })
}
const reviewer = async (turn) => {
  if (!turn.has('notice', /^Builder published revision \d+\./)) return
  const design = await turn.read()
  await turn.call('finish_review', { revision: design.revision, summary: 'Checked the heading and the RSVP button.', addressed_message_ids: requestIds(design) })
}

test('both seats start concurrently on persistent sessions, settle through publish, review and reply, and a later run sends only new messages', { timeout: 10_000 }, async () => {
  const reviewerStarted = Promise.withResolvers()
  const stale = []
  const { api, state, run } = harness({
    // The Builder can't finish its first turn until the Reviewer's has started, so serial seats would deadlock.
    Builder: async (turn) => {
      if (turn.number === 1) {
        await reviewerStarted.promise
        // A failed tool result travels back through the API just as a successful one does.
        stale.push(await turn.call('publish_design', { html: HTML, base_revision: 1 }))
      }
      await builder()(turn)
    },
    Reviewer: async (turn) => {
      reviewerStarted.resolve()
      await reviewer(turn)
    },
  })
  const first = message(1, 'Build a launch page with an RSVP button.')
  await run({ messages: [first] })

  assert.deepEqual(api.scriptErrors, [])
  const builderSession = seatSession(api, 'Builder')
  const reviewerSession = seatSession(api, 'Reviewer')
  assert.equal(api.creates().length, 2)
  for (const [session, tools] of [[builderSession, 'room_reply'], [reviewerSession, 'finish_review']]) {
    assert.equal(session.created.agent.model, 'ampersand-test')
    assert.deepEqual(session.created.agent.ampersand, { allow_silent_completion: true })
    assert.deepEqual(session.created.environment, { type: 'none' })
    assert.deepEqual(session.created.agent.tools.map((tool) => tool.name), ['read_design', 'publish_design', 'send_message', tools, 'pass'])
    assert.match(session.metadata.fx0_config, /^[0-9a-f]{64}$/)
  }
  assert.notEqual(builderSession.created.agent.instructions, reviewerSession.created.agent.instructions)
  assert.notEqual(builderSession.metadata.fx0_config, reviewerSession.metadata.fx0_config, 'each seat has its own instructions and tools')
  assert.deepEqual(state.sessions, {
    Builder: { sessionId: builderSession.id, deliveredThrough: 1 },
    Reviewer: { sessionId: reviewerSession.id, deliveredThrough: 1 },
  })

  const [{ text: setupText, timestamp, ...setup }, room] = delivered(builderSession)
  assert.deepEqual(setup, { id: 'setup', source: 'fx0-collab', sender: 'fx0', sender_name: 'fx0', channel: 'setup' })
  assert.equal(Number.isInteger(timestamp), true)
  assert.equal(setupText, 'Room: Launch page\nPeople: Alice, Bob\nYou are the Builder; your teammate is the Reviewer. The room\'s conversation so far follows, oldest first.')
  assert.deepEqual(room, { text: first.text, id: 'message-1', source: 'fx0-collab', sender: 'member-alice', sender_name: 'Alice', channel: 'room', timestamp: (BASE_TIME + 1000) / 1000 })
  assert.match(delivered(reviewerSession)[0].text, /You are the Reviewer; your teammate is the Builder\./)

  const reviewerInput = delivered(reviewerSession).slice(2)
  assert.deepEqual(reviewerInput.map((item) => [item.channel, item.sender, item.sender_name]), [['notice', 'fx0', 'fx0'], ['notice', 'fx0', 'fx0'], ['team', 'builder', 'Builder']])
  assert.match(reviewerInput[0].text, /^Open requests for this run, oldest first:/)
  assert.match(reviewerInput[0].text, /\"id\":1/)
  assert.match(reviewerInput[1].text, /^Builder published revision 1\./)
  assert.match(reviewerInput[1].id, /^notice-/)
  assert.match(reviewerInput[2].id, /^team-builder-/)
  assert.equal(reviewerInput[2].text, 'Published. Please check the heading and button.')
  const approval = delivered(builderSession).at(-1)
  assert.equal(approval.text, 'Reviewer approved revision 1. Notes: Checked the heading and the RSVP button.')
  assert.equal(approval.channel, 'notice')

  assert.deepEqual(stale, [{ success: false, output: undefined, error: 'Stale design revision. The current revision is 0; call read_design and merge your change into it before publishing.' }])
  assert.deepEqual(results(builderSession, 'read_design').map((result) => { const { pending_requests, ...design } = JSON.parse(result.output); assert.deepEqual(pending_requests, [{ id: 1, authorId: ALICE.id, author: ALICE.name, text: first.text, createdAt: first.createdAt }]); return design }), [{ html: '', revision: 0 }, { html: HTML, revision: 1 }])
  assert.deepEqual(JSON.parse(results(builderSession, 'publish_design')[1].output), { published: true, revision: 1, bytes: Buffer.byteLength(HTML) })
  assert.equal(results(builderSession, 'send_message')[0].output, 'Sent to Reviewer.')
  assert.equal(results(builderSession, 'room_reply')[0].output, 'Posted to the room.')
  assert.deepEqual(JSON.parse(results(reviewerSession, 'finish_review')[0].output), { approved: true, revision: 1, addressed_message_ids: [1] })
  assert.deepEqual(state.published, [HTML])
  assert.deepEqual(state.text, ['The page is ready.'])
  assert.deepEqual(state.activity, [
    { agent: 'Builder', kind: 'publish', text: 'Published the shared design', revision: 1 },
    { agent: 'Builder', kind: 'message', text: 'Published. Please check the heading and button.' },
    { agent: 'Reviewer', kind: 'review', text: 'Checked the heading and the RSVP button.', revision: 1 },
  ])
  assert.ok(!JSON.stringify(state).includes('Private'), 'assistant text outside tools stays private')

  // A later run continues both sessions and sends each one only what it hasn't seen.
  const counts = { Builder: builderSession.items.length, Reviewer: reviewerSession.items.length }
  const firstRunRequests = api.requests.length
  const second = message(3, 'Make the button say Join us.', BOB)
  await run({ messages: [first, reply(2, 'The page is ready.'), second], pending: [second], html: HTML, revision: 1 })
  assert.deepEqual(api.scriptErrors, [])
  assert.equal(api.creates().length, 2, 'no new session for a later run')
  assert.deepEqual(postedIds(api, builderSession).at(-2), ['message-3', 'notice-uuid'], 'the Builder\'s later run posts the new message and current request notice')
  // The continued Reviewer also gets the Builder's earlier room reply; the Builder's session already holds it.
  const laterRoom = { Builder: [['message-3', 'member-bob', 'Bob']], Reviewer: [['message-2', 'builder', 'Builder'], ['message-3', 'member-bob', 'Bob']] }
  for (const [seat, session] of [['Builder', builderSession], ['Reviewer', reviewerSession]]) {
    const later = delivered(session).slice(counts[seat])
    assert.deepEqual(later.filter((item) => item.channel === 'room').map((item) => [item.id, item.sender, item.sender_name]), laterRoom[seat])
    assert.deepEqual(state.sessions[seat], { sessionId: session.id, deliveredThrough: 3 })
    // The stream opens before the new input is posted, as the docs require, and the post carries a stable key.
    const messagePost = api.eventPosts(session.id).find((request) => request.body.events[0].input?.some((item) => item.metadata.id === 'message-3'))
    const opened = api.requests.findIndex((request, index) => index >= firstRunRequests && request.method === 'GET' && request.path === `/v1/agents/sessions/${session.id}/events`)
    assert.ok(opened >= 0 && opened < api.requests.indexOf(messagePost))
    assert.match(messagePost.headers.get('idempotency-key'), /^fx0-[0-9a-f]{64}$/)
  }
  assert.deepEqual(results(builderSession, 'read_design').map((result) => JSON.parse(result.output).revision), [0, 1, 1, 2])
  assert.equal(JSON.parse(results(builderSession, 'publish_design')[2].output).revision, 2)
  assert.deepEqual(state.text, ['The page is ready.', 'The page is ready.'])
})

test('after a failed run, a seat that received the batch starts over from the whole transcript', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'warn', () => {})
  const full = () => Response.json({ error: { message: 'Saved history limit reached' } }, { status: 400 })
  const messagePost = (id) => (request) => request.method === 'POST' && request.path === `/v1/agents/sessions/${id}/events` && request.body.events[0].input?.some((item) => item.metadata.id === 'message-3')
  const failures = {
    'a failed turn': { error: 'The Builder\'s Ampersand turn failed (server_error)', turn: (turn) => { throw new Error('the model stopped') } },
    'a turn at the context limit': { error: 'The Builder\'s Ampersand turn failed (context_length_exceeded)', turn: (turn) => turn.fail('context_length_exceeded') },
    'a post at the saved-data limit': { error: 'Ampersand API request failed (HTTP 400) [events]', apply: (api, id) => api.intercept(messagePost(id), full) },
    // The API admits each try, then its response is lost, so the session may hold the message.
    'a post the API admitted but answered with errors': {
      error: 'Ampersand API request failed (HTTP 500) [events]',
      apply: (api, id) => api.intercept(messagePost(id), async (_request, respond) => {
        await respond()
        return Response.json({ error: { message: 'The response was lost' } }, { status: 500, headers: { 'retry-after-ms': '0' } })
      }, 6),
    },
  }
  for (const [name, failure] of Object.entries(failures)) {
    let failing = false
    const { api, state, run } = harness({
      Builder: async (turn) => {
        if (failing) await failure.turn?.(turn)
        await builder()(turn)
      },
      Reviewer: reviewer,
    })
    const first = message(1, 'Build a launch page.')
    await run({ messages: [first] })
    const original = seatSession(api, 'Builder')
    const second = message(3, 'Make it blue.', BOB)
    const later = { messages: [first, reply(2, 'The page is ready.'), second], pending: [second], html: HTML, revision: 1 }
    failing = true
    failure.apply?.(api, original.id)
    await assert.rejects(run(later), { message: failure.error }, name)
    assert.deepEqual(state.sessions.Builder, { sessionId: original.id, deliveredThrough: 3 }, `${name}: the attempt is recorded before the post`)

    failing = false
    await run({ ...later, timeoutMs: 2_000 })
    const rebuilt = seatSession(api, 'Builder')
    assert.notEqual(rebuilt.id, original.id, name)
    assert.equal(original.deleted, true, name)
    assert.deepEqual(delivered(rebuilt).slice(1, 4).map((item) => item.id), ['message-1', 'message-2', 'message-3'], name)
    assert.ok(delivered(original).filter((item) => item.id === 'message-3').length <= 1, `${name}: no session gets a message twice`)
    assert.equal(state.text.at(-1), 'The page is ready.', name)
  }
})

test('event retries reuse the idempotency key and body, and a repeated tool request runs the tool once', { timeout: 10_000 }, async () => {
  // room_reply has a visible side effect on every run, unlike a publish that a second run would reject as stale.
  const { api, state, run } = harness({ Builder: async (turn) => turn.call('room_reply', { content: 'Tuesday.', addressed_message_ids: requestIds(await turn.read()) }, { twice: true }) })
  api.intercept((request) => request.method === 'POST' && request.body?.events?.[0]?.type === 'agent.session.input.tool_result',
    () => Response.json({ error: { message: 'try again' } }, { status: 500, headers: { 'retry-after-ms': '0' } }))
  await run({ messages: [message(1, 'Which day?')] })
  assert.deepEqual(api.scriptErrors, [])
  assert.deepEqual(state.text, ['Tuesday.'], 'the duplicated request replied once')
  const builderSession = seatSession(api, 'Builder')
  const replyCall = builderSession.turns[0].calls[0]
  const isReplyResult = (event) => event.turn_id === replyCall.turn_id && event.call_id === replyCall.call_id
  const resultPosts = api.eventPosts(builderSession.id).filter((request) => isReplyResult(request.body.events[0]))
  assert.equal(resultPosts.length, 2, 'the failed post was retried with its key, and the repeated request waited on that post')
  assert.equal(new Set(resultPosts.map((request) => request.headers.get('idempotency-key'))).size, 1)
  assert.equal(new Set(resultPosts.map((request) => request.text)).size, 1)
  assert.equal(builderSession.results.filter(isReplyResult).length, 1)
})

test('a repeated tool-call ID cannot change its name or arguments', { timeout: 10_000 }, async () => {
  for (const change of ['arguments', 'name']) {
    const { api, state, run } = harness({ Builder: async (turn) => {
      const design = await turn.read()
      const original = turn.call('room_reply', { content: 'First reply.', addressed_message_ids: requestIds(design) })
      const action = structuredClone(turn.api.sessions.get(turn.sessionId).requiredActions[0])
      if (change === 'arguments') action.arguments.content = 'Changed reply.'
      else action.name = 'send_message'
      turn.emit({ type: 'agent.session.requires_action', session: { id: turn.sessionId, required_actions: [action] } })
      await original
    } })
    await assert.rejects(run({ messages: [message(1, 'Which day?')] }), /reused a tool-call ID with different arguments/, change)
    assert.deepEqual(api.scriptErrors, [])
    assert.deepEqual(state.text, ['First reply.'], 'only the original side effect is allowed')
    assert.deepEqual(state.activity, [], 'the changed-name replay cannot send a teammate message')
  }
})

test('a dropped stream is reopened and saved state answers the request it missed', { timeout: 10_000 }, async () => {
  const { api, state, run } = harness({
    Builder: async (turn) => {
      if (turn.messages('room').length) {
        turn.dropStreams()
        await turn.call('publish_design', { html: HTML, base_revision: 0 })
      }
      if (turn.has('notice', /^Reviewer approved/)) await turn.call('room_reply', { content: 'Ready.', addressed_message_ids: requestIds(await turn.read()) })
    },
    Reviewer: reviewer,
  })
  await run({ messages: [message(1, 'Build a page.')], timeoutMs: 2_000 })
  assert.deepEqual(api.scriptErrors, [])
  assert.ok(seatSession(api, 'Builder').unheard.includes('agent.session.requires_action'), 'the tool request went out while no stream was open')
  assert.deepEqual(state.published, [HTML])
  assert.deepEqual(state.text, ['Ready.'])
})

test('a failed run cancels each busy session once and never retries the cancel', { timeout: 10_000 }, async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const { api, run } = harness({ Builder: never })
  api.intercept((request) => request.body?.events?.[0]?.type === 'agent.session.input.cancel',
    () => Response.json({ error: { message: 'busy' } }, { status: 429, headers: { 'retry-after-ms': '0' } }), Infinity)
  await assert.rejects(run({ messages: [message(1, 'Build a page.')], timeoutMs: 300 }), { message: 'Could not stop a previous Ampersand run; its saved sessions are retained for retry' })
  const cancels = api.requests.filter((request) => request.body?.events?.[0]?.type === 'agent.session.input.cancel')
  assert.deepEqual(cancels.map((request) => request.path), [`/v1/agents/sessions/${seatSession(api, 'Builder').id}/events`], 'only the busy Builder is cancelled, once')
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [['[fx0] collab cancel skipped', { name: 'RateLimitError' }]])
})

test('each unrecoverable failure fails the run with its own message', { timeout: 30_000 }, async () => {
  const noticeQueued = Promise.withResolvers()
  const isBuilderStream = (request) => request.method === 'GET' && /sess_builder_\d+\/events$/.test(request.path)
  const transcript = [message(1, 'Build a page.'), reply(2, 'Done.'), message(3, 'Add a footer.', BOB)]
  const failures = [
    {
      name: 'an error event',
      scripts: { Builder: async (turn) => {
        turn.emit({ type: 'error', session_id: turn.sessionId, error: { message: 'secret provider detail', type: 'server_error', code: null, param: null } })
        await never()
      } },
      error: 'Ampersand reported an error for the Builder [stream]',
    },
    {
      name: 'a failed session',
      scripts: { Reviewer: async (turn) => {
        turn.emit({ type: 'agent.session.failed', session: { id: turn.sessionId, status: 'failed' } })
        await never()
      } },
      error: 'The Reviewer\'s Ampersand session failed',
    },
    {
      // The failure is announced while no stream is open, so only saved state can report it.
      name: 'a session failure missed while the stream was down',
      scripts: { Reviewer: async (turn) => {
        turn.dropStreams()
        turn.api.sessions.get(turn.sessionId).status = 'failed'
        await never()
      } },
      error: 'The Reviewer\'s Ampersand session failed',
    },
    {
      name: 'a turn that fails while the stream is down',
      scripts: { Builder: (turn) => {
        turn.dropStreams()
        throw new Error('the model stopped')
      } },
      error: 'The Builder\'s Ampersand turn failed (server_error)',
    },
    {
      name: 'a turn that fails while queued input starts the next one',
      scripts: {
        Builder: builder(),
        Reviewer: async (turn) => {
          if (turn.number > 1) return reviewer(turn)
          await noticeQueued.promise
          throw new Error('the model stopped')
        },
      },
      setup: (api) => api.intercept(inputPost('Reviewer', /^Builder published/), (_request, respond) => {
        const response = respond()
        noticeQueued.resolve()
        return response
      }),
      error: 'The Reviewer\'s Ampersand turn failed (server_error)',
      check: (api) => assert.equal(seatSession(api, 'Reviewer').turns[0].status, 'failed'),
    },
    {
      name: 'a stream that keeps closing before any event',
      scripts: { Builder: async (turn) => {
        turn.dropStreams()
        await never()
      } },
      setup: (api) => api.intercept(isBuilderStream, () => new Response('', { headers: { 'content-type': 'text/event-stream' } }), Infinity),
      error: 'The Builder\'s Ampersand event stream kept closing [stream]',
      check: (api) => assert.equal(api.requests.filter(isBuilderStream).length, 4, 'three quiet reopens are allowed, the fourth fails'),
    },
    {
      name: 'a stored session that cannot be read',
      scripts: { Builder: builder(), Reviewer: reviewer },
      setup: (api) => {
        const stored = api.seedSession('Builder', 'idle')
        api.intercept((request) => request.method === 'GET' && request.path === `/v1/agents/sessions/${stored.id}`,
          () => Response.json({ error: { message: 'unavailable' } }, { status: 503, headers: { 'retry-after-ms': '0' } }), Infinity)
        return { messages: transcript, pending: [transcript[2]], html: HTML, revision: 1, sessions: { Builder: { sessionId: stored.id, deliveredThrough: 2 } } }
      },
      error: 'Ampersand API request failed (HTTP 503) [retrieve]',
      check: (api) => {
        assert.equal(api.creates().filter(isCreate('room_reply')).length, 0, 'no second Builder session is started beside it')
        assert.equal(api.bySeat('Builder')[0].deleted, false)
      },
    },
    // The Reviewer's create answers late, or answers at once but sends its session ID late; either way that new session is cancelled, not leaked.
    ...['response', 'created event'].map((late) => ({
      name: `a create that fails while the other seat's ${late} is late`,
      scripts: { Builder: builder(), Reviewer: never },
      setup: (api) => {
        api.intercept(isCreate('room_reply'), () => Response.json({ error: { message: 'invalid request' } }, { status: 400 }))
        api.intercept(isCreate('finish_review'), async (_request, respond) => {
          if (late === 'response') await timers.setTimeout(30)
          const response = await respond()
          return late === 'response' ? response : new Response(response.body.pipeThrough(new TransformStream({ start: () => timers.setTimeout(50) })), response)
        })
      },
      error: 'Ampersand API request failed (HTTP 400) [create]',
      check: (api) => {
        assert.equal(api.bySeat('Builder').length, 0)
        assert.equal(seatSession(api, 'Reviewer').cancels, 1, `with a late ${late}, the Reviewer session is cancelled once`)
      },
    })),
    {
      // The Builder's publish notice waits for the Reviewer's session, so the failed create has to release it.
      name: 'a create that fails while a teammate post waits for it',
      scripts: { Builder: builder(), Reviewer: reviewer },
      setup: (api) => api.intercept(isCreate('finish_review'), async () => {
        await timers.setTimeout(50)
        return Response.json({ error: { message: 'invalid request' } }, { status: 400 })
      }),
      error: 'Ampersand API request failed (HTTP 400) [create]',
    },
  ]
  for (const failure of failures) {
    const { api, run } = harness(failure.scripts)
    const overrides = failure.setup?.(api)
    await assert.rejects(run({ messages: [message(1, 'Build a page.')], timeoutMs: 2_000, ...overrides }), { message: failure.error }, failure.name)
    failure.check?.(api)
  }
})

test('a stored session that is missing, failed, busy or made with other settings is replaced from the whole transcript', { timeout: 15_000 }, async (t) => {
  t.mock.method(console, 'warn', () => {})
  const transcript = [message(1, 'Build a page.'), reply(2, 'The page is ready.'), message(3, 'Add a footer.', BOB)]
  const replaced = {
    missing: () => ({ id: 'sess_gone' }),
    failed: (api) => api.seedSession('Builder', 'failed'),
    busy: (api) => api.seedSession('Builder', 'in_progress'),
    'idle, with no recorded settings': (api) => api.seedSession('Builder', 'idle'),
    'idle, made with other settings': (api) => api.seedSession('Builder', 'idle', { fx0_config: '0'.repeat(64) }),
    'idle, made for another model': async (api, run) => {
      await run({ messages: [transcript[0]], model: 'ampersand-previous' })
      return seatSession(api, 'Builder')
    },
  }
  for (const [name, prepare] of Object.entries(replaced)) {
    const { api, state, run } = harness({ Builder: builder({ text: 'Footer added.' }), Reviewer: reviewer })
    const stored = await prepare(api, run)
    await run({ messages: transcript, pending: [transcript[2]], html: HTML, revision: 1, sessions: { Builder: { sessionId: stored.id, deliveredThrough: 1 } } })
    assert.deepEqual(api.scriptErrors, [], name)
    const replacement = seatSession(api, 'Builder')
    assert.notEqual(replacement.id, stored.id, name)
    const deletes = api.requests.filter((request) => request.method === 'DELETE').map((request) => request.path)
    assert.deepEqual(deletes, name === 'missing' ? [] : [`/v1/agents/sessions/${stored.id}`], `a ${name} session is dropped once`)
    assert.deepEqual(delivered(replacement).slice(1, 4).map((item) => [item.id, item.sender, item.sender_name]), [
      ['message-1', 'member-alice', 'Alice'], ['message-2', 'builder', 'Builder'], ['message-3', 'member-bob', 'Bob'],
    ], name)
    assert.deepEqual(state.sessions.Builder, { sessionId: replacement.id, deliveredThrough: 3 }, name)
    assert.equal(state.text.at(-1), 'Footer added.', name)
  }
})

test('a saved session whose delete fails is retained and no replacement is started', { timeout: 10_000 }, async (t) => {
  t.mock.method(console, 'warn', () => {})
  const { api, state, run } = harness({ Builder: builder(), Reviewer: reviewer })
  const stored = api.seedSession('Builder', 'in_progress')
  api.intercept((request) => request.method === 'DELETE', () => Response.json({ error: { message: 'busy' } }, { status: 503 }))
  const pending = message(3, 'Add a footer.', BOB)
  const options = { messages: [message(1, 'Build a page.'), reply(2, 'Ready.'), pending], pending: [pending], html: HTML, revision: 1, sessions: { Builder: { sessionId: stored.id, deliveredThrough: 1 } } }
  await assert.rejects(run(options), /Could not retire a saved Ampersand session/)
  assert.equal(api.bySeat('Builder').length, 1, 'a failed delete cannot leak another Builder session')
  assert.equal(stored.deleted, false)
  assert.equal(state.sessions.Builder, undefined, 'the durable saved ID has not been overwritten')
  await run(options)
  assert.equal(stored.deleted, true)
  assert.equal(api.bySeat('Builder').length, 2)
  assert.equal(state.text.at(-1), 'The page is ready.')
})

test('input arriving during saved-session deletion prevents a later replacement create', { timeout: 10_000 }, async () => {
  const deleting = Promise.withResolvers()
  const releaseDelete = Promise.withResolvers()
  const { api, run } = harness({ Builder: builder(), Reviewer: reviewer })
  const saved = api.seedSession('Builder', 'in_progress')
  api.intercept((request) => request.method === 'DELETE' && request.path.endsWith(`/${saved.id}`), async (_request, respond) => {
    deleting.resolve()
    await releaseDelete.promise
    return respond()
  })
  const controller = new AbortController()
  const work = run({ messages: [message(1, 'Build a page.')], sessions: { Builder: { sessionId: saved.id, deliveredThrough: 0 } }, signal: controller.signal })
  await deleting.promise
  controller.abort(new InputsChangedError())
  releaseDelete.resolve()
  await assert.rejects(work, InputsChangedError)
  assert.equal(api.creates().filter(isCreate('room_reply')).length, 0, 'a superseded batch cannot create a replacement after its awaited delete returns')
  assert.equal(saved.deleted, true)
})

test('input arriving after session creation was admitted still records and cancels the created session', { timeout: 10_000 }, async () => {
  const admitted = Promise.withResolvers()
  const releaseCreate = Promise.withResolvers()
  const { api, state, run } = harness({ Builder: never })
  api.intercept(isCreate('room_reply'), async (_request, respond) => {
    const response = await respond()
    admitted.resolve()
    await releaseCreate.promise
    return response
  })
  const controller = new AbortController()
  const work = run({ messages: [message(1, 'Build a page.')], signal: controller.signal })
  await admitted.promise
  controller.abort(new InputsChangedError())
  releaseCreate.resolve()
  await assert.rejects(work, InputsChangedError)
  const created = seatSession(api, 'Builder')
  assert.equal(state.sessions.Builder.sessionId, created.id, 'the only durable cleanup handle is preserved')
  assert.equal(created.cancels, 1, 'an already admitted create must not be abandoned when new input arrives')
  assert.deepEqual(state.published, [])
  assert.deepEqual(state.text, [])
})

test('an idle made stale by queued input does not settle the seat', { timeout: 10_000 }, async () => {
  const noticeQueued = Promise.withResolvers()
  const { api, state, run } = harness({
    Builder: builder(),
    // The Reviewer's first turn outlasts the publish, so the notice waits in its queue and its next idle is stale.
    Reviewer: async (turn) => {
      if (turn.number === 1) await noticeQueued.promise
      await reviewer(turn)
    },
  })
  api.intercept(inputPost('Reviewer', /^Builder published/), (_request, respond) => {
    const response = respond()
    noticeQueued.resolve()
    return response
  })
  await run({ messages: [message(1, 'Build a page.')] })
  assert.deepEqual(api.scriptErrors, [])
  const reviewerSession = seatSession(api, 'Reviewer')
  assert.equal(reviewerSession.turns[1].input[0].content[0].text.startsWith('Builder published revision 1.'), true, 'the notice started the queued second turn')
  assert.deepEqual(state.text, ['The page is ready.'])
})

test('an idle check that overlaps a new post does not settle the seat', { timeout: 10_000 }, async () => {
  const approvalPosted = Promise.withResolvers()
  const { api, state, run } = harness({
    Builder: async (turn) => {
      // Slow enough that the Reviewer settles first if the Builder was wrongly settled.
      if (turn.has('notice', /^Reviewer approved/)) await new Promise((resolve) => setTimeout(resolve, 50))
      await builder()(turn)
    },
    Reviewer: reviewer,
  })
  // The Builder's first idle check reads its turns before the approval is posted, and gets the answer only after.
  api.intercept((request) => request.method === 'GET' && /^\/v1\/agents\/sessions\/sess_builder_\d+\/turns$/.test(request.path), async (request, respond) => {
    const stale = await respond()
    await approvalPosted.promise
    return stale
  })
  api.intercept(inputPost('Builder', /^Reviewer approved/), (_request, respond) => {
    approvalPosted.resolve()
    return respond()
  })
  await run({ messages: [message(1, 'Build a page.')] })
  assert.deepEqual(api.scriptErrors, [])
  assert.deepEqual(state.text, ['The page is ready.'])
})

test('a continued seat whose post starts no turn is settled from saved state', { timeout: 10_000 }, async () => {
  const { api, state, run } = harness({ Builder: async (turn) => turn.messages('room').length ? turn.call('room_reply', { content: `Answer ${turn.number}.`, addressed_message_ids: requestIds(await turn.read()) }) : undefined })
  const first = message(1, 'Which day works?')
  await run({ messages: [first] })
  const reviewerSession = seatSession(api, 'Reviewer')
  // Accepted without starting a turn, as a post of exact repeats is, so no idle event follows it.
  api.intercept((request) => request.method === 'POST' && request.path === `/v1/agents/sessions/${reviewerSession.id}/events`, () => new Response(null, { status: 202 }))
  const second = message(3, 'And which time?', BOB)
  await run({ messages: [first, reply(2, 'Answer 1.'), second], pending: [second], timeoutMs: 1_000 })
  assert.deepEqual(state.text, ['Answer 1.', 'Answer 2.'])
  assert.equal(reviewerSession.turns.length, 1)
})

test('every tool call in one request is answered, and each tool runs once', { timeout: 10_000 }, async () => {
  const outcomes = []
  const { api, state, run } = harness({ Builder: async (turn) => {
    const design = await turn.read()
    outcomes.push(...await turn.callAll([['read_design', {}], ['room_reply', { content: 'Tuesday works.', addressed_message_ids: requestIds(design) }]]))
  } })
  await run({ messages: [message(1, 'Which day?')], timeoutMs: 2_000 })
  assert.deepEqual(api.scriptErrors, [])
  assert.deepEqual(outcomes.map((outcome) => outcome.output), [JSON.stringify({ html: '', revision: 0, pending_requests: [{ id: 1, authorId: ALICE.id, author: ALICE.name, text: 'Which day?', createdAt: BASE_TIME + 1000 }] }), 'Posted to the room.'])
  const builderSession = seatSession(api, 'Builder')
  assert.deepEqual(builderSession.turns[0].calls.map((call) => call.call_id), ['call_1', 'call_2', 'call_3'])
  assert.deepEqual(builderSession.results.map((result) => result.call_id), ['call_1', 'call_2', 'call_3'])
  assert.deepEqual(state.text, ['Tuesday works.'])
})

test('an idle check waits for a post to the seat that is still in flight', { timeout: 10_000 }, async () => {
  const noticeSent = Promise.withResolvers()
  const { api, state, run } = harness({
    Builder: async (turn) => {
      if (turn.messages('room').length) await turn.call('publish_design', { html: HTML, base_revision: 0 })
      if (turn.has('notice', /^Reviewer approved/)) await turn.call('room_reply', { content: 'The page is ready.', addressed_message_ids: requestIds(await turn.read()) })
    },
    Reviewer: async (turn) => {
      if (turn.number === 1) return noticeSent.promise
      await reviewer(turn)
    },
  })
  // The notice reaches the API, and the Reviewer's first turn ends, 50 ms before the API admits it.
  api.intercept(inputPost('Reviewer', /^Builder published/), async (_request, respond) => {
    noticeSent.resolve()
    await timers.setTimeout(50)
    return respond()
  })
  await run({ messages: [message(1, 'Build a page.')] })
  assert.deepEqual(api.scriptErrors, [])
  assert.deepEqual(state.text, ['The page is ready.'])
})

test('teammate posts wait until the other seat has a session and holds this run\'s room messages', { timeout: 10_000 }, async () => {
  const created = harness({ Builder: builder(), Reviewer: reviewer })
  created.api.intercept(isCreate('finish_review'), () => new Response(null, { status: 429, headers: { 'retry-after-ms': '150' } }))
  await created.run({ messages: [message(1, 'Build a page.')] })
  assert.deepEqual(created.api.scriptErrors, [])
  assert.deepEqual(created.state.text, ['The page is ready.'])
  assert.equal(created.api.creates().filter(isCreate('finish_review')).length, 2, 'the rate-limited create was retried')

  const { api, run } = harness({ Builder: builder(), Reviewer: reviewer })
  const first = message(1, 'Build a page.')
  await run({ messages: [first] })
  const reviewerSession = seatSession(api, 'Reviewer')
  const before = reviewerSession.items.length
  api.intercept((request) => request.method === 'POST' && request.path === `/v1/agents/sessions/${reviewerSession.id}/events` && request.body.events[0].input?.some((item) => item.metadata.id === 'message-3'), async (_request, respond) => {
    await timers.setTimeout(80)
    return respond()
  })
  const second = message(3, 'Make it blue.', BOB)
  await run({ messages: [first, reply(2, 'The page is ready.'), second], pending: [second], html: HTML, revision: 1 })
  const order = delivered(reviewerSession).slice(before).map((item) => item.id.replace(/[0-9a-f-]{36}$/, 'uuid'))
  assert.deepEqual(order.slice(0, 4), ['message-2', 'message-3', 'notice-uuid', 'notice-uuid'])
})

test('a batch where nothing changes may end with a pass, and a continued session learns who joined, in order', { timeout: 10_000 }, async () => {
  const { api, state, run } = harness({
    Builder: async (turn) => {
      const ids = requestIds(await turn.read())
      await (turn.number === 1 ? turn.call('room_reply', { content: 'Hi Alice.', addressed_message_ids: ids }) : turn.call('pass', { addressed_message_ids: ids }))
    },
    Reviewer: (turn) => turn.call('pass', {}),
  })
  const first = message(1, 'Hello!')
  await run({ messages: [first], members: [ALICE] })
  const builderSession = seatSession(api, 'Builder')
  const reviewerSession = seatSession(api, 'Reviewer')
  const before = { Builder: builderSession.items.length, Reviewer: reviewerSession.items.length }

  // Bob joined before Alice's question to him, and Carol after it; neither wrote anything.
  const bob = { ...BOB, joinedAt: BASE_TIME + 2_500 }
  const carol = { id: 'member-carol', name: 'Carol', joinedAt: BASE_TIME + 3_500 }
  const question = message(3, 'Bob, should we make the header green?')
  await run({ messages: [first, reply(2, 'Hi Alice.'), question], pending: [question], members: [ALICE, bob, carol] })
  assert.deepEqual(api.scriptErrors, [])
  assert.deepEqual(state.text, ['Hi Alice.'], 'the pass posts nothing, and the run still succeeds')
  const later = (session, seat) => delivered(session).slice(before[seat]).filter((item) => item.channel !== 'team').map((item) => [item.id, item.channel, item.text])
  assert.deepEqual(later(builderSession, 'Builder').slice(0, 3), [
    ['join-member-bob', 'notice', 'Bob joined the room.'],
    ['message-3', 'room', question.text],
    ['join-member-carol', 'notice', 'Carol joined the room.'],
  ])
  assert.deepEqual(later(reviewerSession, 'Reviewer').slice(0, 4).map(([id]) => id), ['message-2', 'join-member-bob', 'message-3', 'join-member-carol'])
  assert.equal(api.creates().length, 2, 'join notices continue the existing sessions')
})

test('with review off only the Builder runs and replies without an approval, and turning review back on catches the Reviewer up', { timeout: 10_000 }, async () => {
  let review = true
  const { api, state, run } = harness({
    Builder: async (turn) => {
      if (review) return builder()(turn)
      const design = await turn.read()
      await turn.call('publish_design', { html: HTML.replace('Hello team', 'Hello alone'), base_revision: design.revision })
      await turn.call('room_reply', { content: 'Updated the heading.', addressed_message_ids: requestIds(design) })
    },
    Reviewer: reviewer,
  })
  const first = message(1, 'Build a launch page with an RSVP button.')
  await run({ messages: [first] })
  const reviewerSession = seatSession(api, 'Reviewer')
  const reviewerItems = reviewerSession.items.length

  review = false
  const second = message(3, 'Change the heading.', BOB)
  await run({ messages: [first, reply(2, 'The page is ready.'), second], pending: [second], html: HTML, revision: 1, review })
  assert.deepEqual(api.scriptErrors, [])
  const solo = seatSession(api, 'Builder')
  assert.equal(api.creates().length, 3, 'the Builder alone gets a session made with its solo settings')
  assert.deepEqual(solo.created.agent.tools.map((tool) => tool.name), ['read_design', 'publish_design', 'room_reply', 'pass'])
  assert.doesNotMatch(solo.created.agent.instructions, /Reviewer|teammate/)
  assert.match(delivered(solo)[0].text, /You are the Builder; you work alone\./)
  assert.equal(reviewerSession.items.length, reviewerItems, 'the Reviewer hears nothing while review is off')
  assert.deepEqual(state.text, ['The page is ready.', 'Updated the heading.'])
  assert.deepEqual(state.activity.filter((event) => event.kind === 'review').map((event) => event.revision), [1], 'nothing approved the solo revision')

  review = true
  const third = message(5, 'Make the button bigger.')
  await run({ messages: [first, reply(2, 'The page is ready.'), second, reply(4, 'Updated the heading.'), third], pending: [third], html: HTML, revision: 2, review })
  assert.deepEqual(api.scriptErrors, [])
  assert.equal(seatSession(api, 'Reviewer'), reviewerSession, 'the Reviewer continues its own session')
  assert.deepEqual(delivered(reviewerSession).slice(reviewerItems).slice(0, 4).map((item) => item.id), ['message-2', 'message-3', 'message-4', 'message-5'])
  assert.deepEqual(state.text.at(-1), 'The page is ready.')
})
