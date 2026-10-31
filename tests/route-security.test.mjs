import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import babel from 'next/dist/compiled/babel/core.js'
import presetTypescript from 'next/dist/compiled/babel/preset-typescript.js'
import presetReact from 'next/dist/compiled/babel/preset-react.js'
import { AuthError } from '../lib/accounts.ts'

// External boundaries only: production wrappers, accounts SQL, CSRF policy,
// route handlers, page and metadata all run unchanged. No network or libfx.
const root = new URL('../', import.meta.url)
const mocks = {
  'lib/trial.ts': `
    export const trialEnabled = () => !!globalThis.securityTest.trialEnabled;
    export const getGuestSession = async () => globalThis.securityTest.guest ?? null;
    export async function clearGuestSession() { globalThis.securityTest.trace.push('clear-guest'); globalThis.securityTest.guest = null; }
    export async function createGuestSession() {
      const s = globalThis.securityTest;
      if (!s.trialEnabled) throw new Error('Trials disabled');
      return s.guest ??= { kind: 'guest', userId: 'guest:' + 'a'.repeat(32), loginId: 'a'.repeat(32), loginAt: 1000, expiresAt: Date.now() + 86400000 };
    }
    export const guestUser = guest => ({ id: guest.userId, name: 'You', email: null, picture: null, guest: true });
    export const trialIpHash = () => 'verified-ip-hash';
    export const remainingFreePrompts = async () => globalThis.securityTest.trialEnabled ? 5 - (globalThis.securityTest.trialUsed ?? 0) : null;
    export const trialStore = () => ({
      async remaining() { return 5 - (globalThis.securityTest.trialUsed ?? 0) },
      async reserve(bucket, clientId) {
        const s = globalThis.securityTest; s.trace.push('trial-reserve');
        if ((s.trialUsed ?? 0) >= 5) return null;
        s.trialUsed = (s.trialUsed ?? 0) + 1;
        return { bucket, clientId, token: 'reserved', remaining: 5 - s.trialUsed };
      },
      async commit() { globalThis.securityTest.trace.push('trial-commit') },
      async release() { globalThis.securityTest.trialUsed--; },
    });
  `,
  'lib/auth.ts': `
    import { AuthError } from './accounts.ts';
    export { needsTokenRefresh, refreshAccessToken, sessionWithRefresh } from ${JSON.stringify(new URL('../lib/auth.ts?security-original', import.meta.url).href)};
    export async function requireUserSession() {
      const s = globalThis.securityTest; s.trace.push('auth');
      if (!s.session) throw new AuthError(); return s.session;
    }
    export function publicUser(s) { return { id: s.userId, name: s.name, email: s.email, picture: s.picture || null }; }
    export async function resolveGrantedTeam(s) {
      if (!s.teamId?.startsWith('team_')) throw new AuthError(403, 'Grant required');
      return { teamId: s.teamId, teamSlug: s.teamSlug };
    }
    export async function listGatewayTeams() {
      globalThis.securityTest.trace.push('teams'); return [{ teamId: 'team_a', teamSlug: 'a' }];
    }
  `,
  'lib/secure-session.ts': `
    export * from ${JSON.stringify(new URL('../lib/secure-session.ts?security-original', import.meta.url).href)};
    export async function getGrantFromRequest() {
      const s = globalThis.securityTest; s.trace.push('auth'); return s.session ?? {};
    }
    export async function getSessionFromRequest() { return globalThis.securityTest.session ?? {}; }
  `,
  'lib/session.ts': `
    export const DEFAULT_MODEL = 'test/default';
    export const effectiveModel = host => host.preferredModel ?? 'anthropic/claude-opus-5.5-fast';
    export const effectiveEffort = host => host.preferredEffort ?? 'low';
    export function log() {}
    export function getSession(id) { const s = globalThis.securityTest; s.trace.push('host'); return { id }; }
    export function registry() { return globalThis.securityTest.registry ?? new Map(); }
    export function generationOptionsFor() { return { model: 'test/default', effort: '', fast: false }; }
  `,
  'lib/gateway-session.ts': `
    export function bindGatewaySession(host, session) {
      globalThis.securityTest.trace.push('bind'); host.boundUser = session.userId;
    }
  `,
  'lib/history.ts': `
    export async function readGeneration() { const s = globalThis.securityTest; s.trace.push('history'); return s.generationHtml ?? null; }
    export async function recordTurn() { return true; }
    export async function recordGeneration() { return true; }
  `,
  // The session mock ignores cookies, so revoked grants are covered with the real
  // readers in tests/auth.test.mjs.
  'lib/turn-credential.ts': 'export async function loginRevoked() { return false }',
  'lib/journal.ts': `
    function record(name, id) { const s = globalThis.securityTest; s.trace.push(name); s.redisReads.push(id); return s; }
    export async function sessionExists(id) { return record('exists', id).existing.has(id); }
    export async function readSession(id) { return record('state', id).records.get(id) || null; }
    export async function readEvents(id) { record('events', id); return []; }
    export async function readTranscript(id) { const s = record('events', id); if (s.transcriptWait) await s.transcriptWait; return { transcript: { version: 1, entries: [], view: { artifactRevision: 0 }, activeTurnId: null, activeTurnStartedAt: null, startedTurns: [], lastSeq: 0, serverInstance: null }, summary: s.records.get(id) || null }; }
    export async function readSessionView(id) { record('view', id); return { artifactRevision: 0 }; }
    export async function readSessionSummaries(ids) {
      const s = globalThis.securityTest;
      s.trace.push('summaries'); s.summaryCalls.push([...ids]); s.redisReads.push(...ids);
      return ids.map((id) => s.records.get(id)).filter((stored) =>
        stored && (stored.messageCount ?? 1) > 0
      ).map((stored) => ({ id: stored.id, title: stored.title, createdAt: stored.createdAt,
        lastActivity: stored.lastActivity, busy: false }))
        .sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 100);
    }
    export async function readDesignAssets(id, handles) {
      const assets = globalThis.securityTest.assets?.get(id) ?? new Map();
      return new Map([...assets].filter(([h]) => !handles || handles.includes(h)));
    }
    export async function recordDesignAssets() {}
    export const MAX_CHAT_ASSETS = 50; export const MAX_DAILY_ASSETS = 100;
    export async function reserveDesignAssets() { return globalThis.securityTest.assetLimit ?? 'ok'; }
    export async function releaseDesignAssets() {}
    export async function finishDesignAssetCleanup() {}
    export async function pendingDesignAssetCleanups() { globalThis.securityTest.trace.push('cleanup-retry'); return []; }
    export async function queueDesignAssetCleanup() {}
    export async function readDesignArtifact(id) { record('artifact', id); return '<!doctype html><html><head><title>private design</title></head><body>private artifact</body></html>'; }
    export async function readDesignArtifactAt(id) {
      const s = record('artifact', id);
      return { html: s.liveHtml ?? (s.liveRevision === 0 ? null : '<!doctype html><html><head><title>private design</title></head><body>private artifact</body></html>'), revision: s.liveRevision ?? 1 };
    }
    export async function currentSeq(id) { record('seq', id); return 0; }
    export async function acknowledgeCapture(id) { record('capture-ack', id); return true; }
    export async function answerCapture(id, cid, answer) { record('capture-answer', id); globalThis.securityTest.captureAnswer = answer; return true; }
  `,
  'lib/agent.ts': `
    function effect(name, host) {
      if (globalThis.securityTest.session && host.boundUser !== globalThis.securityTest.session.userId) throw new Error('Unbound gateway host');
      globalThis.securityTest.trace.push(name);
    }
    export async function warmChat(host) { effect('warm', host); }
    export function assertPromptFunding() {}
    export function log() {}
    export async function submitPrompt(host, author, ...args) { effect('prompt', host); globalThis.securityTest.author = author; globalThis.securityTest.text = args[0]; globalThis.securityTest.funding = args[5]; return { id: 1, seq: globalThis.securityTest.submittedSeq ?? 1, trialChat: !!args[5] || !!globalThis.securityTest.generationOptions?.trialChat }; }
    export async function followChat(host) { effect('wake', host); }
    export async function renewTurnCredential(host) { effect('renew', host); }
    export async function cancelCurrent(host) { effect('cancel', host); return true; }
    export async function answerQuestion(host) { effect('answer', host); return true; }
    export async function getSessionGenerationOptions(host) { effect('generation', host); return globalThis.securityTest.generationOptions ?? { model: 'test/default', effort: '', fast: false }; }
    export async function setSessionGeneration(host) { effect('setGeneration', host); return { ok: true }; }
    export async function deleteDesignSession(host) {
      effect('delete', host);
      const s = globalThis.securityTest;
      if (s.deleteResult === 'throw') throw new Error('Redis cleanup failed with secret');
      if (!s.deleteResult) return false;
      s.trace.push('redis-clean'); return true;
    }
    export async function debugState(host) {
      effect('debug', host);
      return { session: host.id, busy: false, seq: 4,
        journal: [{ seq: 4, at: 1, type: 'status', text: 'ready', accessToken: 'credential-secret', gatewayContext: { refreshToken: 'credential-secret' } }],
        accessToken: 'credential-secret', gatewayContext: { refreshToken: 'credential-secret' } };
    }
  `,
  'lib/event-stream.ts': `
    export function createSessionEventStream(id, options) {
      globalThis.securityTest.streamOptions = options;
      globalThis.securityTest.trace.push('stream'); options.wake();
      return new ReadableStream({ start(c) { c.enqueue('data: {}\\n\\n'); c.close(); } });
    }
  `,
  'components/chat-app.tsx': 'export default function ChatApp() {}',
  'lib/remote-image-cache.ts': `
    export async function cachedRemoteImage() { return 'data:image/png;base64,aW1hZ2U='; }
    export async function cachedGoogleFontCss() { return '@font-face{font-family:Test}'; }
  `,
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@vercel/blob') return { url: 'security-test:blob', shortCircuit: true }
    if (specifier === 'botid/server') return { url: 'security-test:botid', shortCircuit: true }
    if (specifier === '@neondatabase/serverless') return { url: 'security-test:neon', shortCircuit: true }
    if (specifier === 'next/headers') return { url: 'security-test:headers', shortCircuit: true }
    if (specifier === 'next/navigation') return { url: 'security-test:navigation', shortCircuit: true }
    // after() needs a Next request scope; the prompt route's follow-up is recorded instead.
    if (specifier === 'next/server' && context.parentURL?.endsWith('/app/api/prompt/route.ts')) return { url: 'security-test:next-server', shortCircuit: true }
    // connection() needs a Next request scope too; outside one it only has to resolve.
    if (specifier === 'next/server.js' && /\/app\/(page\.tsx|api\/(models|session)\/route\.ts)$/.test(context.parentURL ?? '')) return { url: 'security-test:connection', shortCircuit: true }
    if (specifier.startsWith('.')) {
      let url = new URL(specifier, context.parentURL)
      if (!/\.[cm]?[jt]sx?$/.test(url.pathname)) {
        url = new URL(url.href + (url.pathname.endsWith('/chat-app') ? '.tsx' : '.ts'))
      }
      if (url.href.startsWith(root.href) && !url.pathname.includes('/node_modules/')) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'security-test:blob') return { format: 'module', shortCircuit: true, source: `
      export async function get() {
        const s = globalThis.securityTest; s.blobGets = (s.blobGets ?? 0) + 1;
        return { statusCode: 200, stream: new Blob(['image']).stream() };
      }
      export async function put() { throw new Error('Unexpected Blob upload'); }
      export async function del() {}
      export async function list() { return { blobs: [], hasMore: false }; }
    ` }
    if (url === 'security-test:neon') return { format: 'module', shortCircuit: true, source: `
      export function neon() { return { query: async (text, values) => globalThis.securityTest.query(text, values) }; }
    ` }
    if (url === 'security-test:connection') return { format: 'module', shortCircuit: true, source: 'export async function connection() {} export function after(work) { globalThis.securityTest.afterTasks.push(work); }' }
    if (url === 'security-test:next-server') return { format: 'module', shortCircuit: true, source: 'export function after(work) { globalThis.securityTest.trace.push(\'after\'); globalThis.securityTest.afterTasks.push(work); }' }
    if (url === 'security-test:headers') return { format: 'module', shortCircuit: true, source: 'export async function cookies() { return { get() {} }; } export async function headers() { return new Headers(); }' }
    if (url === 'security-test:botid') return { format: 'module', shortCircuit: true, source: 'export async function checkBotId() { globalThis.securityTest.trace.push("botid"); return { isBot: !!globalThis.securityTest.bot, isHuman: !globalThis.securityTest.bot }; }' }
    if (url === 'security-test:navigation') return { format: 'module', shortCircuit: true, source: `
      export function redirect(url) { throw Object.assign(new Error('redirect'), { kind: 'redirect', url }); }
      export function notFound() { throw Object.assign(new Error('notFound'), { kind: 'notFound' }); }
    ` }
    const relative = url.startsWith(root.href) ? url.slice(root.href.length) : ''
    if (relative in mocks) return { format: 'module', shortCircuit: true, source: mocks[relative] }
    if (relative === 'app/page.tsx') {
      return { format: 'module', shortCircuit: true, source: babel.transformSync(readFileSync(new URL(url), 'utf8'), {
        filename: 'page.tsx', babelrc: false, configFile: false,
        presets: [presetTypescript, [presetReact, { runtime: 'automatic' }]],
      }).code }
    }
    return next(url, context)
  },
})

process.env.APP_URL = 'https://fx0.example'
process.env.DATABASE_URL = 'postgresql://test-only/unused'
const own = 'a4b0d934-8e2a-4c19-924e-18a491b16767'
const foreign = 'b4b0d934-8e2a-4c19-924e-18a491b16767'
const fresh = 'c4b0d934-8e2a-4c19-924e-18a491b16767'
const session = (extra = {}) => ({ userId: 'user_a', name: 'Verified Author', email: 'a@example.test',
  accessToken: 'user-token', refreshToken: 'secret-refresh', teamId: 'team_a', teamSlug: 'a',
  loginId: 'a'.repeat(32), loginAt: Date.now(), expiresAt: Date.now() + 3600_000, isLoggedIn: true, ...extra })
function reset(extra = {}) {
  const state = { session: session(), trace: [], queries: [], redisReads: [], summaryCalls: [], afterTasks: [],
    owners: new Map([[own, 'user_a'], [foreign, 'user_b']]),
    billingTeams: new Map([[own, 'team_a'], [foreign, 'team_b']]),
    existing: new Set(), records: new Map(), deleteResult: true, ...extra }
  state.query = async (text, values) => {
    state.queries.push({ text, values })
    if (text.startsWith('SELECT user_id')) {
      state.trace.push('owner')
      return state.owners.has(values[0]) ? [{ user_id: state.owners.get(values[0]), billing_team_id: state.billingTeams.get(values[0]) }] : []
    }
    if (text.startsWith('SELECT session_id')) {
      state.trace.push('list-own')
      const rows = [...state.owners].filter(([, owner]) => owner === values[0]).map(([session_id]) => ({ session_id, activity_at: '2026-10-12T00:00:00.000Z' }))
      if (!text.includes('LIMIT')) return rows
      return rows.sort((a, b) => b.session_id.localeCompare(a.session_id)).filter((row) => !values[2] || row.session_id < values[2]).slice(0, values[3])
    }
    if (text.startsWith('WITH account')) {
      state.trace.push('reserve')
      if (state.owners.has(values[0])) return []
      state.owners.set(values[0], values[1]); state.billingTeams.set(values[0], values[5]);
      return [{ session_id: values[0] }]
    }
    if (text.startsWith('DELETE')) {
      state.trace.push('remove-owner')
      if (state.owners.get(values[0]) !== values[1]) return []
      state.owners.delete(values[0]); return [{ session_id: values[0] }]
    }
    if (text.startsWith('UPDATE fx0_chat_ownership')) {
      state.trace.push('activity')
      return []
    }
    throw new Error('Unexpected query')
  }
  globalThis.securityTest = state
  return state
}
function request(path, method = 'GET', id = own, body, origin = process.env.APP_URL) {
  const req = new Request(`https://fx0.example/api/${path}${id ? '?session=' + id : ''}`, {
    method, headers: { origin, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const readBody = req.json.bind(req)
  req.json = () => { globalThis.securityTest.trace.push('body'); return readBody() }
  return req
}
const routes = {}
for (const name of ['answer', 'artifact', 'artifact-frame', 'capture', 'artifact-image', 'cancel', 'debug', 'events',
  'credits', 'model', 'prompt', 'session', 'sessions', 'teams', 'warm']) {
  routes[name] = await import(`../app/api/${name}/route.ts`)
}
// The model catalog is public on purpose: it carries no account data.
const modelsRoute = await import('../app/api/models/route.ts')
const page = await import('../app/page.tsx')
const policy = await import('../lib/route-auth.ts')

test('a human without OAuth can send five sponsored prompts, and the sixth never reaches the agent', async () => {
  const state = reset({ session: null, trialEnabled: true })
  for (let i = 0; i < 5; i++) {
    const response = await routes.prompt.POST(request('prompt', 'POST', 'new', { text: 'Hi', clientId: `free-${i}` }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-fx0-free-prompts'), String(4 - i))
    assert.equal(state.funding?.kind, 'trial')
    assert.equal(state.funding?.userId, state.guest.userId)
    assert.equal(state.funding?.accessToken, undefined)
    await response.text()
  }
  const before = state.trace.filter(x => x === 'prompt').length
  const response = await routes.prompt.POST(request('prompt', 'POST', 'new', { text: 'Sixth', clientId: 'sixth' }))
  assert.equal(response.status, 402)
  assert.equal((await response.json()).code, 'trial_exhausted')
  assert.equal(state.trace.filter(x => x === 'prompt').length, before)
})

test('sponsorship also covers a signed-in default-model user, while other models stay on user billing', async () => {
  const state = reset({ trialEnabled: true, generationOptions: { model: 'anthropic/claude-opus-5.5-fast', effort: 'low', fast: true } })
  let response = await routes.prompt.POST(request('prompt', 'POST', 'new', { text: 'Hi', clientId: 'signed-in', generation: { model: 'anthropic/claude-opus-5.5-fast' } }))
  assert.equal(response.status, 200)
  assert.equal(state.funding?.kind, 'trial')
  assert.equal(state.funding?.userId, state.session.userId)
  await response.text()
  response = await routes.prompt.POST(request('prompt', 'POST', own, { text: 'Paid history stays paid', clientId: 'existing-paid' }))
  assert.equal(response.status, 200)
  assert.equal(state.funding, undefined)
  await response.text()
  response = await routes.prompt.POST(request('prompt', 'POST', 'new', { text: 'Hi', clientId: 'paid', generation: { model: 'another/model' } }))
  assert.equal(response.status, 200)
  assert.equal(state.funding, undefined)
  assert.equal(state.trialUsed, 1)
  await response.text()
})

test('a chat reserved while typing still receives its first free prompt with the submitted draft settings', async () => {
  const state = reset({ trialEnabled: true, generationOptions: { model: '', effort: '', fast: false, unstarted: true } })
  const reserved = await routes.sessions.POST(request('sessions', 'POST', null))
  const { id } = await reserved.json()
  const response = await routes.prompt.POST(request('prompt', 'POST', id, { text: 'Hi', clientId: 'reserved-free', generation: { model: 'anthropic/claude-opus-5.5-fast' } }))
  assert.equal(response.status, 200)
  assert.equal(state.funding?.kind, 'trial')
  assert.equal(state.trialUsed, 1)
  await response.text()
})

test('rejected guest input creates no ownership row or runtime, and a failed reservation refunds its free slot', async () => {
  let state = reset({ session: null, trialEnabled: true })
  assert.equal((await routes.prompt.POST(request('prompt', 'POST', 'new', { text: '' }))).status, 400)
  assert.equal(state.trace.includes('reserve'), false)
  assert.equal(state.trace.includes('host'), false)
  state = reset({ session: null, trialEnabled: true, trialUsed: 5 })
  assert.equal((await routes.prompt.POST(request('prompt', 'POST', 'new', { text: 'Sixth' }))).status, 402)
  assert.equal(state.trace.includes('reserve'), false)
  assert.equal(state.trace.includes('host'), false)
  state = reset({ session: null, trialEnabled: true })
  const query = state.query
  state.query = async (sql, values) => { if (sql.startsWith('WITH account')) throw new Error('synthetic database failure'); return query(sql, values) }
  assert.equal((await routes.prompt.POST(request('prompt', 'POST', 'new', { text: 'Hi' }))).status, 503)
  assert.equal(state.trialUsed, 0)
  assert.equal(state.trace.includes('host'), false)
})

test('long prompt text reaches the agent whole, and text past the limit is refused before any work', async () => {
  let state = reset()
  const long = 'x'.repeat(256 * 1024)
  const response = await routes.prompt.POST(request('prompt', 'POST', own, { text: long }))
  assert.equal(response.status, 200)
  assert.equal(state.text, long)
  await response.text()
  state = reset()
  const refused = await routes.prompt.POST(request('prompt', 'POST', own, { text: 'é'.repeat(128 * 1024 + 1) }))
  assert.equal(refused.status, 413)
  assert.match((await refused.json()).error, /256 KB/)
  assert.equal(state.trace.includes('prompt'), false)
  assert.equal(state.trace.includes('reserve'), false)
})

test('BotID failure does not gate paid-only models or paid continuation after the allowance', async () => {
  let state = reset({ trialEnabled: true, bot: true, generationOptions: { model: 'paid/model', effort: 'high', fast: false } })
  let response = await routes.prompt.POST(request('prompt', 'POST', own, { text: 'Paid' }))
  assert.equal(response.status, 200)
  assert.equal(state.trace.includes('botid'), false)
  await response.text()
  state = reset({ trialEnabled: true, trialUsed: 5, bot: true, generationOptions: { model: 'anthropic/claude-opus-5.5-fast', effort: 'low', fast: true, trialChat: true } })
  response = await routes.prompt.POST(request('prompt', 'POST', own, { text: 'Paid continuation' }))
  assert.equal(response.status, 200)
  assert.equal(state.trace.includes('botid'), false)
  assert.equal(state.funding, undefined)
  await response.text()
})

test('bots and invalid prompts spend no free allowance; guest cookies do not authorize account APIs or foreign chats', async () => {
  let state = reset({ session: null, trialEnabled: true, bot: true })
  assert.equal((await routes.prompt.POST(request('prompt', 'POST', 'new', { text: 'Hi' }))).status, 403)
  assert.equal(state.queries.length, 0)
  assert.equal(state.trialUsed, undefined)
  state = reset({ session: null, trialEnabled: true })
  assert.equal((await routes.prompt.POST(request('prompt', 'POST', 'new', { text: '' }))).status, 400)
  assert.equal(state.trialUsed, undefined)
  assert.equal((await routes.teams.GET(request('teams'))).status, 401)
  assert.equal((await routes.credits.GET(request('credits'))).status, 401)
  assert.equal((await routes.session.GET(request('session', 'GET', foreign))).status, 404)
  assert.equal(state.redisReads.includes(foreign), false)
})
const sessionRoutes = [
  ['answer', 'POST', { qid: 1, answers: { choice: 'yes' } }], ['artifact', 'GET'], ['artifact-frame', 'GET'],
  ['cancel', 'POST'], ['debug', 'GET'], ['events', 'GET'],
  ['model', 'GET'], ['model', 'POST', { model: 'test/model' }],
  ['prompt', 'POST', { text: 'Design a page', author: 'forged-author' }], ['session', 'GET'], ['session', 'DELETE'],
]

test('every existing non-auth handler rejects unauthenticated requests before DB/runtime/body effects', async () => {
  for (const [name, route] of Object.entries(routes)) for (const method of ['GET', 'POST', 'DELETE']) {
    if (!route[method]) continue
    const s = reset({ session: null })
    const response = await route[method](request(name, method))
    assert.equal(response.status, 401, `${method} ${name}`)
    assert.deepEqual(s.trace, ['auth'])
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
  }
})

test('all mutations enforce trusted origin before ownership and any side effects', async () => {
  for (const [name, route] of Object.entries(routes)) for (const method of ['POST', 'DELETE']) {
    if (!route[method]) continue
    for (const origin of ['https://attacker.example', 'null', '']) {
      const s = reset()
      assert.equal((await route[method](request(name, method, own, undefined, origin))).status, 403, `${method} ${name}`)
      assert.deepEqual(s.trace, ['auth'])
    }
  }
})

test('session routes return indistinguishable 404 for unknown and foreign IDs before effects', async () => {
  for (const [name, method, body] of sessionRoutes) {
    for (const id of [foreign, fresh]) {
      const s = reset()
      const response = await routes[name][method](request(name, method, id, body))
      assert.equal(response.status, 404, `${method} ${name} ${id}`)
      assert.deepEqual(await response.json(), { error: 'Session not found' })
      assert.deepEqual(s.trace, ['auth', 'owner'])
      assert.equal(s.queries.length, 1)
      assert.deepEqual(s.redisReads, [])
    }
  }
})

test('a tab acknowledges a capture and reports a known failure; an unknown reason is refused', async () => {
  const s = reset()
  const post = (query) => routes.capture.POST(new Request(`https://fx0.example/api/capture?session=${own}&cid=${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}&${query}`, {
    method: 'POST', headers: { origin: process.env.APP_URL },
  }))
  const ack = await post('ack=1')
  assert.equal(ack.status, 200)
  assert.deepEqual(await ack.json(), { ok: true })
  assert.ok(s.trace.includes('capture-ack'))
  const failed = await post('failed=too-large')
  assert.deepEqual(await failed.json(), { ok: true })
  assert.deepEqual(s.captureAnswer, { kind: 'failed', reason: 'too-large' })
  assert.equal((await post('failed=__proto__')).status, 400)
  assert.equal((await post('failed=anything')).status, 400)
  const unsized = await post('w=1')
  assert.equal(unsized.status, 411, 'a photo without a length is refused before it is read')
})

test('a photo reaches the waiting call; one the route refuses still answers it, with the reason', async () => {
  const s = reset()
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const upload = async (files, query = 'w=1280&h=800', length) => {
    const form = new FormData()
    for (const file of files) form.append('image', new Blob([file], { type: 'image/png' }))
    const encoded = new Response(form)
    const body = await encoded.arrayBuffer()
    return routes.capture.POST(new Request(`https://fx0.example/api/capture?session=${own}&cid=${'2'.repeat(8)}-2222-2222-2222-${'2'.repeat(12)}&${query}`, {
      method: 'POST', body,
      headers: { origin: process.env.APP_URL, 'content-type': encoded.headers.get('content-type'), 'content-length': String(length ?? body.byteLength) },
    }))
  }
  const accepted = await upload([PNG], 'w=1280&h=2400&truncated=1')
  assert.deepEqual(await accepted.json(), { ok: true })
  assert.equal(s.captureAnswer.kind, 'shot')
  assert.deepEqual(s.captureAnswer.shot.images, [{ mimeType: 'image/png', data: PNG.toString('base64') }])
  assert.deepEqual([s.captureAnswer.shot.width, s.captureAnswer.shot.height, s.captureAnswer.shot.truncated], [1280, 2400, true])
  for (const [files, length, status, reason] of [
    [[Buffer.from('not an image at all')], undefined, 415, 'refused'],
    [Array(9).fill(PNG), undefined, 400, 'refused'],
    [[PNG], 10 * 1024 * 1024, 413, 'too-large'],
  ]) {
    s.captureAnswer = null
    assert.equal((await upload(files, undefined, length)).status, status)
    assert.deepEqual(s.captureAnswer, { kind: 'failed', reason }, `a ${status} answers the call`)
  }
})

test('a capture for an unknown or foreign chat is refused before its body or Redis', async () => {
  for (const id of [foreign, fresh]) {
    const s = reset()
    const response = await routes.capture.POST(request('capture', 'POST', id))
    assert.equal(response.status, 404)
    assert.deepEqual(s.trace, ['auth', 'owner'])
    assert.deepEqual(s.redisReads, [])
  }
})

test('the same owner can steer, enqueue or recover a chat after switching teams, with one owner check', async () => {
  for (const [name, method, body] of sessionRoutes) {
    const oldContext = reset()
    const oldResponse = await routes.prompt.POST(request('prompt', 'POST', own, { text: 'Active old-team generation' }))
    assert.equal(oldResponse.status, 200)
    await oldResponse.text()
    const newContext = reset({ owners: oldContext.owners, billingTeams: oldContext.billingTeams,
      session: session({ teamId: 'team_b', teamSlug: 'b', loginId: 'b'.repeat(32), loginAt: Date.now() + 1 }) })
    const response = await routes[name][method](request(name, method, own, body))
    assert.equal(response.status, 200, `${method} ${name}`)
    await response.text()
    assert.deepEqual(newContext.trace.slice(0, 4), ['auth', 'owner', 'host', 'bind'])
    assert.equal(newContext.queries.filter(({ text }) => text.startsWith('SELECT user_id FROM fx0_chat_ownership')).length, 1)
    assert.equal(oldContext.billingTeams.get(own), 'team_a')
  }
})

test('session routes and creation reject unverified team grants before runtime or writes', async () => {
  for (const teamId of [undefined, 'user_a']) {
    for (const [name, method, body] of [...sessionRoutes, ['sessions', 'POST'], ['capture', 'POST']]) {
      const s = reset({ session: session({ teamId }) })
      const response = await routes[name][method](request(name, method, own, body))
      assert.equal(response.status, 403, `${method} ${name}`)
      assert.deepEqual(s.trace, ['auth'])
      assert.equal(s.queries.length, 0)
    }
  }
})

test('malformed/missing IDs never fall back to lobby or sanitize into another chat', async () => {
  for (const id of [null, '../' + own, own.toUpperCase(), '']) {
    const s = reset()
    assert.equal((await routes.session.GET(request('session', 'GET', id))).status, 404)
    assert.deepEqual(s.trace, ['auth'])
  }
})

test('authorized routes bind credentials after one owner check and before body/runtime work', async () => {
  for (const [name, method, body] of sessionRoutes) {
    const s = reset()
    const response = await routes[name][method](request(name, method, own, body))
    assert.equal(response.status, 200, `${method} ${name}`)
    await response.text()
    assert.deepEqual(s.trace.slice(0, 4), ['auth', 'owner', 'host', 'bind'])
    assert.equal(s.queries.filter(({ text }) => text.startsWith('SELECT user_id')).length, 1)
    if (name === 'prompt') assert.equal(s.author, 'Verified Author')
  }
})

test("a runtime already bound to the same user skips the owner query; anyone else still pays it", async () => {
  let s = reset()
  s.registry = new Map([[own, { gatewaySession: { userId: 'user_a' } }]])
  const warm = await routes.model.GET(request('model', 'GET', own))
  assert.equal(warm.status, 200)
  assert.equal(s.queries.filter(({ text }) => text.startsWith('SELECT user_id')).length, 0)
  s = reset({ session: session({ userId: 'user_b', loginId: 'b'.repeat(32) }) })
  s.registry = new Map([[own, { gatewaySession: { userId: 'user_a' } }]])
  assert.equal((await routes.model.GET(request('model', 'GET', own))).status, 404)
  assert.equal(s.queries.filter(({ text }) => text.startsWith('SELECT user_id')).length, 1)
})

test('the artifact preview permits iframe origins but preserves opaque credentialless security', async () => {
  reset()
  const frame = await routes['artifact-frame'].GET(request('artifact-frame', 'GET', own, undefined, 'null'))
  assert.equal(frame.status, 200)
  const html = await frame.text()
  assert.match(html, /setAttribute\('sandbox','allow-scripts'\)/)
  // The design only asks to open a link; the wrapper passes the ask to the app on this
  // origin, which shows the address and opens it on the user's own click.
  assert.doesNotMatch(html, /window\.open/)
  assert.match(html, /if\(event\.source!==frame\.contentWindow\|\|data\?\.token!==token\)return;/)
  assert.match(html, /parent\.postMessage\(\{type:'fx0-artifact-open',url:data\.url\},location\.origin\)/)
  assert.match(html, /navigator\.userActivation\?\.isActive!==false/)
  assert.doesNotMatch(html, /allow-popups/)
  assert.match(html, /setAttribute\('credentialless',''\)/)
  // A blob: frame, not a data: URL, which browsers refuse past 2 MiB. The design string
  // cannot close the wrapper's script: its "<" are escaped, so only one </script> remains.
  assert.match(html, /URL\.createObjectURL\(new Blob\(\[/)
  assert.doesNotMatch(html, /data:text\/html/)
  assert.equal(html.split('</script>').length - 1, 1)
  assert.match(frame.headers.get('content-security-policy'), /frame-src blob:;/)
  assert.doesNotMatch(html, /allow-same-origin|user-token|secret-refresh/)
  assert.match(frame.headers.get('content-security-policy'), /frame-ancestors 'self'/)
})

test('the wrapper\'s image route serves only URLs artifact-frame signed for this chat, and never caches a refusal', async () => {
  if ((process.env.SESSION_SECRET ?? '').length < 32) process.env.SESSION_SECRET = 'deterministic-route-security-secret-32+'
  const { artifactImageSrc } = await import('../lib/artifact-image.ts')
  const url = 'https://images.example.com/a.png'
  // Another user's chat is refused by ownership, even with a URL validly signed for it.
  reset()
  const theirs = await routes['artifact-image'].GET(new Request(`https://fx0.example${artifactImageSrc(foreign, url)}`, { headers: { origin: process.env.APP_URL } }))
  assert.equal(theirs.status, 404)
  for (const query of ['', `&u=${encodeURIComponent(url)}`, `&u=${encodeURIComponent(url)}&sig=${'A'.repeat(43)}`,
    `&${new URL(artifactImageSrc(foreign, url), 'https://fx0.example').searchParams.toString().replace(/^session=[^&]*&/, '')}`]) {
    reset()
    const response = await routes['artifact-image'].GET(new Request(`https://fx0.example/api/artifact-image?session=${own}${query}`, { headers: { origin: process.env.APP_URL } }))
    assert.equal(response.status, 404, query || 'no URL')
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
  }
})

test('private attachments are kept five minutes, then revalidate ownership and the manifest; a 304 never downloads Blob bytes', async () => {
  process.env.SESSION_SECRET ??= 'deterministic-route-security-secret-32+'
  const { artifactImageSrc } = await import('../lib/artifact-image.ts')
  const handle = 'AbCdEfGhIjKlMnOpQrStUvWx'
  const path = artifactImageSrc(own, `fx0-asset:${handle}`)
  const get = (etag) => routes['artifact-image'].GET(new Request(`https://fx0.example${path}`, {
    headers: { origin: process.env.APP_URL, ...(etag ? { 'if-none-match': etag } : {}) },
  }))
  const s = reset({ assets: new Map([[own, new Map([[handle, { mimeType: 'image/png', bytes: 5 }]])]]) })
  const first = await get()
  assert.equal(first.status, 200)
  assert.equal(await first.text(), 'image')
  assert.equal(first.headers.get('cache-control'), 'private, max-age=300')
  const etag = first.headers.get('etag')
  assert.ok(etag)
  const kept = await get(etag)
  assert.equal(kept.status, 304)
  assert.equal(await kept.text(), '')
  assert.equal(kept.headers.get('cache-control'), 'private, max-age=300')
  assert.equal(kept.headers.get('etag'), etag)
  assert.equal(s.blobGets, 1)
  s.assets.clear()
  const removed = await get(etag)
  assert.equal(removed.status, 404)
  assert.equal(removed.headers.get('cache-control'), 'private, no-store')
  assert.equal(s.blobGets, 1)
  s.session = session({ userId: 'user_b', loginId: 'b'.repeat(32) })
  assert.equal((await get(etag)).status, 404)
  s.session = null
  assert.equal((await get(etag)).status, 401)
  assert.equal(s.blobGets, 1)
})

test('public remote image bytes keep their existing private browser cache policy', async () => {
  reset()
  process.env.SESSION_SECRET ??= 'deterministic-route-security-secret-32+'
  const { artifactImageSrc } = await import('../lib/artifact-image.ts')
  const response = await routes['artifact-image'].GET(new Request(`https://fx0.example${artifactImageSrc(own, 'https://images.example.com/a.png')}`))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, max-age=86400')
  assert.equal(await response.text(), 'image')
})

test('a capped attachment still schedules durable cleanup after its refusal; deletion schedules it too', async () => {
  const s = reset({ assetLimit: 'chat' })
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }
  const refused = await routes.prompt.POST(request('prompt', 'POST', own, { text: 'Use this image', images: [image] }))
  assert.equal(refused.status, 429)
  assert.equal(s.afterTasks.length, 1)
  assert.equal(s.trace.includes('cleanup-retry'), false, 'cleanup stays outside the acknowledgement path')
  await s.afterTasks[0]()
  assert.equal(s.trace.includes('cleanup-retry'), true)
  const deleting = reset()
  assert.equal((await routes.session.DELETE(request('session', 'DELETE', own))).status, 200)
  assert.equal(deleting.afterTasks.length, 1)
  await deleting.afterTasks[0]()
  assert.equal(deleting.trace.includes('cleanup-retry'), true)
})

test('a guest who signs in has their chats claimed once, then the guest cookie is dropped', async () => {
  const s = reset({ guest: { kind: 'guest', userId: `guest:${'b'.repeat(32)}`, loginId: 'b'.repeat(32), loginAt: 1000, expiresAt: Date.now() + 86_400_000 } })
  const claims = () => s.queries.filter(({ text }) => text.startsWith('UPDATE fx0_chat_ownership SET user_id')).length
  assert.equal((await routes.session.GET(request('session', 'GET'))).status, 200)
  assert.equal(claims(), 1)
  assert.deepEqual(s.queries.find(({ text }) => text.startsWith('UPDATE fx0_chat_ownership SET user_id')).values, ['user_a', `guest:${'b'.repeat(32)}`])
  assert.ok(s.trace.includes('clear-guest'))
  assert.equal(s.guest, null)
  assert.equal((await routes.session.GET(request('session', 'GET'))).status, 200)
  assert.equal(claims(), 1, 'a later request does not repeat the claim')
})

test('the artifact preview paints no white of its own before the design does', async () => {
  reset()
  const html = await (await routes['artifact-frame'].GET(request('artifact-frame', 'GET', own, undefined, 'null'))).text()
  // The app's color scheme keeps the wrapper transparent over the app's background.
  // The design (and the capture library) travel inside the wrapper's script; only its own markup counts.
  const wrapper = html.slice(0, html.indexOf('<script>'))
  assert.match(wrapper, /:root\{color-scheme:light dark\}/)
  assert.doesNotMatch(wrapper, /background:#fff/)
})

test('the browser keeps a preview only when its URL names the revision that is live', async () => {
  const frame = async (query) => {
    const req = request('artifact-frame', 'GET', own, undefined, 'null')
    return routes['artifact-frame'].GET(new Request(`${req.url}${query}`, req))
  }
  reset()
  globalThis.securityTest.liveRevision = 2
  const current = await frame('&v=2')
  assert.equal(current.status, 200)
  assert.equal(current.headers.get('cache-control'), 'private, no-cache')
  const etag = current.headers.get('etag')
  assert.ok(etag, 'the live revision carries a validator')
  // A kept copy revalidates through the session check and costs an empty 304.
  const revalidate = request('artifact-frame', 'GET', own, undefined, 'null')
  const unchanged = await routes['artifact-frame'].GET(new Request(`${revalidate.url}&v=2`, { headers: { ...Object.fromEntries(revalidate.headers), 'if-none-match': etag } }))
  assert.equal(unchanged.status, 304)
  assert.equal(await unchanged.text(), '')
  // The live design moved on, or the page names none: the bytes may not be v, so nothing is kept.
  for (const query of ['&v=1', '&v=3', '', '&v=abc']) {
    assert.equal((await frame(query)).headers.get('cache-control'), 'private, no-store', query || 'no v')
  }
  globalThis.securityTest.liveRevision = 0
  const missing = await frame('&v=1')
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('cache-control'), 'private, no-store')
})

test('preview update data names the actual revision, never shares HTML validators, and contains no host bootstrap', async () => {
  const state = reset({ liveRevision: 4 })
  const req = request('artifact-frame', 'GET', `${own}&v=2&format=json`)
  req.headers.set('if-none-match', `"${own}:4"`)
  const response = await routes['artifact-frame'].GET(req)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json/)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('etag'), null)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  const data = await response.json()
  assert.equal(data.protocol, 1)
  assert.equal(data.sessionId, own)
  assert.equal(data.revision, 4)
  assert.equal(data.sourceHtml, data.renderHtml)
  assert.deepEqual(data.images, [])
  assert.doesNotMatch(JSON.stringify(data), /fx0-preview-ready|Content-Security-Policy|user-token|secret-refresh/)
  assert.equal(state.redisReads.filter(id => id === own).length, 1, 'source and revision come from one read')
})

test('preview JSON uses the same ownership boundary and refuses missing artifacts or unknown formats', async () => {
  const state = reset()
  assert.equal((await routes['artifact-frame'].GET(request('artifact-frame', 'GET', `${foreign}&format=json`))).status, 404)
  assert.equal(state.redisReads.includes(foreign), false)
  state.liveRevision = 0
  const missing = await routes['artifact-frame'].GET(request('artifact-frame', 'GET', `${own}&format=json`))
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('cache-control'), 'private, no-store')
  assert.equal((await routes['artifact-frame'].GET(request('artifact-frame', 'GET', `${own}&format=unknown`))).status, 400)
})

const frameRequest = (query = '', headers = {}) => {
  const req = request('artifact-frame', 'GET', own, undefined, 'null')
  return new Request(`${req.url}${query}`, { headers: { ...Object.fromEntries(req.headers), ...headers } })
}
const reportsStatus = (status) => new RegExp(`parent\\.postMessage\\(\\{type:'fx0-preview-error',protocol:1,status:${status}\\},location\\.origin\\)`)

test('a failed preview frame reports its status by message and keeps its headers and session cookies', async () => {
  process.env.SESSION_SECRET ??= 'deterministic-route-security-secret-32+'
  const { grantCookieName } = await import('../lib/auth-protocol.ts')
  const s = reset({ session: null })
  const stale = `${grantCookieName('c'.repeat(32))}=expired`
  const response = await routes['artifact-frame'].GET(frameRequest('', { 'sec-fetch-dest': 'iframe', cookie: stale }))
  assert.equal(response.status, 401)
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8/)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('content-length'), null)
  // The session renewal that the wrapper itself adds to every response survives the rewrap.
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${grantCookieName('c'.repeat(32))}=`)))
  const html = await response.text()
  const nonce = /<script nonce="([0-9a-f]{32})">/.exec(html)?.[1]
  assert.ok(nonce)
  assert.equal(response.headers.get('content-security-policy'), `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'self'`)
  assert.match(html, reportsStatus(401))
  assert.doesNotMatch(html, new RegExp(`${own}|user-token|secret-refresh|${grantCookieName('c'.repeat(32))}`))
  // Signed out: only the session read runs; no ownership query, journal read, history read or runtime work.
  assert.deepEqual(s.trace.filter((step) => step !== 'auth'), [])
  assert.deepEqual(s.queries, [])
  assert.deepEqual(s.redisReads, [])
})

test('frame errors keep their statuses; healthy, revalidated and JSON responses are unchanged', async () => {
  const frame = { 'sec-fetch-dest': 'iframe' }
  const cases = [
    ['missing design', '', { liveRevision: 0 }, 404],
    ['unrenderable design', '', { liveHtml: '<p>no doctype</p>' }, 422],
    ['unknown format', '&format=unknown', {}, 400],
  ]
  for (const [name, query, state, status] of cases) {
    reset(state)
    const response = await routes['artifact-frame'].GET(frameRequest(query, frame))
    assert.equal(response.status, status, name)
    assert.match(await response.text(), reportsStatus(status), name)
  }
  reset({ liveHtml: '<p>no doctype</p>' })
  const unprepared = await routes['artifact-frame'].GET(frameRequest(''))
  assert.equal(unprepared.status, 422)
  assert.match(await unprepared.text(), /could not be prepared/)

  reset({ liveRevision: 2 })
  const healthy = await routes['artifact-frame'].GET(frameRequest('&v=2', frame))
  assert.equal(healthy.status, 200)
  const html = await healthy.text()
  assert.doesNotMatch(html, /parent\.postMessage\(\{type:'fx0-preview-error'/)
  const revalidated = await routes['artifact-frame'].GET(frameRequest('&v=2', { ...frame, 'if-none-match': healthy.headers.get('etag') }))
  assert.equal(revalidated.status, 304)
  assert.equal(await revalidated.text(), '')

  reset({ liveRevision: 0 })
  const json = await routes['artifact-frame'].GET(frameRequest('&format=json', frame))
  assert.equal(json.status, 404)
  assert.match(json.headers.get('content-type'), /^application\/json/)
  assert.deepEqual(await json.json(), { error: 'No design artifact.' })
  const programmatic = await routes['artifact-frame'].GET(frameRequest('&format=json', { 'sec-fetch-dest': 'empty' }))
  assert.equal(programmatic.status, 404)
  assert.match(programmatic.headers.get('content-type'), /^application\/json/)
  assert.deepEqual(await programmatic.json(), { error: 'No design artifact.' })
})

test('a failed preview frame answers the parent status handshake only from its own parent, with constant data', async () => {
  reset({ liveRevision: 0 })
  const response = await routes['artifact-frame'].GET(frameRequest('', { 'sec-fetch-dest': 'iframe' }))
  const html = await response.text()
  const [, nonce, script] = /<script nonce="([0-9a-f]{32})">([\s\S]*?)<\/script>/.exec(html)
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('content-security-policy'), `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'self'`)
  // Only the status reaches the script: no session, user, token or design identity.
  assert.doesNotMatch(script, new RegExp(`${own}|session|user|token|secret`))
  const posts = []
  const parent = { postMessage: (message, target) => posts.push([JSON.stringify(message), target]) }
  const listeners = []
  vm.runInNewContext(script, { parent, location: { origin: 'https://fx0.example' }, addEventListener: (type, listener) => listeners.push([type, listener]) })
  const error = JSON.stringify({ type: 'fx0-preview-error', protocol: 1, status: 404 })
  assert.deepEqual(posts, [[error, 'https://fx0.example']], 'the initial post reports the status without waiting')
  const deliver = (data, { source = parent, origin = 'https://fx0.example' } = {}) => {
    for (const [type, listener] of listeners) if (type === 'message') listener({ data, source, origin })
  }
  deliver({ type: 'fx0-preview-status', protocol: 1 })
  assert.deepEqual(posts[1], [error, 'https://fx0.example'], 'the status handshake from the parent is answered')
  deliver({ type: 'fx0-preview-status', protocol: 1 }, { source: {} })
  deliver({ type: 'fx0-preview-status', protocol: 1 }, { origin: 'https://evil.example' })
  deliver({ type: 'fx0-preview-status', protocol: 2 })
  deliver({ type: 'fx0-artifact-open', protocol: 1, url: 'https://example.com' })
  deliver(null)
  assert.equal(posts.length, 2, 'other windows, origins, types and protocols get no answer')
})

test('an iframe asking for a newer revision than is live fails before any design is prepared', async () => {
  const s = reset({ liveRevision: 2 })
  const stale = await routes['artifact-frame'].GET(frameRequest('&v=3', { 'sec-fetch-dest': 'iframe' }))
  assert.equal(stale.status, 404)
  assert.equal(stale.headers.get('etag'), null)
  const html = await stale.text()
  assert.match(html, reportsStatus(404))
  // The wrapper's JSON body is dropped: no design, image marker, runtime or frame remains.
  assert.doesNotMatch(html, /private artifact|frame-root|artifact-image|connect-src|Design artifact preview/)
  assert.equal(stale.headers.get('cache-control'), 'private, no-store')
  // Ownership and sign-in still come first: a signed-out frame answers 401, not the version check.
  reset({ session: null, liveRevision: 2 })
  assert.equal((await routes['artifact-frame'].GET(frameRequest('&v=3', { 'sec-fetch-dest': 'iframe' }))).status, 401)
  assert.equal(s.redisReads.length, 1, 'only the stale request read the journal')
})

test('an iframe asking for the current or a newer revision is served; invalid versions and past revisions are unaffected', async () => {
  for (const [live, v] of [[3, '&v=3'], [4, '&v=3']]) {
    reset({ liveRevision: live })
    const response = await routes['artifact-frame'].GET(frameRequest(v, { 'sec-fetch-dest': 'iframe' }))
    assert.equal(response.status, 200, `live ${live} ${v}`)
    assert.match(await response.text(), /frame-root/)
  }
  reset({ liveRevision: 2 })
  for (const query of ['&v=abc', '&v=0', '&v=-1', '&v=1.5', '']) {
    const response = await routes['artifact-frame'].GET(frameRequest(query, { 'sec-fetch-dest': 'iframe' }))
    assert.equal(response.status, 200, query || 'no v')
  }
  reset({ liveRevision: 2, generationHtml: '<!doctype html><html><head><title>old</title></head><body>old version</body></html>' })
  const past = await routes['artifact-frame'].GET(frameRequest('&revision=1&v=3', { 'sec-fetch-dest': 'iframe' }))
  assert.equal(past.status, 200)
  assert.match(await past.text(), /frame-root/)
})

test('programmatic HTML and JSON keep their current-revision contracts for a newer v', async () => {
  reset({ liveRevision: 2 })
  const html = await routes['artifact-frame'].GET(frameRequest('&v=3', { 'sec-fetch-dest': 'empty' }))
  assert.equal(html.status, 200)
  assert.equal(html.headers.get('cache-control'), 'private, no-store')
  assert.match(await html.text(), /frame-root/)
  const json = await routes['artifact-frame'].GET(frameRequest('&v=3&format=json', { 'sec-fetch-dest': 'iframe' }))
  assert.equal(json.status, 200)
  assert.equal((await json.json()).revision, 2)
  const programmaticJson = await routes['artifact-frame'].GET(frameRequest('&v=3&format=json'))
  assert.equal((await programmaticJson.json()).revision, 2)
})

test('a preview frame status is accepted only as an integer error from 400 to 599', async () => {
  const { isPreviewErrorStatus } = await import('../lib/preview-update.ts')
  for (const status of [400, 401, 404, 422, 503, 599]) assert.equal(isPreviewErrorStatus(status), true, String(status))
  for (const status of [0, 200, 304, 399, 600, 404.5, Number.NaN, Infinity, '404', null, undefined, { status: 404 }]) {
    assert.equal(isPreviewErrorStatus(status), false, String(status))
  }
})

test('image-free wrappers can prepare later images without granting the design network access', async () => {
  reset()
  const response = await routes['artifact-frame'].GET(request('artifact-frame'))
  assert.match(response.headers.get('content-security-policy'), /connect-src https:\/\/fx0\.example\/api\/artifact-image(?:;|$)/)
  const html = await response.text()
  assert.match(html, /connect-src 'none'/)
  assert.doesNotMatch(html, /allow-same-origin|allow-popups/)
})

test('the design download is the stored HTML, served so this origin never renders it', async () => {
  reset()
  const response = await routes.artifact.GET(request('artifact', 'GET', own))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '<!doctype html><html><head><title>private design</title></head><body>private artifact</body></html>')
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.match(response.headers.get('content-disposition'), /^attachment/)
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'; sandbox/)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  // A past version comes from history; one that is not there is a plain 404.
  const missing = await routes.artifact.GET(request('artifact', 'GET', `${own}&revision=3`))
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'This version is not in the history.' })
})

test('debug output cannot serialize credentials, even from journal events', async () => {
  reset()
  const response = await routes.debug.GET(request('debug'))
  const body = await response.text()
  assert.doesNotMatch(body, /credential-secret|accessToken|refreshToken|gatewayContext/)
  assert.deepEqual(JSON.parse(body).journal, [
    { seq: 4, at: 1, type: 'status', turnId: null, instance: null, detail: 'ready' },
  ])
})

test('deletion retains ownership on busy/failed cleanup and removes it only after Redis success', async () => {
  for (const deleteResult of [false, 'throw']) {
    const s = reset({ deleteResult })
    const response = await routes.session.DELETE(request('session', 'DELETE'))
    assert.equal(response.status, deleteResult === false ? 409 : 503)
    assert.equal(s.owners.get(own), 'user_a')
    assert.ok(!s.trace.includes('remove-owner'))
    assert.doesNotMatch(await response.text(), /secret/)
  }
  const s = reset()
  assert.equal((await routes.session.DELETE(request('session', 'DELETE'))).status, 200)
  assert.ok(s.trace.indexOf('redis-clean') < s.trace.indexOf('remove-owner'))
  assert.equal(s.owners.has(own), false)
})

test('POST sessions reserves a server-generated UUID before any prompt or Redis writes', async () => {
  const s = reset()
  const response = await routes.sessions.POST(request('sessions', 'POST', null, { sessionId: foreign, billingTeamId: 'team_forged', teamId: 'team_forged', userId: 'user_forged' }))
  assert.equal(response.status, 201)
  const { id, sessionId } = await response.json()
  assert.equal(id, sessionId)
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(id, foreign)
  assert.equal(s.owners.get(id), 'user_a')
  assert.equal(s.billingTeams.get(id), 'team_a')
  assert.equal(s.queries[0].values[5], 'team_a')
  assert.deepEqual(s.trace, ['auth', 'exists', 'reserve'])
})

test('prompt streams include the requested missing prefix and cannot skip their admitted user event', async () => {
  for (const [afterSeq, expected] of [[0, 0], [40, 40], [999, 79], [-1, 79], [1.5, 79], ['40', 79], [undefined, 79]]) {
    const s = reset()
    s.submittedSeq = 80
    const response = await routes.prompt.POST(request('prompt', 'POST', own, { text: 'Design', afterSeq }))
    assert.equal(response.status, 200)
    assert.equal(s.streamOptions.afterSeq, expected)
    await response.body?.cancel()
  }
})

test('the chat event stream ends itself before its route reaches the function time limit', async () => {
  const s = reset()
  const response = await routes.events.GET(request('events'))
  assert.equal(response.status, 200)
  assert.ok(s.streamOptions.maxLifetimeMs > 0)
  assert.ok(s.streamOptions.maxLifetimeMs < routes.events.maxDuration * 1000)
  await response.body?.cancel()
})

test('a draft prompt creates its chat in the same request and returns the server id; no other route accepts "new"', async () => {
  const s = reset()
  const response = await routes.prompt.POST(request('prompt', 'POST', 'new', { text: 'Design a page' }))
  assert.equal(response.status, 200)
  const id = response.headers.get('x-fx0-session')
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(s.owners.get(id), 'user_a')
  assert.equal(s.billingTeams.get(id), 'team_a')
  assert.deepEqual(s.trace.slice(0, 6), ['auth', 'body', 'exists', 'reserve', 'host', 'bind'])
  assert.ok(!s.queries.some(({ text }) => text.startsWith('SELECT user_id')))
  await response.body?.cancel()
  const existing = await routes.prompt.POST(request('prompt', 'POST', own, { text: 'Again' }))
  assert.equal(existing.headers.get('x-fx0-session'), null)
  await existing.body?.cancel()
  for (const name of ['model', 'events', 'session']) {
    reset()
    assert.equal((await routes[name].GET(request(name, 'GET', 'new'))).status, 404, name)
  }
})

test('a new login team can create and prompt a new chat without changing the old chat billing', async () => {
  const oldContext = reset()
  const s = reset({ owners: oldContext.owners, billingTeams: oldContext.billingTeams,
    session: session({ teamId: 'team_b', teamSlug: 'b', loginId: 'b'.repeat(32), loginAt: Date.now() + 1 }) })
  const created = await routes.sessions.POST(request('sessions', 'POST', null, { billingTeamId: 'team_a' }))
  assert.equal(created.status, 201)
  const { id } = await created.json()
  assert.equal(s.billingTeams.get(id), 'team_b')
  const response = await routes.prompt.POST(request('prompt', 'POST', id, { text: 'New-team generation' }))
  assert.equal(response.status, 200)
  await response.text()
  assert.equal(s.billingTeams.get(own), 'team_a')
})

test('reservation never adopts existing Redis data or conflicting owner records', async () => {
  const s = reset({ existing: new Set([fresh]) })
  await assert.rejects(policy.reserveNewSession({ id: 'user_a', name: 'A', email: null, picture: null }, 'team_a', fresh), (error) => error.status === 404)
  assert.equal(s.queries.length, 0)
  assert.equal(s.owners.has(fresh), false)
  await assert.rejects(policy.reserveNewSession({ id: 'user_a', name: 'A', email: null, picture: null }, 'team_a', foreign), (error) => error.status === 404)
  assert.equal(s.owners.get(foreign), 'user_b')
})

test('session lists batch only Neon-owned Redis IDs, without per-chat reads or a global scan', async () => {
  const s = reset()
  s.records.set(own, { id: own, title: 'Private A', createdAt: 1, lastActivity: 2 })
  s.records.set(foreign, { id: foreign, title: 'Private B', createdAt: 1, lastActivity: 3 })
  const response = await routes.sessions.GET(request('sessions', 'GET', null))
  assert.deepEqual((await response.json()).sessions.map(({ id }) => id), [own])
  assert.ok(s.redisReads.every((id) => id === own))
  assert.deepEqual(s.summaryCalls, [[own]])
  assert.deepEqual(s.trace, ['auth', 'list-own', 'summaries'])
  assert.equal(s.queries.length, 1)
  assert.match(s.queries[0].text, /WHERE user_id = \$1/)
})

test('listing bounds ownership and Redis work and exposes a cursor for older chats', async () => {
  const s = reset()
  const ids = Array.from({ length: 500 }, (_, index) => `chat-${String(index).padStart(3, '0')}`)
  for (const [index, id] of ids.entries()) {
    s.owners.set(id, 'user_a')
    s.records.set(id, { id, title: id, createdAt: 1, lastActivity: index })
  }
  const response = await routes.sessions.GET(request('sessions', 'GET', null))
  const { sessions, nextCursor } = await response.json()
  assert.equal(s.summaryCalls[0].length, 40)
  assert.equal(sessions.length, 40)
  assert.equal(sessions[0].id, 'chat-499')
  assert.ok(nextCursor)
  const next = await routes.sessions.GET(new Request(`https://fx0.example/api/sessions?cursor=${nextCursor}`))
  const older = await next.json()
  assert.ok(older.sessions.length === 40)
  assert.ok(!older.sessions.some((chat) => sessions.some((first) => chat.id === first.id)))
  assert.ok(!s.redisReads.includes(foreign))
})

test('model catalog is public, credential-free, shared, and never reports an auth failure', async (t) => {
  const s = reset({ session: null })
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) })
    return calls.length === 1
      ? Response.json({ data: [
        { id: 'anthropic/fast', type: 'language', tags: ['fast'], reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
        { id: 'openai/image', type: 'image', released: 900 },
        { id: 'deepseek/older', type: 'language', released: 100 },
        { id: 'deepseek/newest', type: 'language', released: 300 },
        { id: 'deepseek/newer', type: 'language', released: 200 },
        { id: 'deepseek/newest', type: 'language', released: 300 },
        { id: 'zai/undated', type: 'language' },
      ] })
      : new Response(null, { status: 401 })
  })
  const first = await modelsRoute.GET()
  assert.equal(first.status, 200)
  // Shared by everyone, so the CDN may serve it.
  assert.equal(first.headers.get('cache-control'), 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400')
  const { defaultModel, ...catalog } = await first.json()
  assert.deepEqual(catalog, {
    models: ['deepseek/newest', 'deepseek/newer', 'deepseek/older', 'anthropic/fast', 'zai/undated'],
    efforts: { 'anthropic/fast': ['low', 'high'] }, fast: ['anthropic/fast'], featured: [],
  }, 'models are newest first, deduplicated, with undated entries last and image models excluded')
  assert.equal(typeof defaultModel, 'string')
  assert.equal(calls[0].url, 'https://ai-gateway.vercel.sh/coding-agent/v1/models')
  assert.equal(calls[0].headers.get('authorization'), null)
  s.session = session()
  assert.equal((await modelsRoute.GET()).status, 200)
  assert.equal(calls.length, 1, 'guests and accounts share one cached catalog')
  assert.deepEqual(s.trace, [])
  assert.equal(s.queries.length, 0)
})

// Everything request-specific is in the boot promise the page hands ChatApp.
const boot = async (props) => { const { account, sidebar, boot } = page.default(props).props; const [identity, list, chat] = await Promise.all([account, sidebar, boot]); return { ...identity, ...list, ...chat }; }

test('page identity and owned sidebar resolve while the authorized transcript is still reading', async () => {
  let release
  const transcriptWait = new Promise((resolve) => { release = resolve })
  const s = reset({ transcriptWait })
  const props = page.default({ searchParams: Promise.resolve({ s: own }) }).props
  let chatReady = false
  props.boot.then(() => { chatReady = true })
  assert.equal((await props.account).user.id, 'user_a')
  await props.sidebar
  assert.equal(chatReady, false)
  assert.ok(s.trace.indexOf('owner') < s.trace.indexOf('events'))
  release()
  assert.equal((await props.boot).sessionId, own)
})

test('page boot does not read private Redis data before authenticated ownership', async () => {
  const props = { searchParams: Promise.resolve({ s: foreign }) }
  let s = reset({ session: null })
  // Signed out, the page boots the public guest shell, never the requested chat.
  const guest = await boot(props)
  assert.equal(guest.user, null)
  assert.equal(guest.sessionId, 'draft')
  assert.deepEqual(guest.snapshot.transcript.entries, [])
  assert.deepEqual(s.redisReads, [])
  s = reset()
  const signedIn = await boot(props)
  assert.equal(signedIn.missing, true)
  assert.equal(signedIn.sessionId, 'draft')
  assert.deepEqual(signedIn.snapshot.transcript.entries, [])
  assert.equal(s.owners.get(foreign), 'user_b')
  assert.ok(!s.trace.includes('events') && !s.trace.includes('state'))
})

test('a fresh trial visitor sees five prompts without account or ownership database work', async () => {
  const state = reset({ session: null, trialEnabled: true })
  const rendered = await boot({ searchParams: Promise.resolve({ s: foreign }) })
  assert.equal(rendered.user.guest, true)
  assert.equal(rendered.sessionId, 'draft')
  assert.deepEqual(rendered.sessions, [])
  assert.deepEqual(state.queries, [])
  assert.deepEqual(state.redisReads, [])
})

test('page boot carries only public user fields and owned lists', async () => {
  const s = reset()
  s.records.set(own, { id: own, title: 'Private A', createdAt: 1, lastActivity: 2 })
  const props = { searchParams: Promise.resolve({ s: own }) }
  const rendered = await boot(props)
  assert.equal(rendered.user.id, 'user_a')
  assert.deepEqual(rendered.sessions.map(({ id }) => id), [own])
  assert.doesNotMatch(JSON.stringify(rendered), /user-token|secret-refresh|accessToken|refreshToken/)
  assert.ok(s.redisReads.every((id) => id === own))
})

test('after a team switch the owner keeps reading and continuing the chat under the new team', async () => {
  const s = reset({ session: session({ teamId: 'team_b', teamSlug: 'b' }) })
  s.records.set(own, { id: own, title: 'Private old-team history', createdAt: 1, lastActivity: 2 })
  const rendered = await boot({ searchParams: Promise.resolve({ s: own }) })
  assert.equal(rendered.sessionId, own)
  assert.equal(s.billingTeams.get(own), 'team_a')
  assert.equal((await routes.events.GET(request('events'))).status, 200)
  assert.ok(s.trace.includes('bind'))
})

test('a page without a chat opens a draft and reserves nothing', async () => {
  const s = reset({ session: session({ teamId: 'team_b', teamSlug: 'b' }) })
  const draft = await boot({ searchParams: Promise.resolve({}) })
  assert.equal(draft.sessionId, 'draft')
  assert.deepEqual(draft.snapshot.transcript.entries, [])
  assert.ok(!s.queries.some(({ text }) => text.startsWith('WITH account')))
})

// Any link, image or frame can send a GET with the user's cookies, so a page view
// must never create a chat: unowned fresh, existing and short IDs all boot a draft.
test('a page GET never reserves a chat, whatever the ID', async () => {
  for (const [id, options] of [[fresh, {}], [fresh, { existing: new Set([fresh]) }], ['deadbeef', {}]]) {
    const s = reset(options)
    const rendered = await boot({ searchParams: Promise.resolve({ s: id }) })
    assert.equal(rendered.missing, true)
    assert.equal(rendered.sessionId, 'draft')
    assert.equal(s.owners.has(id), false)
    assert.ok(!s.trace.includes('reserve') && !s.trace.includes('events'))
    assert.ok(!s.queries.some(({ text }) => text.startsWith('WITH account')))
  }
})
