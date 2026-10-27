import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTraceRecorder } from '../lib/performance-trace.ts'

const context = { traceId: 'a'.repeat(32), sessionId: '00000000-0000-4000-8000-000000000001', turnId: 1 }

// Trace and Vercel flags only reach a child through its explicit env, never this process.
const { VERCEL: _vercel, VERCEL_ENV: _vercelEnv, FX0_TRACE: _trace, FX0_TRACE_PREVIEW: _preview, NODE_TEST_CONTEXT: _testContext, ...hostEnv } = process.env
const TRACE_MODULE = new URL('../lib/trace-server.ts', import.meta.url).href
const SESSION = '00000000-0000-4000-8000-000000000001'
const TRACE_ID = 'b'.repeat(32)
const PREVIEW = { VERCEL: '1', VERCEL_ENV: 'preview', FX0_TRACE_PREVIEW: '1' }
const ALLOWED_ARGS = ['traceId', 'sessionId', 'turnId', 'count', 'chars', 'bytes', 'status', 'failed', 'cancelled', 'first', 'seq', 'revision', 'fromPost', 'duplicate', 'step', 'incomplete', 'uptime', 'registered', 'loaded']
const ALLOWED_EVENT_KEYS = ['name', 'cat', 'ph', 's', 'ts', 'dur', 'pid', 'tid', 'args']

// One traced request, run in a fresh process the way one Vercel function instance would run it.
// The child reports each console.info call (its arguments), how many exports came before any
// flush, whether tracing wrapped the work promise, and whether it changed process.env.
const SCENARIO = `
  const session = ${JSON.stringify(SESSION)};
  const infos = [];
  console.info = (...args) => infos.push(args);
  const envBefore = JSON.stringify(process.env);
  await runRequestTrace(new Request('http://localhost/api/prompt', { headers: { 'x-fx0-trace': ${JSON.stringify(TRACE_ID)}, authorization: 'Bearer secret-token' } }), async () => {
    bindPromptTrace(session, 1);
    await traceAsync('prompt.accepted', serverTraceContext(session, 1), async () => {});
    traceServerEvent('sse.receive', serverTraceContext(session, 1), { count: 2 });
    await traceAsync('tool.execute', undefined, async () => { throw new Error('private prompt text and <html>') }).catch(() => {});
  });
  const beforeFlush = infos.length;
  await flushServerTrace();
  const exported = infos.slice();
  // Identity probe last: an enabled trace exports its own span, which is not part of the request.
  const work = Promise.resolve(1);
  const sameWork = traceAsync('draft.patch', undefined, () => work) === work;
  process.stdout.write(JSON.stringify({
    mode: serverTraceMode(), sameWork, beforeFlush, infos: exported, pid: process.pid,
    envUnchanged: JSON.stringify(process.env) === envBefore,
  }));
`

function runScenario(directory, env) {
  const source = `import {runRequestTrace,traceAsync,traceServerEvent,bindPromptTrace,serverTraceContext,serverTraceMode,flushServerTrace} from ${JSON.stringify(TRACE_MODULE)};\n${SCENARIO}`
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { cwd: directory, env, encoding: 'utf8' })
  return JSON.parse(stdout)
}

// Each preview console call must be exactly one JSON object with the fixed 'fx0:trace' tag.
function previewPayloads(result) {
  return result.infos.map(args => {
    assert.equal(args.length, 1, 'one console argument')
    assert.equal(typeof args[0], 'string')
    assert.doesNotMatch(args[0], /\n/, 'one line per record')
    return JSON.parse(args[0])
  })
}

// Network spans: real undici requests and bundled-client channel messages, observed only by
// category, status and timing. The URL, path and headers never reach the recorder.
const NETWORK_SCENARIO = `
  import diagnostics from 'node:diagnostics_channel';
  import { createServer } from 'node:http';
  import { runRequestTrace, serverTraceSnapshot, networkCategory } from ${JSON.stringify(TRACE_MODULE)};
  const server = createServer((_request, response) => response.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await runRequestTrace(new Request('http://localhost/api/prompt', { headers: { 'x-fx0-trace': ${JSON.stringify(TRACE_ID)} } }), async () => {
    await (await fetch('http://127.0.0.1:' + server.address().port + '/private/path?token=secret-token')).text();
    // A second request reuses the kept-alive connection: no new connect span. undici returns
    // the socket to its pool a tick after the body ends.
    await new Promise(resolve => setImmediate(resolve));
    await (await fetch('http://127.0.0.1:' + server.address().port + '/private/path?token=secret-token')).text();
    // As undici does: connected/connectError carry a copy of connectParams and the same connector.
    const connector = () => {};
    const params = { protocol: 'https:', hostname: 'iad1.vercel-queue.com', port: '' };
    diagnostics.channel('undici:client:beforeConnect').publish({ connectParams: params, connector });
    diagnostics.channel('undici:client:connected').publish({ connectParams: { ...params }, connector, socket: {} });
    const refused = { protocol: 'https:', hostname: 'secret-token.upstash.io', port: '' };
    diagnostics.channel('undici:client:beforeConnect').publish({ connectParams: refused, connector });
    diagnostics.channel('undici:client:connectError').publish({ connectParams: { ...refused }, connector, error: new Error('secret-token') });
    const request = { origin: 'https://api.vercel.com', path: '/v1/workflow/runs?token=secret-token' };
    diagnostics.channel('undici:request:create').publish({ request });
    diagnostics.channel('undici:request:headers').publish({ request, response: { statusCode: 201 } });
    const failing = { origin: 'https://example-queue.vercel-queue.com', path: '/send' };
    diagnostics.channel('undici:request:create').publish({ request: failing });
    diagnostics.channel('undici:request:error').publish({ request: failing, error: new Error('secret-token') });
  });
  server.close();
  process.stdout.write(JSON.stringify({
    snapshot: serverTraceSnapshot(),
    categories: [
      networkCategory('https://api.vercel.com', '/v2/teams'), networkCategory('https://oidc.vercel.com', '/'),
      networkCategory('https://us1-x.upstash.io', '/get'), networkCategory('https://ep-x.us-east-1.aws.neon.tech', '/sql'),
      networkCategory('https://ai-gateway.vercel.sh', '/v1'), networkCategory('not a url', '/'),
      networkCategory('https://vercel-workflow.com', '/runs'), networkCategory('https://notvercel-workflow.com', '/'),
    ],
  }));
`

test('network spans record only a category, status and timing for every undici request', () => {
  const run = env => JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', NETWORK_SCENARIO],
    { env, encoding: 'utf8' }))
  const local = run({ ...hostEnv, FX0_TRACE: '1' })
  const events = local.snapshot.traceEvents.filter(event => event.name.startsWith('net.'))
  const byName = Object.fromEntries(events.map(event => [event.name, event]))
  assert.equal(byName['net.other'].args.status, 200, 'a real fetch through undici is observed')
  assert.equal(byName['net.workflow'].args.status, 201)
  assert.equal(byName['net.queue'].args.failed, true)
  const connects = local.snapshot.traceEvents.filter(event => event.name.startsWith('connect.'))
  assert.deepEqual(connects.map(event => event.name), ['connect.other', 'connect.queue', 'connect.redis'],
    'one span per new connection: the kept-alive second fetch opens none')
  assert.equal(connects[2].args.failed, true)
  for (const event of connects) assert.equal(event.args.traceId, TRACE_ID)
  for (const event of events) {
    assert.equal(event.args.traceId, TRACE_ID, 'network spans join the request trace')
    assert.ok(event.dur >= 0)
  }
  assert.doesNotMatch(JSON.stringify(local.snapshot), /secret-token|private\/path|api\.vercel\.com|127\.0\.0\.1|workflow\/runs/)
  assert.deepEqual(local.categories, ['net.vercel_api', 'net.oidc', 'net.redis', 'net.neon', 'net.gateway', 'net.other', 'net.workflow', 'net.other'])
  const production = run({ ...hostEnv, VERCEL: '1', VERCEL_ENV: 'production', FX0_TRACE: '1', FX0_TRACE_PREVIEW: '1' })
  assert.deepEqual(production.snapshot.traceEvents, [], 'production never observes the network')
})

test('request spans mark the process\'s first request and its uptime', () => {
  const source = `
    import { runRequestTrace, serverTraceSnapshot, markProcess } from ${JSON.stringify(TRACE_MODULE)};
    markProcess('registered');
    await new Promise(resolve => setTimeout(resolve, 20));
    markProcess('registered');
    for (let i = 0; i < 2; i++) await runRequestTrace(new Request('http://localhost/api/prompt'), async () => {});
    process.stdout.write(JSON.stringify(serverTraceSnapshot().traceEvents.filter(event => event.name === 'request.handle').map(event => event.args)));
  `
  const handles = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source],
    { env: { ...hostEnv, FX0_TRACE: '1' }, encoding: 'utf8' }))
  assert.deepEqual(handles.map(args => args.first), [true, false])
  for (const args of handles) assert.ok(Number.isInteger(args.uptime) && args.uptime > 0 && args.uptime < 60_000)
  assert.ok(handles[1].uptime >= handles[0].uptime)
  assert.ok(Number.isInteger(handles[0].registered) && handles[0].registered <= handles[0].uptime, 'the first mark is kept')
  assert.equal(handles[1].registered, handles[0].registered)
  assert.ok(handles[0].uptime - handles[0].registered >= 15, 'a later mark does not overwrite the first')
  assert.equal(handles[0].loaded, undefined)
})

test('disabled tracing reads no clock and stores no events', () => {
  const trace = createTraceRecorder({ enabled: false, process: 'test', now: () => { throw new Error('clock read') } })
  trace.start('prompt.send', context)()
  trace.instant('prompt.headers', context)
  assert.deepEqual(trace.snapshot().traceEvents, [])
})

test('spans use monotonic durations, close once, and copy their input', () => {
  let time = 5
  const trace = createTraceRecorder({ enabled: true, process: 'test', now: () => time, timeOrigin: 1000 })
  const attrs = { count: 1 }
  const end = trace.start('draft.patch', context, attrs)
  attrs.count = 100
  time = 12
  end({ chars: 20 })
  end({ failed: true })
  const [event] = trace.snapshot().traceEvents
  assert.equal(trace.snapshot().traceEvents.length, 1)
  assert.equal(event.ts, 1005000)
  assert.equal(event.dur, 7000)
  assert.deepEqual(event.args, { ...context, count: 1, chars: 20 })
  event.args.count = 200
  assert.equal(trace.snapshot().traceEvents[0].args.count, 1)
})

test('runtime allowlists drop content, secrets, unbounded identifiers, and invalid measurements', () => {
  const trace = createTraceRecorder({ enabled: true, process: 'test' })
  const unsafe = { traceId: 'Bearer secret-token', sessionId: 'private prompt', turnId: Infinity, text: '<html>private</html>' }
  trace.start('tool.execute', unsafe, { count: 3, chars: Infinity, bytes: NaN, url: 'https://private.example', authorization: 'secret' })({ failed: true, prompt: 'private prompt' })
  trace.instant('arbitrary secret event', context, { count: 1 })
  const [event] = trace.snapshot().traceEvents
  assert.equal(trace.snapshot().traceEvents.length, 1)
  assert.deepEqual(event.args, { count: 3, failed: true })
  assert.doesNotMatch(JSON.stringify(trace.snapshot()), /secret|private|html/)
})

test('a bounded ring keeps newest events and reports drops; draining resets it', () => {
  const trace = createTraceRecorder({ enabled: true, process: 'test', capacity: 2 })
  for (let count = 1; count <= 5; count++) trace.instant('sse.receive', context, { count })
  assert.deepEqual(trace.snapshot().traceEvents.map(event => event.args.count), [4, 5])
  assert.equal(trace.drain().dropped, 3)
  assert.equal(trace.snapshot().dropped, 0)
  assert.deepEqual(trace.snapshot().traceEvents, [])
  trace.instant('sse.receive', context, { count: 6 })
  assert.equal(trace.snapshot().traceEvents[0].args.count, 6)
})

test('local server tracing keeps async requests isolated and writes batched local reports', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fx0-trace-test-'))
  const module = TRACE_MODULE
  const script = new URL('../scripts/trace-report.mjs', import.meta.url)
  const env = hostEnv
  try {
    const source = `
      import assert from 'node:assert/strict';
      import {runRequestTrace,traceAsync,traceServerEvent,bindPromptTrace,serverTraceContext,serverTraceSnapshot,flushServerTrace} from ${JSON.stringify(module)};
      const session='00000000-0000-4000-8000-000000000001';
      await Promise.all(['a','b'].map((letter,index)=>runRequestTrace(new Request('http://localhost/api/prompt',{headers:{'x-fx0-trace':letter.repeat(32)}}),async()=>{
        await new Promise(resolve=>setTimeout(resolve,index===0?15:1));
        bindPromptTrace(session,index+1);
        await traceAsync('prompt.accepted',serverTraceContext(session,index+1),async()=>{});
      })));
      const failure=new Error('sensitive error must not be recorded');
      await assert.rejects(traceAsync('tool.execute',undefined,async()=>{throw failure}),error=>error===failure);
      const events=serverTraceSnapshot().traceEvents;
      for(const turn of [1,2]) assert.equal(events.find(event=>event.name==='prompt.accepted'&&event.args.turnId===turn).args.traceId,(turn===1?'a':'b').repeat(32));
      process.env.VERCEL='1';
      const count=events.length;
      traceServerEvent('sse.receive');
      assert.equal(serverTraceSnapshot().traceEvents.length,count);
      delete process.env.VERCEL;
      await flushServerTrace();
    `
    execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { cwd: directory, env: { ...env, FX0_TRACE: '1' } })
    const traceDir = path.join(directory, '.next', 'fx0-traces')
    const files = await readdir(traceDir)
    assert.equal(files.length, 1)
    const text = await readFile(path.join(traceDir, files[0]), 'utf8')
    assert.doesNotMatch(text, /sensitive|Bearer|authorization/)
    const report = execFileSync(process.execPath, [script.pathname, traceDir], { encoding: 'utf8' })
    assert.match(report, /prompt.accepted/)
    assert.match(report, /p95 ms/)
    const merged = JSON.parse(execFileSync(process.execPath, [script.pathname, '--json', traceDir], { encoding: 'utf8' }))
    assert.equal(merged.traceEvents.length, 5)
    assert.ok(merged.traceEvents.find(event => event.name === 'tool.execute').args.failed)
    // The same entry point must do no recording or filesystem I/O when disabled.
    execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {runRequestTrace,traceServerEvent,serverTraceSnapshot} from ${JSON.stringify(module)};
      await runRequestTrace(new Request('http://localhost/'),async()=>traceServerEvent('sse.receive'));
      assert.equal(serverTraceSnapshot().traceEvents.length,0);
    `], { cwd: directory, env })
    assert.equal((await readdir(traceDir)).length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('local tracing batches to files and prints nothing to the console', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fx0-trace-local-'))
  try {
    const result = runScenario(directory, { ...hostEnv, FX0_TRACE: '1' })
    assert.equal(result.mode, 'local')
    assert.equal(result.sameWork, false)
    assert.equal(result.beforeFlush, 0)
    assert.equal(result.infos.length, 0)
    assert.equal(result.envUnchanged, true)
    const files = await readdir(path.join(directory, '.next', 'fx0-traces'))
    assert.equal(files.length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('production is never traced, even with every opt-in flag', async () => {
  const environments = [
    { VERCEL: '1', VERCEL_ENV: 'production', FX0_TRACE: '1', FX0_TRACE_PREVIEW: '1' },
    { VERCEL_ENV: 'production', FX0_TRACE: '1', FX0_TRACE_PREVIEW: '1' },
  ]
  for (const env of environments) {
    const directory = await mkdtemp(path.join(tmpdir(), 'fx0-trace-prod-'))
    try {
      const result = runScenario(directory, { ...hostEnv, ...env })
      assert.equal(result.mode, null)
      assert.equal(result.sameWork, true)
      assert.equal(result.beforeFlush, 0)
      assert.equal(result.infos.length, 0)
      assert.deepEqual(await readdir(directory), [])
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

test('preview tracing needs an explicit opt-in on a preview deployment', async () => {
  const environments = [
    { VERCEL: '1', VERCEL_ENV: 'preview' },
    { VERCEL: '1', VERCEL_ENV: 'preview', FX0_TRACE_PREVIEW: '0' },
    { VERCEL: '1', VERCEL_ENV: 'preview', FX0_TRACE: '1' },
    { VERCEL: '1', VERCEL_ENV: 'development', FX0_TRACE_PREVIEW: '1' },
  ]
  for (const env of environments) {
    const directory = await mkdtemp(path.join(tmpdir(), 'fx0-trace-off-'))
    try {
      const result = runScenario(directory, { ...hostEnv, ...env })
      assert.equal(result.sameWork, true)
      assert.equal(result.beforeFlush, 0)
      assert.equal(result.infos.length, 0)
      assert.deepEqual(await readdir(directory), [])
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

test('preview exports sanitized JSON lines at span end and writes no files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fx0-trace-preview-'))
  try {
    const result = runScenario(directory, { ...hostEnv, ...PREVIEW })
    assert.equal(result.mode, 'preview')
    assert.equal(result.sameWork, false)
    assert.equal(result.envUnchanged, true)
    // Each completed span and instant event leaves before any flush runs.
    assert.equal(result.beforeFlush, 4)
    assert.equal(result.infos.length, 4)
    const payloads = previewPayloads(result)
    for (const payload of payloads) {
      assert.equal(payload.event, 'fx0:trace')
      assert.deepEqual(Object.keys(payload).sort(), ['displayTimeUnit', 'dropped', 'event', 'traceEvents'])
      assert.equal(payload.displayTimeUnit, 'ms')
      assert.equal(payload.dropped, 0)
      assert.equal(payload.traceEvents.length, 1)
      for (const traced of payload.traceEvents) {
        assert.deepEqual(Object.keys(traced).filter(key => !ALLOWED_EVENT_KEYS.includes(key)), [])
        assert.equal(traced.cat, 'fx0')
        assert.match(traced.pid, /^server:[0-9a-f-]{36}$/)
        assert.notEqual(traced.pid, `server:${result.pid}`)
        for (const key of Object.keys(traced.args)) assert.ok(ALLOWED_ARGS.includes(key), `unexpected arg ${key}`)
        assert.equal(traced.args.traceId, TRACE_ID)
      }
    }
    const traced = payloads.map(payload => payload.traceEvents[0])
    assert.deepEqual(traced.map(event => event.name).sort(), ['prompt.accepted', 'request.handle', 'sse.receive', 'tool.execute'])
    const accepted = traced.find(event => event.name === 'prompt.accepted')
    assert.equal(accepted.args.sessionId, SESSION)
    assert.equal(accepted.args.turnId, 1)
    assert.equal(traced.find(event => event.name === 'tool.execute').args.failed, true)
    // Nothing from request, header, prompt, or error text reaches the log.
    assert.doesNotMatch(JSON.stringify(result.infos), /private|secret|Bearer|authorization|sensitive|html/i)
    assert.deepEqual(await readdir(directory), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a throwing preview logger never fails the request or changes its result', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fx0-trace-throw-'))
  const source = `
    import {runRequestTrace,traceAsync,traceServerEvent} from ${JSON.stringify(TRACE_MODULE)};
    console.info = () => { throw new Error('logger down') };
    const outcome = await runRequestTrace(new Request('http://localhost/api/prompt', { headers: { 'x-fx0-trace': ${JSON.stringify(TRACE_ID)} } }), async () => {
      const value = await traceAsync('prompt.accepted', undefined, async () => 'work-result');
      traceServerEvent('model.first_chunk', undefined, { bytes: 3 });
      const failure = await traceAsync('tool.execute', undefined, async () => { throw new Error('work-error') }).catch(error => error.message);
      return { value, failure };
    });
    process.stdout.write(JSON.stringify(outcome));
  `
  try {
    const outcome = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { cwd: directory, env: { ...hostEnv, ...PREVIEW }, encoding: 'utf8' }))
    // The work result and its own error come back unchanged; only the diagnostic line is lost.
    assert.deepEqual(outcome, { value: 'work-result', failure: 'work-error' })
    assert.deepEqual(await readdir(directory), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('two function instances export distinct lanes that share one request trace id', async () => {
  const first = await mkdtemp(path.join(tmpdir(), 'fx0-trace-lane-a-'))
  const second = await mkdtemp(path.join(tmpdir(), 'fx0-trace-lane-b-'))
  try {
    const lanes = [runScenario(first, { ...hostEnv, ...PREVIEW }), runScenario(second, { ...hostEnv, ...PREVIEW })]
    const pids = lanes.map(lane => previewPayloads(lane).find(payload => payload.traceEvents[0].name === 'prompt.accepted').traceEvents[0].pid)
    assert.notEqual(pids[0], pids[1])
    for (const lane of lanes) {
      for (const payload of previewPayloads(lane)) assert.equal(payload.traceEvents[0].args.traceId, TRACE_ID)
    }
  } finally {
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('report merges browser JSON and server JSONL without summing overlapping spans', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fx0-trace-merge-'))
  try {
    const trace = createTraceRecorder({ enabled: true, process: 'browser' })
    trace.start('draft.patch', context)()
    const browser = path.join(directory, 'browser.json')
    await writeFile(browser, JSON.stringify(trace.snapshot()))
    const server = path.join(directory, 'server.jsonl')
    await writeFile(server, JSON.stringify(trace.snapshot()) + '\n' + JSON.stringify(trace.snapshot()) + '\n')
    const report = new URL('../scripts/trace-report.mjs', import.meta.url).pathname
    const output = execFileSync(process.execPath, [report, '--json', browser, server], { encoding: 'utf8' })
    assert.equal(JSON.parse(output).traceEvents.length, 3)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
