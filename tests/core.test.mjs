import assert from 'node:assert/strict'
import test from 'node:test'
import { urlChat } from '../lib/session-id.ts'
import './runtime.test.mjs'
import {
  DESIGN_ARTIFACT_EMBEDDED_CSP,
  MAX_DESIGN_ARTIFACT_BYTES,
  normalizeDesignArtifactHtml,
  prepareDesignArtifactHtml,
  validateDesignArtifactHtml,
} from '../lib/design-artifact.ts'
import {
  applyStreamItem,
  endActivity,
  groupThreadEntries,
  isPreviewOpenFromSearch,
  mergeSessionView,
  projectSessionView,
  renameActivity,
  replayEvents,
  shouldAcceptSessionEvent,
  startActivity,
  upsertSession,
  waitingLabel,
} from '../components/chat-state.ts'
import { createTools } from '../lib/tools.ts'
import { featuredModels } from '../lib/featured-models.ts'
import { designLinkUrl, MAX_DESIGN_LINK_LENGTH } from '../lib/design-link.ts'

test('a design may only ask to open a whole https address, shown in full before it opens', () => {
  assert.equal(designLinkUrl('https://vercel.com/blog?ref=design#top'), 'https://vercel.com/blog?ref=design#top')
  assert.equal(designLinkUrl('https://EXAMPLE.com'), 'https://example.com/', 'the dialog shows the address the browser opens')
  for (const value of [
    'http://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:secret@example.com',
    'https://user@example.com', '//example.com', 'not a url', '', null, undefined, 42, { href: 'https://example.com' },
  ]) {
    assert.equal(designLinkUrl(value), null, JSON.stringify(value) ?? String(value))
  }
  const longest = `https://example.com/?q=${'a'.repeat(MAX_DESIGN_LINK_LENGTH - 'https://example.com/?q='.length)}`
  assert.equal(designLinkUrl(longest), longest)
  assert.equal(designLinkUrl(`${longest}a`), null, 'too long to show whole')
  // An address that only grows past the limit once the browser encodes it is refused too.
  const spaced = `https://example.com/?q=a${' '.repeat(1000)}b`
  assert.ok(spaced.length <= MAX_DESIGN_LINK_LENGTH && new URL(spaced).href.length > MAX_DESIGN_LINK_LENGTH)
  assert.equal(designLinkUrl(spaced), null)
})
import { readdirSync, readFileSync } from 'node:fs'

test('the libfx wake route stays private, so only Vercel Queues can deliver to it', () => {
  // A function with a queue trigger has no public URL on Vercel. Its handler acts on
  // the delivery it is handed: the bundled queue client runs libfx before the broker
  // confirms the receipt. So the trigger is what keeps forged deliveries out.
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  const triggers = config.functions?.['app/api/libfx/route.ts']?.experimentalTriggers ?? []
  assert.deepEqual(triggers.map(({ type, topic }) => ({ type, topic })), [{ type: 'queue/v2beta', topic: '__libfx_wkf_workflow_session' }])
  // No other route serves the wake handler, since one without the trigger would be public.
  const routes = readdirSync(new URL('../app', import.meta.url), { recursive: true })
    .filter((path) => /(^|\/)route\.tsx?$/.test(path))
  const serving = routes.filter((path) => readFileSync(new URL(`../app/${path}`, import.meta.url), 'utf8').includes('wakeHandler('))
  assert.deepEqual(serving, ['api/libfx/route.ts'])
})
import { DESIGN_MD_CATALOG, DESIGN_MD_MAX_BYTES, parseDesignMdRequest } from '../lib/design-md.ts'

function toolHost() {
  return {
    reportInvocation: () => 1,
    storeResult: () => {},
    readResult: () => undefined,
    askUser: async () => ({}),
    log: () => {},
    spawnSubagent: async () => 'done',
    capabilitySearch: () => [],
    readDesign: async () => ({ html: null, artifactRevision: 0 }),
    publishDesign: async () => ({ ok: true, revision: 1, changed: true }),
    editDesign: async () => ({ ok: true, revision: 2, changed: true }),
  }
}

const SAFE_DESIGN = '<!doctype html><html><head><style>body{color:red}</style></head><body><a href="#details">Details</a><img alt="dot" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><h1 id="details">Hello</h1></body></html>'

function assertInvalid(html, expectedError) {
  assert.deepEqual(validateDesignArtifactHtml(html), { ok: false, error: expectedError })
}

function documentWith(body, head = '') {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
}

test('the featured models are the newest of each featured family, in that order', () => {
  const featured = featuredModels([
    { id: 'alibaba/qwen-3-14b', released: 9 },
    { id: 'anthropic/claude-opus-5', released: 1 },
    { id: 'anthropic/claude-opus-5.5', released: 2 },
    { id: 'anthropic/claude-opus-5.5-fast', released: 2 },
    { id: 'anthropic/claude-sonnet-5', released: 3 },
    { id: 'openai/gpt-6.1-sol', released: 5 },
    { id: 'openai/gpt-6.2-mini', released: 6 },
    { id: 'deepseek/deepseek-v4-flash', released: 4 },
    { id: 'deepseek/deepseek-v4-pro', released: 4 },
  ])
  // A family's order, not the catalog's; minis, Sonnet, Qwen and "-fast" twins never lead.
  assert.deepEqual(featured, ['openai/gpt-6.1-sol', 'anthropic/claude-opus-5.5', 'deepseek/deepseek-v4-pro'])
})

test('design mode exposes only design and common host tools', async () => {
  const host = toolHost()
  const tools = createTools(host)
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'read_design',
      'publish_design',
      'edit_design',
      'web_fetch',
      'ask_user_question',
      'read_tool_result',
      'capability_search',
      'subagent',
    ],
  )
  const signal = new AbortController().signal
  await tools.find((tool) => tool.name === 'read_design').execute({}, { signal })
  await tools.find((tool) => tool.name === 'edit_design').execute(
    { edits: [{ old_string: 'black', new_string: 'blue' }, { old_string: 'Old', new_string: 'New' }] },
    { signal },
  )
})

test('turn events update an existing sidebar session without mutating it', () => {
  const current = [{ id: 'chat', title: 'Landing page', createdAt: 10, lastActivity: 10, busy: false }]
  const started = upsertSession(current, 'chat', { type: 'turn_start', id: 1, at: 11 })

  assert.deepEqual(started, [{ id: 'chat', title: 'Landing page', createdAt: 10, lastActivity: 10, busy: true }])
  assert.equal(current[0].busy, false)
  const done = upsertSession(started, 'chat', { type: 'done', id: 1, at: 12 })
  assert.deepEqual(done, [{ id: 'chat', title: 'Landing page', createdAt: 10, lastActivity: 10, busy: false }])
  // Events that do not change the summary keep the same array.
  assert.equal(upsertSession(done, 'chat', { type: 'text', text: 'hi', at: 13 }), done)
  const prompted = upsertSession(done, 'chat', { type: 'user', id: 2, text: 'Make it teal', at: 14 })
  assert.deepEqual(prompted, [{ id: 'chat', title: 'Landing page', createdAt: 10, lastActivity: 14, busy: true }])
})

test('parallel generations keep the sidebar in the order their prompts arrived, however they finish', () => {
  let sessions = []
  sessions = upsertSession(sessions, 'first', { type: 'user', id: 1, text: 'First', at: 100 })
  sessions = upsertSession(sessions, 'second', { type: 'user', id: 1, text: 'Second', at: 200 })
  sessions = upsertSession(sessions, 'third', { type: 'user', id: 1, text: 'Third', at: 300 })
  for (const id of ['third', 'first', 'second']) sessions = upsertSession(sessions, id, { type: 'turn_start', id: 1, at: 400 })
  // The oldest prompt finishes last; it must not jump to the top.
  for (const [id, at] of [['third', 500], ['second', 600], ['first', 700]]) {
    sessions = upsertSession(sessions, id, { type: 'done', id: 1, at })
  }
  assert.deepEqual(sessions.map((session) => session.id), ['third', 'second', 'first'])
  assert.deepEqual(sessions.map((session) => session.busy), [false, false, false])
  sessions = upsertSession(sessions, 'first', { type: 'user', id: 2, text: 'Again', at: 800 })
  assert.deepEqual(sessions.map((session) => session.id), ['first', 'third', 'second'])
})

test('completed turns keep honest activity order and expose only the final assistant message', () => {
  const entries = [
    { key: 'user-1', type: 'user', turnId: 1, text: 'Build it' },
    { key: 'reasoning-1', type: 'reasoning', turnId: 1, text: 'Inspect first' },
    { key: 'tool-1', type: 'tool', turnId: 1, name: 'read_design' },
    { key: 'text-1', type: 'text', turnId: 1, text: 'I will inspect the design.' },
    { key: 'status-1', type: 'status', turnId: 1, text: 'retrying the model request' },
    { key: 'reasoning-2', type: 'reasoning', turnId: 1, text: 'Then edit' },
    { key: 'text-2', type: 'text', turnId: 1, text: 'Now I will make the change.' },
    { key: 'tool-2', type: 'tool', turnId: 1, name: 'edit_design' },
    { key: 'text-final', type: 'text', turnId: 1, text: 'Done — the page is ready.' },
    { key: 'done-1', type: 'divider', turnId: 1 },
  ]

  const rows = groupThreadEntries(entries)
  // The turn's activity comes first, above its answer; the divider closes the turn.
  assert.deepEqual(rows.map((row) => row.kind), ['entry', 'activity', 'entry', 'entry'])
  assert.equal(rows[2].entry.key, 'text-final')
  assert.equal(rows[3].entry.key, 'done-1')
  assert.equal(rows[1].state, 'succeeded')
  assert.deepEqual(rows[1].entries.map((entry) => entry.key), [
    'reasoning-1',
    'tool-1',
    'text-1',
    'status-1',
    'reasoning-2',
    'text-2',
    'tool-2',
  ])
})

test('running turns keep every assistant message inside an expanded activity row', () => {
  const rows = groupThreadEntries(
    [
      { key: 'reasoning-1', type: 'reasoning', turnId: 7, text: 'Inspect' },
      { key: 'text-1', type: 'text', turnId: 7, text: 'I am checking the files.' },
      { key: 'tool-1', type: 'tool', turnId: 7, name: 'read_design', toolStatus: 'running' },
    ],
    7,
  )

  assert.deepEqual(rows.map((row) => row.kind), ['activity'])
  assert.equal(rows[0].state, 'running')
  assert.deepEqual(rows[0].entries.map((entry) => entry.key), ['reasoning-1', 'text-1', 'tool-1'])
})

test('a running answer streams outside the activity row, where it stays once the turn succeeds', () => {
  const running = [
    { key: 'reasoning-1', type: 'reasoning', turnId: 8, text: 'Plan' },
    { key: 'tool-1', type: 'tool', turnId: 8, name: 'write_design' },
    { key: 'text-1', type: 'text', turnId: 8, text: 'Here is your page' },
  ]
  const live = groupThreadEntries(running, 8)
  assert.deepEqual(live.map((row) => row.kind), ['activity', 'entry'])
  assert.equal(live[1].entry.key, 'text-1')
  assert.equal(live[0].writing, true)
  assert.equal(groupThreadEntries(running.slice(0, 2), 8)[0].writing, false)
  const done = groupThreadEntries([...running, { key: 'done-8', type: 'divider', turnId: 8 }])
  assert.deepEqual(done.map((row) => row.kind), ['activity', 'entry', 'entry'])
  assert.equal(done[1].entry.key, 'text-1')
  assert.equal(done[0].writing, false)
})

test('a turn is one version: its last revision, numbered per chat; earlier revisions are not shown', () => {
  const rows = groupThreadEntries([
    { key: 'user-1', type: 'user', text: 'make a page' },
    { key: 'art-1', type: 'artifact', turnId: 3, artifactRevision: 1 },
    { key: 'text-0', type: 'text', turnId: 3, text: 'Here it is.' },
    { key: 'done-3', type: 'divider', turnId: 3 },
    { key: 'user-2', type: 'user', text: 'make it blue' },
    { key: 'tool-1', type: 'tool', turnId: 4, name: 'edit_design' },
    { key: 'art-2', type: 'artifact', turnId: 4, artifactRevision: 2 },
    { key: 'art-3', type: 'artifact', turnId: 4, artifactRevision: 3 },
    { key: 'art-4', type: 'artifact', turnId: 4, artifactRevision: 4 },
    { key: 'text-1', type: 'text', turnId: 4, text: 'Done.' },
    { key: 'done-4', type: 'divider', turnId: 4 },
  ])
  const shown = rows.map((row) => row.kind === 'entry' ? row.entry.key : row.kind)
  assert.deepEqual(shown, ['user-1', 'art-1', 'text-0', 'done-3', 'user-2', 'activity', 'art-4', 'text-1', 'done-4'])
  assert.equal(rows[1].entry.version, 1)
  assert.equal(rows[6].entry.version, 2)
  assert.equal(rows[6].entry.artifactRevision, 4, 'View still opens the real revision')
  assert.deepEqual(rows[5].entries.map((entry) => entry.key), ['tool-1'])
})

test('failed turns keep partial assistant text and the error inside the activity row', () => {
  const rows = groupThreadEntries([
    { key: 'text-1', type: 'text', turnId: 9, text: 'I started the change.' },
    { key: 'tool-1', type: 'tool', turnId: 9, name: 'edit_file', toolStatus: 'error' },
    { key: 'error-1', type: 'error', turnId: 9, text: 'The edit failed.' },
  ])

  assert.deepEqual(rows.map((row) => row.kind), ['activity'])
  assert.equal(rows[0].state, 'failed')
  assert.deepEqual(rows[0].entries.map((entry) => entry.key), ['text-1', 'tool-1', 'error-1'])
})

test('successful turns without assistant text do not create an empty final row', () => {
  const rows = groupThreadEntries([
    { key: 'reasoning-1', type: 'reasoning', turnId: 11, text: 'Nothing to report' },
    { key: 'done-1', type: 'divider', turnId: 11 },
  ])

  assert.deepEqual(rows.map((row) => row.kind), ['activity', 'entry'])
  assert.equal(rows[0].state, 'succeeded')
  assert.deepEqual(rows[0].entries.map((entry) => entry.key), ['reasoning-1'])
})

test('preview remains open across session switches unless chat view is explicit', () => {
  assert.equal(isPreviewOpenFromSearch('?s=first'), true)
  assert.equal(isPreviewOpenFromSearch('?s=second&view=preview'), true)
  assert.equal(isPreviewOpenFromSearch('?s=third&view=chat'), false)
})

test('chat replay keeps the highest artifact revision on the session view', () => {
  const state = replayEvents(
    [
      { type: 'artifact', artifactRevision: 5, seq: 4 },
      { type: 'artifact', artifactRevision: 4, seq: 5 },
    ],
    { artifactRevision: 2 },
  )

  assert.deepEqual(state.view, { artifactRevision: 5 })
  assert.deepEqual(state.entries.map((entry) => entry.type), ['artifact', 'artifact'])
})

test('chat replay hides configuration and transient runtime chatter', () => {
  const state = replayEvents([
    { type: 'status', text: 'effort set to high', seq: 2 },
    { type: 'status', text: 'fast mode off', seq: 3 },
    { type: 'status', text: 'model set to openai/gpt-5 · fast mode on', seq: 4 },
    { type: 'status', text: 'model request in flight (moonshotai/kimi-k3-fast)…', seq: 5 },
    { type: 'status', text: 'retrying the model request', seq: 6 },
  ])

  assert.deepEqual(state.entries.map((entry) => [entry.type, entry.text]), [
    ['status', 'retrying the model request'],
  ])
})

test('a message that joined the running turn no longer waits, and its status stays out of the transcript', () => {
  const state = replayEvents([
    { type: 'user', id: 1, text: 'Design a page', seq: 1 },
    { type: 'turn_start', id: 1, turnId: 1, seq: 2 },
    { type: 'user', id: 2, text: 'make it teal', seq: 3 },
    { type: 'status', id: 2, turnId: 1, text: 'steering the running turn', seq: 4 },
  ])
  assert.deepEqual([...state.startedTurns].sort(), [1, 2])
  assert.equal(state.activeTurnId, 1, 'the running turn is still the first one')
  assert.deepEqual(state.entries.filter((entry) => entry.type === 'status'), [])
})

// What a viewer sees, in order: each message, each turn's text and each turn's end.
const shown = (entries) => entries
  .filter((entry) => entry.type === 'user' || entry.type === 'text' || entry.type === 'divider')
  .map((entry) => entry.type === 'user' ? `user ${entry.id}` : entry.type === 'divider' ? `end ${entry.turnId}` : `text ${entry.turnId}: ${entry.text}`)

test('a steer waits below the streaming reply until it joins, then the reply goes on below it', () => {
  const state = replayEvents([
    { type: 'user', id: 1, text: 'count', seq: 1 },
    { type: 'turn_start', id: 1, turnId: 1, seq: 2 },
    { type: 'text', turnId: 1, delta: '1 2', seq: 3 },
    { type: 'user', id: 2, text: 'stop counting', seq: 4 },
    { type: 'text', turnId: 1, delta: ' 3 4', seq: 5 },
    { type: 'status', id: 2, turnId: 1, text: 'steering the running turn', seq: 6 },
    { type: 'text', turnId: 1, delta: 'BANANA', seq: 7 },
    { type: 'done', id: 1, turnId: 1, seq: 8 },
  ])
  assert.deepEqual(shown(state.entries), ['user 1', 'text 1: 1 2 3 4', 'user 2', 'text 1: BANANA', 'end 1'])
})

test('messages libfx takes out of id order each show where it took them', () => {
  // Two sends that reach libfx in the opposite order fx0 numbered them.
  const state = replayEvents([
    { type: 'user', id: 1, text: 'count', seq: 1 },
    { type: 'turn_start', id: 1, turnId: 1, seq: 2 },
    { type: 'text', turnId: 1, delta: '1 2', seq: 3 },
    { type: 'user', id: 2, text: 'stop counting', seq: 4 },
    { type: 'user', id: 3, text: 'say BANANA', seq: 5 },
    { type: 'text', turnId: 1, delta: ' 3', seq: 6 },
    { type: 'status', id: 3, turnId: 1, text: 'steering the running turn', seq: 7 },
    { type: 'text', turnId: 1, delta: 'BANANA', seq: 8 },
    { type: 'status', id: 2, turnId: 1, text: 'steering the running turn', seq: 9 },
    { type: 'text', turnId: 1, delta: 'Stopped.', seq: 10 },
    { type: 'done', id: 1, turnId: 1, seq: 11 },
  ])
  assert.deepEqual(shown(state.entries), [
    'user 1', 'text 1: 1 2 3', 'user 3', 'text 1: BANANA', 'user 2', 'text 1: Stopped.', 'end 1',
  ])
})

test('a message that runs as its own turn shows below the turn it ended and above its own reply', () => {
  const state = replayEvents([
    { type: 'user', id: 1, text: 'count', seq: 1 },
    { type: 'turn_start', id: 1, turnId: 1, seq: 2 },
    { type: 'text', turnId: 1, delta: '1 2', seq: 3 },
    { type: 'user', id: 2, text: 'what color is this?', imageCount: 1, seq: 4 },
    { type: 'text', turnId: 1, delta: ' 3', seq: 5 },
    { type: 'done', id: 1, turnId: 1, seq: 6 },
    { type: 'turn_start', id: 2, turnId: 2, seq: 7 },
    { type: 'text', turnId: 2, delta: 'Red', seq: 8 },
    { type: 'done', id: 2, turnId: 2, seq: 9 },
  ])
  assert.deepEqual(shown(state.entries), ['user 1', 'text 1: 1 2 3', 'end 1', 'user 2', 'text 2: Red', 'end 2'])
})

test('the bubble a viewer sends waits below the streaming reply until its message joins', () => {
  let { entries } = replayEvents([
    { type: 'user', id: 1, text: 'count', seq: 1 },
    { type: 'turn_start', id: 1, turnId: 1, seq: 2 },
    { type: 'text', turnId: 1, delta: '1 2', seq: 3 },
  ])
  entries = [...entries, { key: 'cx', type: 'user', clientId: 'x', text: 'stop counting', pending: true, waiting: true }]
  for (const item of [
    { type: 'text', turnId: 1, delta: ' 3', seq: 4 },
    { type: 'user', id: 2, clientId: 'x', text: 'stop counting', seq: 5 },
    { type: 'text', turnId: 1, delta: ' 4', seq: 6 },
    { type: 'status', id: 2, turnId: 1, text: 'steering the running turn', seq: 7 },
    { type: 'text', turnId: 1, delta: 'BANANA', seq: 8 },
  ]) entries = applyStreamItem(entries, item)
  assert.deepEqual(shown(entries), ['user 1', 'text 1: 1 2 3 4', 'user 2', 'text 1: BANANA'])
})

test('a transcript cached before messages could wait keeps its order', () => {
  const cached = [
    { key: 'u1', type: 'user', id: 1, text: 'count' },
    { key: 't1', type: 'text', turnId: 1, text: '1 2' },
    { key: 'u2', type: 'user', id: 2, text: 'stop' },
  ]
  const entries = applyStreamItem(cached, { type: 'text', turnId: 1, delta: ' 3', seq: 9 })
  assert.deepEqual(shown(entries), ['user 1', 'text 1: 1 2', 'user 2', 'text 1:  3'])
})

test('a message that joined a turn splits its activity where the model took it', () => {
  const events = [
    { type: 'user', id: 1, text: 'Design a bakery page', seq: 1 },
    { type: 'turn_start', id: 1, turnId: 1, seq: 2 },
    { type: 'tool_start', turnId: 1, callId: 1, name: 'publish_design', seq: 3 },
    { type: 'user', id: 2, text: 'Make the background dark green.', seq: 4 },
    { type: 'artifact', turnId: 1, artifactRevision: 1, seq: 5 },
    { type: 'tool_end', turnId: 1, callId: 1, name: 'publish_design', seq: 6 },
    { type: 'status', id: 2, turnId: 1, text: 'steering the running turn', seq: 7 },
    { type: 'tool_start', turnId: 1, callId: 2, name: 'edit_design', seq: 8 },
    { type: 'artifact', turnId: 1, artifactRevision: 2, seq: 9 },
    { type: 'tool_end', turnId: 1, callId: 2, name: 'edit_design', seq: 10 },
    { type: 'text', turnId: 1, delta: 'The background is now dark green.', seq: 11 },
  ]
  const row = (item) => item.kind === 'activity'
    ? `activity ${item.entries.map((entry) => entry.name).join(',')} ${item.state}`
    : `${item.entry.type}${item.entry.id ?? ''}`
  const running = replayEvents(events)
  assert.deepEqual(groupThreadEntries(running.entries, 1).map(row), [
    'user1', 'activity publish_design succeeded', 'user2', 'activity edit_design running', 'artifact', 'text',
  ])
  const done = replayEvents([...events, { type: 'done', id: 1, turnId: 1, seq: 12 }])
  const rows = groupThreadEntries(done.entries, null)
  assert.deepEqual(rows.map(row), [
    'user1', 'activity publish_design succeeded', 'user2', 'activity edit_design succeeded', 'artifact', 'text', 'divider',
  ])
  assert.equal(new Set(rows.map((item) => item.key)).size, rows.length, 'every row keeps its own key')
  assert.equal(rows[1].key, 'activity-turn-1', 'the first part keeps the key the whole group had')
})

test('a message the running turn has not taken says what it waits for', () => {
  const steer = { key: 'u2', type: 'user', id: 2, text: 'make it teal', waiting: true }
  const running = (tool) => [
    { key: 'u1', type: 'user', id: 1, text: 'Design a page' },
    { key: 't1', type: 'tool', turnId: 1, name: tool, toolStatus: 'running' },
    steer,
  ]
  const started = new Set([1])
  // The design streams into the preview while the model writes it.
  assert.equal(waitingLabel(steer, running('read_design').slice(0, 1).concat(steer), 1, started, true), 'waiting for the design to finish')
  assert.equal(waitingLabel(steer, running('publish_design'), 1, started, false), 'waiting for the design to finish')
  assert.equal(waitingLabel(steer, running('edit_design'), 1, started, false), 'waiting for the design to finish')
  assert.equal(waitingLabel(steer, running('web_fetch'), 1, started, false), 'waiting for the tool to finish')
  // A tool of an earlier turn, or one that ended, holds nothing back.
  assert.equal(waitingLabel(steer, [{ key: 't0', type: 'tool', turnId: 0, name: 'web_fetch', toolStatus: 'running' }, steer], 1, started, false), 'waiting to join')
  assert.equal(waitingLabel(steer, [{ key: 't1', type: 'tool', turnId: 1, name: 'publish_design', toolStatus: 'done' }, steer], 1, started, false), 'waiting to join')
  // A message with images runs as the next turn.
  assert.equal(waitingLabel({ ...steer, imageCount: 1 }, running('publish_design'), 1, started, false), 'runs next')
  assert.equal(waitingLabel({ ...steer, images: [{ data: '', mimeType: 'image/png', preview: '' }] }, [steer], 1, started, true), 'runs next')
  // Nothing to say once a turn took it, before the server has it, or with no turn running.
  assert.equal(waitingLabel(steer, running('publish_design'), 1, new Set([1, 2]), false), null)
  assert.equal(waitingLabel({ ...steer, id: undefined, pending: true }, running('publish_design'), 1, started, false), null)
  assert.equal(waitingLabel(steer, [steer], null, started, false), null)
  assert.equal(waitingLabel({ key: 't', type: 'text', turnId: 1, text: 'hi' }, [], 1, started, false), null)
})

test('chat replay retains API view metadata without matching events', () => {
  const state = replayEvents([], { artifactRevision: 7 })
  assert.deepEqual(state.view, { artifactRevision: 7 })
})

test('tool results resolve the matching call when same-name tools overlap', () => {
  let entries = []
  entries = applyStreamItem(entries, { type: 'tool_start', name: 'bash', command: 'first', callId: 1, at: 10 })
  entries = applyStreamItem(entries, { type: 'tool_start', name: 'bash', command: 'second', callId: 2, at: 20 })
  entries = applyStreamItem(entries, { type: 'tool_end', name: 'bash', callId: 1, content: 'first-result', at: 30 })
  entries = applyStreamItem(entries, { type: 'tool_end', name: 'bash', callId: 2, content: 'second-result', at: 40 })

  assert.deepEqual(
    entries.map((entry) => ({ callId: entry.callId, content: entry.content })),
    [
      { callId: 1, content: 'first-result' },
      { callId: 2, content: 'second-result' },
    ],
  )
})

test('out-of-order view responses and events cannot roll back the client view', () => {
  let view = { artifactRevision: 2 }
  view = mergeSessionView(view, { artifactRevision: 4 })
  view = mergeSessionView(view, { artifactRevision: 3 })
  view = projectSessionView(view, { type: 'artifact', artifactRevision: 1 })

  assert.deepEqual(view, { artifactRevision: 4 })
  // An unchanged view keeps its identity, so React skips the update.
  assert.equal(projectSessionView(view, { type: 'artifact', artifactRevision: 4 }), view)
})

test('a chat keeps its activity start after switching to another chat and back', () => {
  // What chat-app's effect does on each render: only the chat on screen, showing
  // no activity, ends its start.
  const shown = (starts, chatId, active) => (active ? starts : endActivity(starts, chatId))
  let starts = new Map()
  starts = startActivity(starts, 'draft', 1_000) // the first prompt of a new chat
  starts = renameActivity(starts, 'draft', 'chat-a') // the server names the chat
  starts = shown(starts, 'chat-a', true)
  starts = shown(starts, 'draft', false) // 30s in: open a new chat
  starts = shown(starts, 'chat-b', false) // and an idle one
  starts = shown(starts, 'chat-a', true) // back while it still generates
  assert.equal(starts.get('chat-a'), 1_000)
  // A message sent while it is busy keeps the first start.
  assert.equal(startActivity(starts, 'chat-a', 40_000).get('chat-a'), 1_000)

  // The turn ends on screen: the next send starts its own count.
  starts = shown(starts, 'chat-a', false)
  assert.equal(starts.has('chat-a'), false)
  starts = startActivity(starts, 'chat-a', 60_000)
  // It ends while another chat is open: coming back to the idle chat drops it.
  starts = shown(starts, 'draft', false)
  assert.equal(starts.get('chat-a'), 60_000)
  starts = shown(starts, 'chat-a', false)
  assert.equal(startActivity(starts, 'chat-a', 90_000).get('chat-a'), 90_000)

  // No change returns the same map, so React skips the update.
  assert.equal(endActivity(starts, 'chat-b'), starts)
  assert.equal(renameActivity(starts, 'draft', 'chat-c'), starts)
})

test('previous-session events are rejected before sequence dedupe mutates', () => {
  const seen = new Set([1])
  assert.equal(shouldAcceptSessionEvent('active', 'previous', { type: 'error', seq: 2 }, seen), false)
  assert.deepEqual([...seen], [1])
  assert.equal(shouldAcceptSessionEvent('active', 'active', { type: 'status', seq: 2 }, seen), true)
  assert.deepEqual([...seen], [1, 2])
  assert.equal(shouldAcceptSessionEvent('active', 'active', { type: 'status', seq: 2 }, seen), false)
})

test('design artifact validation accepts inline CSS, JavaScript, Canvas, data assets, and fragments', () => {
  assert.deepEqual(validateDesignArtifactHtml(SAFE_DESIGN), {
    ok: true,
    bytes: Buffer.byteLength(SAFE_DESIGN),
    html: SAFE_DESIGN,
  })
  const interactive = documentWith(
    '<canvas id="scene"></canvas><button onclick="cancelAnimationFrame(window.frame)">Pause</button><script>const canvas=document.querySelector("#scene"); const context=canvas.getContext("2d"); context.fillRect(0,0,10,10); window.frame=requestAnimationFrame(() => {}); const example="<iframe src=https://example.com></iframe>";</script>',
  )
  assert.deepEqual(validateDesignArtifactHtml(interactive), {
    ok: true,
    bytes: Buffer.byteLength(interactive),
    html: interactive,
  })
  const cited = documentWith('<p>Source: <a href="https://vercel.com/blog">Vercel blog</a></p>')
  assert.deepEqual(validateDesignArtifactHtml(cited), { ok: true, bytes: Buffer.byteLength(cited), html: cited })
  assert.match(prepareDesignArtifactHtml(cited, DESIGN_ARTIFACT_EMBEDDED_CSP, 'ready-token'), /type:"open",token,url/)
  const prepared = prepareDesignArtifactHtml(interactive)
  assert.match(prepared, /^<!doctype html><script>/i)
  assert.ok(prepared.indexOf('RTCPeerConnection') < prepared.indexOf('const canvas'))
  const embedded = prepareDesignArtifactHtml(interactive, DESIGN_ARTIFACT_EMBEDDED_CSP, 'ready-token')
  assert.match(embedded, /^<!doctype html><meta http-equiv="Content-Security-Policy"/i)
  assert.match(embedded, /parent\.postMessage/)
  assert.match(embedded, /ready-token/)
  assert.ok(embedded.indexOf('RTCPeerConnection') < embedded.indexOf('const canvas'))
})

test('design artifact validation rejects external scripts and scripted navigation', () => {
  assertInvalid(
    documentWith('<script src="https://example.com/app.js"></script>'),
    'design artifact scripts must be inline',
  )
  assertInvalid(
    documentWith('<a href="javascript:alert(1)">Run</a>'),
    'design artifact must not use scripted URLs',
  )
  assertInvalid(
    documentWith('<a href="jav&#x61;script:alert(1)">Run</a>'),
    'design artifact must not use scripted URLs',
  )
})

test('design artifact validation rejects duplicate attributes before browser parsing can diverge', () => {
  assertInvalid(
    documentWith('<a href="https://example.com" href="#safe">Leave</a>'),
    'design artifact must not repeat the href attribute',
  )
  assertInvalid(
    documentWith('', '<meta http-equiv="refresh" http-equiv="x" content="0;url=https://example.com">'),
    'design artifact must not repeat the http-equiv attribute',
  )
  assertInvalid(
    documentWith('<img src="https://example.com/a.png" src="data:image/gif;base64,AA==" alt="">'),
    'design artifact must not repeat the src attribute',
  )
  assertInvalid(
    documentWith('<button onclick="location=\'https://example.com\'" onclick="">Run</button>'),
    'design artifact must not repeat the onclick attribute',
  )
})

test('design artifact validation rejects comments, meta refresh, base, links, and forms', () => {
  assertInvalid(
    documentWith('<!--><meta http-equiv="refresh" content="0;url=/escaped">-->'),
    'design artifact must not contain HTML comments',
  )
  assertInvalid(documentWith('<!probe>'), 'design artifact must not contain markup declarations')
  assertInvalid(documentWith('<?probe>'), 'design artifact must not contain markup declarations')
  assertInvalid(
    documentWith('', '<meta http-equiv="refresh" content="0;url=https://example.com">'),
    'design artifact must not contain meta refresh',
  )
  assertInvalid(
    documentWith('', '<meta http-equiv="r&#x65;fresh" content="0;url=https://example.com">'),
    'design artifact must not contain meta refresh',
  )
  assertInvalid(
    documentWith('', '<base href="https://example.com/">'),
    'design artifact must not contain <base> elements',
  )
  assertInvalid(
    documentWith('<a href="http://example.com">Leave</a>'),
    'design artifact href values must be local fragments, https links, or compatible embedded data: URLs',
  )
  assertInvalid(
    documentWith('<link rel="stylesheet" href="https://example.com/a.css">'),
    'design artifact href values must be local fragments, https links, or compatible embedded data: URLs',
  )
  assertInvalid(
    documentWith('<form action="/submit"><button>Send</button></form>'),
    'design artifact must not contain forms',
  )
})

test('with remote images off, design artifact validation rejects every external asset', () => {
  const local = (html) => validateDesignArtifactHtml(html, { remoteImages: false })
  assert.deepEqual(local(documentWith('<img src="https://example.com/image.png" alt="">')),
    { ok: false, error: 'design artifact src values must use a compatible embedded data: URL' })
  assert.deepEqual(local(documentWith('<img srcset="https://example.com/image.png 2x" alt="">')),
    { ok: false, error: 'design artifact srcset values must contain one embedded data:image URL' })
  assert.deepEqual(local(documentWith('<video poster="https://example.com/p.png"></video>')),
    { ok: false, error: 'design artifact poster values must use an embedded data:image URL' })
  assert.deepEqual(local(documentWith('<svg><image href="https://example.com/a.png"/></svg>')),
    { ok: false, error: 'design artifact href values must be local fragments, https links, or compatible embedded data: URLs' })
})

test('design artifact validation accepts remote https images only where they are images', () => {
  for (const body of [
    '<img src="https://example.com/image.png" alt="">',
    '<img src="https://example.com/a.png?w=10&amp;h=20" alt="">',
    '<img srcset="https://example.com/a.png 1x, https://example.com/b.png 2x" alt="">',
    '<img srcset="https://cdn.example.com/w_100,h_100/a.png 100w,https://cdn.example.com/b.png 200w" alt="">',
    '<picture><source srcset="https://example.com/a.webp"><img src="https://example.com/a.png" alt=""></picture>',
    '<video poster="https://example.com/p.png"></video>',
    '<svg><image href="https://example.com/a.png"/><image xlink:href="https://example.com/b.png"/></svg>',
  ]) assert.equal(validateDesignArtifactHtml(documentWith(body)).ok, true, body)
  assertInvalid(
    documentWith('<img src="http://example.com/image.png" alt="">'),
    'design artifact src values must be an https image URL on <img> or a compatible embedded data: URL',
  )
  assertInvalid(
    documentWith('<img src="https://user:pass@example.com/image.png" alt="">'),
    'design artifact src values must be an https image URL on <img> or a compatible embedded data: URL',
  )
  assertInvalid(
    documentWith(`<img src="https://example.com/${'a'.repeat(2048)}.png" alt="">`),
    'design artifact src values must be an https image URL on <img> or a compatible embedded data: URL',
  )
  assertInvalid(
    documentWith('<audio src="https://example.com/a.mp3"></audio>'),
    'design artifact src values must be an https image URL on <img> or a compatible embedded data: URL',
  )
  assertInvalid(
    documentWith('<video><source src="https://example.com/a.mp4"></video>'),
    'design artifact src values must be an https image URL on <img> or a compatible embedded data: URL',
  )
  assertInvalid(
    documentWith('<img srcset="data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x, https://example.com/image.png 2x" alt="">'),
    'design artifact srcset values must list https image URLs or contain one embedded data:image URL',
  )
  assertInvalid(
    documentWith('<img srcset="https://example.com/a.png 2y" alt="">'),
    'design artifact srcset values must list https image URLs or contain one embedded data:image URL',
  )
  assertInvalid(
    documentWith('<script src="https://example.com/app.js"></script>'),
    'design artifact scripts must be inline',
  )
  assertInvalid(
    documentWith('<link rel="stylesheet" href="https://example.com/a.css">'),
    'design artifact href values must be local fragments, https links, or compatible embedded data: URLs',
  )
})

test('design artifact validation rejects external action values', () => {
  assertInvalid(
    documentWith('<button formaction="/submit">Send</button>'),
    'design artifact must not contain formaction attributes',
  )
})

test('design artifact CSP allows isolated inline scripts and denies ambient capabilities', () => {
  assert.match(DESIGN_ARTIFACT_EMBEDDED_CSP, /script-src 'unsafe-inline'/)
  assert.match(DESIGN_ARTIFACT_EMBEDDED_CSP, /default-src 'none'/)
  assert.match(DESIGN_ARTIFACT_EMBEDDED_CSP, /connect-src 'none'/)
  assert.match(DESIGN_ARTIFACT_EMBEDDED_CSP, /worker-src 'none'/)
  assert.match(DESIGN_ARTIFACT_EMBEDDED_CSP, /style-src 'unsafe-inline'/)
  assert.doesNotMatch(DESIGN_ARTIFACT_EMBEDDED_CSP, /allow-same-origin|https?:|style-src[^;]*\*/)
})

// JavaScript's whitespace (what trim() and \s remove) that the HTML parser does not
// skip before a doctype: any of these first starts the body.
const HTML_SPACES = ['\t', '\n', '\f', '\r', ' ']
const NON_HTML_SPACES = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code))
  .filter((character) => /\s/.test(character) && !HTML_SPACES.includes(character))
const codePoint = (character) => `U+${character.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`

test('a design is validated, stored, and rendered as one normalized document, its CSP first in <head>', () => {
  assert.ok(['\v', '\u00a0', '\u2028', '\u3000', '\ufeff'].every((space) => NON_HTML_SPACES.includes(space)))
  const cspFirst = '<!doctype html><meta http-equiv="Content-Security-Policy"'
  for (const space of [...HTML_SPACES, ...NON_HTML_SPACES]) {
    const variants = [space + SAFE_DESIGN, SAFE_DESIGN + space, SAFE_DESIGN.replace('<!doctype html>', `<!DOCTYPE${space}html${space}>`)]
    for (const raw of variants) {
      const label = `${codePoint(space)} in ${JSON.stringify(raw.slice(0, 20))}`
      const validation = validateDesignArtifactHtml(raw)
      assert.deepEqual(validation, { ok: true, bytes: Buffer.byteLength(SAFE_DESIGN), html: SAFE_DESIGN }, label)
      assert.equal(normalizeDesignArtifactHtml(validation.html), validation.html, `${label}: normalizing twice changes nothing`)
      const rendered = prepareDesignArtifactHtml(raw, DESIGN_ARTIFACT_EMBEDDED_CSP, 'token')
      assert.ok(rendered.startsWith(cspFirst), label)
      // A raw design stored before normalization renders exactly like the stored form.
      assert.equal(rendered, prepareDesignArtifactHtml(validation.html, DESIGN_ARTIFACT_EMBEDDED_CSP, 'token'), label)
    }
  }
})

test('a design that does not start with its doctype is rejected with what it starts with, and never rendered', () => {
  assertInvalid(`Here is the design:\n${SAFE_DESIGN}`,
    'design artifact must start with <!doctype html>, but it starts with "Here is the design:\\n<!do…"')
  // U+200B is invisible but not whitespace, so it is spelled out rather than trimmed.
  assertInvalid(`\u200b${SAFE_DESIGN}`,
    'design artifact must start with <!doctype html>, but it starts with "\\u200b<!doctype html><html><h…"')
  for (const html of [`\u200b${SAFE_DESIGN}`, '<main>fragment</main>', '']) {
    assert.equal(prepareDesignArtifactHtml(html, DESIGN_ARTIFACT_EMBEDDED_CSP, 'token'), null, JSON.stringify(html.slice(0, 20)))
  }
})

test('design artifact validation rejects fragments and oversized documents', () => {
  assertInvalid('<main>fragment</main>', 'design artifact must start with <!doctype html>, but it starts with "<main>fragment</main>"')
  const oversized = '<!doctype html><html><head></head><body>' + 'x'.repeat(MAX_DESIGN_ARTIFACT_BYTES) + '</body></html>'
  assertInvalid(oversized, 'design artifact exceeds 512 KiB')
})

test('every catalog design.md ships as a file within the size limit', () => {
  assert.equal(DESIGN_MD_CATALOG.length, 10)
  for (const option of DESIGN_MD_CATALOG) {
    const text = readFileSync(new URL(`../lib/design-md/${option.id}.md`, import.meta.url), 'utf8')
    assert.ok(text.trim().length > 0, option.id)
    assert.ok(Buffer.byteLength(text) <= DESIGN_MD_MAX_BYTES, option.id)
  }
})

test('a design.md request names a catalog file or carries a bounded text upload', () => {
  assert.equal(parseDesignMdRequest(undefined), null)
  assert.deepEqual(parseDesignMdRequest({ id: 'stripe' }), { option: DESIGN_MD_CATALOG.find((o) => o.id === 'stripe') })
  assert.deepEqual(parseDesignMdRequest({ id: '../package' }), { error: 'unknown design.md' })
  assert.deepEqual(parseDesignMdRequest('apple'), { error: 'invalid design.md' })
  assert.deepEqual(parseDesignMdRequest({ name: 'C:\\brand\\DESIGN.md', text: '# Brand\r\nUse blue.\r\n' }), {
    upload: { name: 'DESIGN.md', source: 'upload', text: '# Brand\nUse blue.\n' },
  })
  assert.deepEqual(parseDesignMdRequest({ text: '# Brand' }), { upload: { name: 'design.md', source: 'upload', text: '# Brand' } })
  assert.deepEqual(parseDesignMdRequest({ name: 'a.md', text: '  \n ' }), { error: 'design.md is empty.' })
  assert.deepEqual(parseDesignMdRequest({ name: 'a.md', text: 'bin\u0000ary' }), { error: 'design.md must be a text file.' })
  assert.deepEqual(parseDesignMdRequest({ name: 'a.md', text: 42 }), { error: 'design.md must be a text file.' })
  // The limit counts UTF-8 bytes, not characters.
  assert.deepEqual(parseDesignMdRequest({ name: 'a.md', text: 'é'.repeat(DESIGN_MD_MAX_BYTES / 2 + 1) }), {
    error: 'design.md must be 100 KB or smaller.',
  })
})

test('the first user bubble shows the design.md only when the server applied it', () => {
  const pending = [{ key: 'c1', type: 'user', clientId: 'c1', text: 'Design a page', designMd: 'Apple', pending: true }]
  const applied = applyStreamItem(pending, {
    type: 'user', id: 1, seq: 1, clientId: 'c1', text: 'Design a page', designMd: { name: 'Apple', source: 'getdesign:apple' },
  })
  assert.equal(applied[0].designMd, 'Apple')
  assert.equal(applied[0].pending, false)
  const ignored = applyStreamItem(pending, { type: 'user', id: 1, seq: 1, clientId: 'c1', text: 'Design a page' })
  assert.equal(ignored[0].designMd, undefined)
  const replayed = replayEvents([
    { type: 'user', id: 1, seq: 1, text: 'Design a page', designMd: { name: 'Stripe', source: 'getdesign:stripe' } },
  ])
  assert.equal(replayed.entries[0].designMd, 'Stripe')
})

test('a page URL opens a chat only when its s names one, by the first paint\'s rule', () => {
  assert.deepEqual(urlChat(''), { kind: 'new' })
  assert.deepEqual(urlChat('?preview=1'), { kind: 'new' })
  assert.deepEqual(urlChat('?s=0f8e2a3c-1b2d-4c5e-8f90-123456789abc&preview=1'), { kind: 'chat', id: '0f8e2a3c-1b2d-4c5e-8f90-123456789abc' })
  // An s that cannot name a chat is never cleaned up into one, and never `lobby`.
  for (const search of ['?s=', '?s=Chat-A', '?s=..%2Fchat', `?s=${'a'.repeat(41)}`]) {
    assert.deepEqual(urlChat(search), { kind: 'invalid' }, search)
  }
})

test('every page limits images to the app, data: and blob:', async () => {
  const { default: config } = await import('../next.config.mjs')
  const rules = (await config.headers()).filter(({ source }) => source === '/:path*')
  const policies = rules.flatMap(({ headers }) => headers.filter(({ key }) => key === 'Content-Security-Policy').map(({ value }) => value))
  assert.deepEqual(policies, ["img-src 'self' data: blob:"])
})
