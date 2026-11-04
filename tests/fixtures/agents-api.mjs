// An in-process fake of the Ampersand Agents API, reached through an injected fetch. Sessions persist across runs and
// streams follow a session. Each seat's model is a test script that runs once per turn and acts only through tool calls.
// To exercise the client's recovery, the fake also queues input posted during a turn and ends a create stream at its first idle.

const encoder = new TextEncoder()
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers })
const apiError = (status, message) => json({ error: { message, type: 'invalid_request_error', param: null, code: null } }, status)
const nowSeconds = () => Math.floor(Date.now() / 1000)
// Call IDs restart in every turn, as the API allows, so only (turn, call) identifies a call.
const callKey = (turnId, callId) => `${turnId}\0${callId}`
// The documented bounds on session metadata: 16 string pairs, keys up to 64 and values up to 512 characters.
const validMetadata = (metadata) => Object.keys(metadata).length <= 16
  && Object.entries(metadata).every(([key, value]) => key.length <= 64 && typeof value === 'string' && value.length <= 512)

export function createAgentsApi({ apiKey = 'test-ampersand-key', scripts = {} } = {}) {
  const sessions = new Map()
  const requests = []
  const interceptors = []
  const idempotency = new Map()
  const scriptErrors = []
  let counter = 0
  const nextId = (prefix) => `${prefix}_${++counter}`

  const publicTurn = (session, turn) => ({
    id: turn.id, object: 'agent.session.turn', session_id: session.id, agent_id: 'agent_inline', status: turn.status,
    error: turn.error, created_at: turn.createdAt, started_at: turn.createdAt, completed_at: turn.completedAt, subagent_id: null, usage: null,
  })
  const snapshot = (session) => ({
    id: session.id, object: 'agent.session', status: session.status, error: null, metadata: { ...session.metadata },
    required_actions: session.requiredActions.map((action) => ({ ...action })),
  })

  function newSession(seat, agent, created, status = 'idle', turns = [], metadata = {}) {
    const session = {
      id: nextId(`sess_${seat.toLowerCase()}`), seat, agent, created, status, metadata, requiredActions: [], queue: [], items: [], turns, waiting: new Map(),
      subscribers: new Set(), unheard: [], sourceIds: new Map(), results: [], cancels: 0, deleted: false,
    }
    sessions.set(session.id, session)
    return session
  }

  function emit(session, event) {
    const payload = { event_id: nextId('evt'), ...event }
    if (!session.subscribers.size) session.unheard.push(payload.type)
    for (const subscriber of [...session.subscribers]) subscriber.send(payload)
  }

  // This fake ends a create stream at its first idle, so tests cover reopening; an events stream follows the session until the client closes it.
  function subscribe(session, signal, endAfterIdle = false) {
    let controller
    let closed = false
    const subscriber = {
      send(event) {
        if (closed) return
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
        if (endAfterIdle && event.type === 'agent.session.idle') subscriber.close()
      },
      close() {
        if (closed) return
        closed = true
        session.subscribers.delete(subscriber)
        controller.close()
      },
    }
    const body = new ReadableStream({
      start(value) { controller = value },
      cancel() {
        closed = true
        session.subscribers.delete(subscriber)
      },
    })
    session.subscribers.add(subscriber)
    signal?.addEventListener('abort', () => subscriber.close(), { once: true })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }

  function startTurn(session) {
    const turn = { id: nextId('turn'), status: 'in_progress', input: session.queue.splice(0), error: null, createdAt: nowSeconds(), completedAt: null, calls: [] }
    session.turns.push(turn)
    session.status = 'in_progress'
    emit(session, { type: 'agent.session.turn.created', session_id: session.id, turn_id: turn.id, turn: publicTurn(session, turn) })
    emit(session, { type: 'agent.session.in_progress', session: snapshot(session) })
    setImmediate(() => runScript(session, turn))
  }

  function finishTurn(session, turn, status) {
    turn.status = status
    turn.completedAt = nowSeconds()
    for (const waiter of session.waiting.values()) waiter.reject(new Error(`turn ${status}`))
    session.waiting.clear()
    session.requiredActions = []
    emit(session, { type: 'agent.session.turn.output_text.done', session_id: session.id, turn_id: turn.id, item_id: nextId('item'), content_index: 0, text: `Private ${session.seat} notes` })
    emit(session, { type: `agent.session.turn.${status}`, session_id: session.id, turn_id: turn.id, turn: publicTurn(session, turn), usage: null })
    session.status = 'idle'
    emit(session, { type: 'agent.session.idle', session: snapshot(session) })
    // This fake starts queued input as the next turn right away, so the idle just sent is already stale.
    if (session.queue.length) startTurn(session)
  }

  function turnContext(session, turn) {
    const context = {
      seat: session.seat,
      sessionId: session.id,
      turnId: turn.id,
      number: session.turns.indexOf(turn) + 1,
      input: turn.input,
      api,
      messages: (channel) => turn.input.filter((message) => message.metadata.channel === channel),
      has: (channel, pattern) => turn.input.some((message) => message.metadata.channel === channel && pattern.test(message.content[0].text)),
      call(name, toolArguments, options) {
        return context.callAll([[name, toolArguments]], options).then(([result]) => result)
      },
      /** Requests several tool calls in one requires_action; the turn resumes once every one has a result. */
      callAll(calls, { twice = false } = {}) {
        if (turn.status !== 'in_progress') throw new Error(`turn ${turn.status}`)
        for (const [name] of calls) if (!session.agent.tools.some((tool) => tool.name === name)) throw new Error(`${session.seat} declared no ${name} tool`)
        const results = calls.map(([name, toolArguments]) => {
          const action = { type: 'function_call', turn_id: turn.id, call_id: `call_${turn.calls.length + 1}`, name, arguments: toolArguments }
          const result = Promise.withResolvers()
          session.waiting.set(callKey(turn.id, action.call_id), result)
          session.requiredActions.push(action)
          turn.calls.push(action)
          return result.promise
        })
        session.status = 'requires_action'
        turn.status = 'waiting'
        emit(session, { type: 'agent.session.requires_action', session: snapshot(session) })
        if (twice) emit(session, { type: 'agent.session.requires_action', session: snapshot(session) })
        return Promise.all(results)
      },
      /** Ends the turn as failed with the given documented error code. */
      fail(code) {
        throw Object.assign(new Error(`The scripted model failed with ${code}`), { turnErrorCode: code })
      },
      async read() {
        const result = await context.call('read_design', {})
        return JSON.parse(result.output)
      },
      dropStreams: () => api.dropStreams(session.id),
      emit: (event) => emit(session, event),
    }
    return context
  }

  async function runScript(session, turn) {
    try {
      await scripts[session.seat]?.(turnContext(session, turn))
    } catch (error) {
      if (turn.status === 'cancelled' || session.deleted) return
      scriptErrors.push(error)
      turn.error = { code: error.turnErrorCode ?? 'server_error', message: 'The scripted model failed' }
      return finishTurn(session, turn, 'failed')
    }
    if (turn.status === 'in_progress' && !session.deleted) finishTurn(session, turn, 'completed')
  }

  function addInput(session, input) {
    const accepted = []
    for (const message of input) {
      const { source = 'api', id } = message.metadata ?? {}
      const key = `${source}\0${id}`
      // An exact repeat of (source, id) is ignored, as the API documents.
      if (id !== undefined && session.sourceIds.has(key)) continue
      if (id !== undefined) session.sourceIds.set(key, JSON.stringify(message))
      accepted.push(message)
    }
    session.items.push(...accepted)
    session.queue.push(...accepted)
    if (accepted.length && session.status === 'idle') startTurn(session)
  }

  function conflictingInput(session, input) {
    return input.some((message) => {
      const { source = 'api', id } = message.metadata ?? {}
      const saved = id === undefined ? undefined : session.sourceIds.get(`${source}\0${id}`)
      return saved !== undefined && saved !== JSON.stringify(message)
    })
  }

  function createSession(body, signal) {
    const tools = body.agent?.tools ?? []
    const seat = tools.some((tool) => tool.name === 'room_reply') ? 'Builder' : 'Reviewer'
    const metadata = body.metadata ?? {}
    if (!body.agent?.model || body.environment?.type !== 'none' || !Array.isArray(body.input) || !body.input.length || body.stream !== true || !validMetadata(metadata)) {
      return apiError(400, 'Invalid session request')
    }
    const session = newSession(seat, body.agent, body, 'idle', [], metadata)
    const response = subscribe(session, signal, true)
    emit(session, { type: 'agent.session.created', session: snapshot(session) })
    addInput(session, body.input)
    return response
  }

  function postEvents(session, body, key) {
    if (key !== null) {
      const saved = idempotency.get(`${session.id}\0${key}`)
      if (saved !== undefined) return saved === JSON.stringify(body) ? new Response(null, { status: 202 }) : apiError(409, 'Idempotency key reused with a different body')
    }
    const events = body.events ?? []
    for (const event of events) {
      if (event.type === 'agent.session.input.message' && conflictingInput(session, event.input)) return apiError(409, 'Message ID reused with different content')
      if (event.type === 'agent.session.input.tool_result' && !session.waiting.has(callKey(event.turn_id, event.call_id))) return apiError(409, 'No pending call matches this result')
    }
    if (key !== null) idempotency.set(`${session.id}\0${key}`, JSON.stringify(body))
    for (const event of events) {
      if (event.type === 'agent.session.input.message') addInput(session, event.input)
      if (event.type === 'agent.session.input.tool_result') {
        const waiter = session.waiting.get(callKey(event.turn_id, event.call_id))
        session.waiting.delete(callKey(event.turn_id, event.call_id))
        session.results.push(event)
        session.requiredActions = session.requiredActions.filter((action) => action.turn_id !== event.turn_id || action.call_id !== event.call_id)
        const turn = session.turns.at(-1)
        if (!session.requiredActions.length) {
          session.status = 'in_progress'
          turn.status = 'in_progress'
          emit(session, { type: 'agent.session.in_progress', session: snapshot(session) })
        }
        waiter.resolve({ success: event.success, output: event.output, error: event.error })
      }
      if (event.type === 'agent.session.input.cancel') {
        session.cancels++
        const turn = session.turns.at(-1)
        if (turn && ['in_progress', 'waiting'].includes(turn.status)) finishTurn(session, turn, 'cancelled')
      }
    }
    return new Response(null, { status: 202 })
  }

  async function route(request, init) {
    if (request.headers.get('authorization') !== `Bearer ${apiKey}`) return apiError(401, 'Invalid API key')
    if (request.headers.get('openai-beta') !== 'agents=v1') return apiError(400, 'Missing OpenAI-Beta header')
    const parts = request.path.replace(/^\/v1\/agents\/sessions/, '').split('/').filter(Boolean)
    if (!parts.length && request.method === 'POST') return createSession(request.body, init.signal)
    const session = sessions.get(decodeURIComponent(parts[0] ?? ''))
    if (!session || session.deleted) return apiError(404, 'Session not found')
    const [, resource] = parts
    if (!resource && request.method === 'GET') return json(snapshot(session))
    if (!resource && request.method === 'DELETE') {
      session.deleted = true
      for (const subscriber of [...session.subscribers]) subscriber.close()
      return json({ id: session.id, object: 'agent.session.deleted', deleted: true })
    }
    if (resource === 'events' && request.method === 'GET') return subscribe(session, init.signal)
    if (resource === 'events' && request.method === 'POST') return postEvents(session, request.body, request.headers.get('idempotency-key'))
    if (resource === 'turns' && request.method === 'GET') {
      const limit = Number(request.query.get('limit') ?? 20)
      const turns = (request.query.get('order') === 'asc' ? session.turns : [...session.turns].reverse()).slice(0, limit).map((turn) => publicTurn(session, turn))
      return json({ object: 'list', data: turns, first_id: turns[0]?.id ?? null, last_id: turns.at(-1)?.id ?? null, has_more: session.turns.length > turns.length })
    }
    return apiError(404, `No route for ${request.method} ${request.path}`)
  }

  const api = {
    apiKey,
    sessions,
    requests,
    scriptErrors,
    async fetch(input, init = {}) {
      // Like a real fetch, an already-aborted request never goes out.
      if (init.signal?.aborted) throw init.signal.reason
      const url = new URL(String(input))
      const text = typeof init.body === 'string' ? init.body : undefined
      const request = {
        method: init.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: new Headers(init.headers), text, body: text === undefined ? undefined : JSON.parse(text),
        redirect: init.redirect, signal: init.signal,
      }
      requests.push(request)
      const interceptor = interceptors.find((candidate) => candidate.times > 0 && candidate.match(request))
      if (interceptor) {
        interceptor.times--
        return interceptor.respond(request, () => route(request, init))
      }
      return route(request, init)
    },
    /** Answers matching requests with `respond(request, defaultResponse)` instead of the default handler, `times` times. */
    intercept(match, respond, times = 1) {
      interceptors.push({ match, respond, times })
    },
    /** Closes every open stream of a session, as a dropped connection would. */
    dropStreams(sessionId) {
      for (const subscriber of [...sessions.get(sessionId).subscribers]) subscriber.close()
    },
    bySeat: (seat) => [...sessions.values()].filter((session) => session.seat === seat),
    creates: () => requests.filter((request) => request.method === 'POST' && request.path === '/v1/agents/sessions'),
    eventPosts: (sessionId) => requests.filter((request) => request.method === 'POST' && request.path === `/v1/agents/sessions/${sessionId}/events`),
    /** Adds a session in the given state without running a turn, as if left behind by an earlier process. */
    seedSession(seat, status = 'idle', metadata = {}) {
      const turn = { id: nextId('turn'), status: { idle: 'completed', failed: 'failed' }[status] ?? 'in_progress', input: [], error: null, createdAt: nowSeconds(), completedAt: null, calls: [] }
      return newSession(seat, { tools: [] }, null, status, [turn], metadata)
    },
  }
  return api
}

/** Text and metadata of the messages a session has been sent, in order. */
export function delivered(session) {
  return session.items.map((message) => ({ text: message.content[0].text, ...message.metadata }))
}
