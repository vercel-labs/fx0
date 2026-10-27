import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { labTargetUrl, launchChrome } from '../tests/fixtures/chrome-cdp.mjs'

const help = `Usage: node scripts/perf-e2e.mjs --url http://localhost:3000 [--prompt '...'] [--timeout-ms 180000] [--headed]

Development only. Sends ONE LIVE prompt through the app UI: it may incur charges
and creates a chat/turn. No mock provider, auth bypass, or synthetic generation.
Chrome runs headless by default, with a fresh temporary profile (or --profile) and no focus change.
The prompt is submitted with one trusted Enter keypress in the composer, not a click.
Use --headed only for one-time manual sign-in in that fresh window before the timeout.
No external cookies are read and no existing Chrome profile is controlled.
Build/start the local app with FX0_TRACE=1 (and VERCEL= if that marker was pulled into .env.local).
Requires Node 24 and Chrome; CHROME_PATH may name an absolute Chrome executable.

  --url         Required loopback HTTP(S) URL, or an fx0 preview over HTTPS
                (fx0-*.labs.vercel.dev, fx0-*.vercel.app). Production is refused.
  --prompt      Plain prompt (not a slash command), at most 16,000 characters.
  --timeout-ms  Total deadline including startup/login/generation (default 180000).
  --headed      Show a fresh Chrome window so you can sign in once (default: headless).
  --headless    Accepted for compatibility; headless is already the default. Conflicts with --headed.
  --profile     Dedicated persistent Chrome profile directory with the fx0 performance marker.
                Sign in once in that profile (its own login flow), then repeat headless runs with it.
                It is never your normal Chrome profile, and it is kept after the run.
  --help        Show this help without starting Chrome or sending a prompt.

Writes browser-only trace.json and summary.json to .next/fx0-perf/e2e-TIMESTAMP-pid/.
Success requires prompt.started, journal-backed prompt.finished, prompt.turn,
and a complete prompt.e2e, including the final artifact paint when applicable.
summary.json reports milestones relative to prompt.started (the send handler) and
Enter-to-milestone times from the trusted Enter keydown, all on the browser clock.
Durations overlap: do not sum spans. Server traces are not read or merged.
`

export function parseArgs(args) {
  const result = { timeoutMs: 180000, headless: true,
    prompt: 'Create a one-page landing page for a fictional bookshop, with a heading, a short description, and three book cards. Use only static HTML and CSS; no external services.' }
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (!['--url', '--prompt', '--timeout-ms', '--profile', '--headed', '--headless', '--help'].includes(flag)) throw new Error('Unknown argument; use --help')
    if (seen.has(flag)) throw new Error('Duplicate argument; use --help')
    seen.add(flag)
    if (flag === '--help') { result.help = true; continue }
    if (flag === '--headed' || flag === '--headless') {
      if (seen.has(flag === '--headed' ? '--headless' : '--headed')) throw new Error('--headed and --headless conflict; use --help')
      result.headless = flag === '--headless'
      continue
    }
    const value = args[++index]
    if (value == null || value.startsWith('--')) throw new Error('Missing option value; use --help')
    if (flag === '--url') result.url = labTargetUrl(value).url.href
    if (flag === '--prompt') result.prompt = value
    if (flag === '--profile') {
      // Errors never echo the path: it may name a private directory.
      if (!value.trim() || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('Invalid --profile path; use --help')
      result.profileDirectory = path.resolve(value)
    }
    if (flag === '--timeout-ms') {
      if (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > 3600000) throw new Error('timeout-ms must be an integer from 1000 to 3600000')
      result.timeoutMs = Number(value)
    }
  }
  if (result.help) return result
  if (!result.url) throw new Error('--url is required; use --help')
  if (!result.prompt.trim() || result.prompt.length > 16000 || /^\s*\//u.test(result.prompt) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(result.prompt)) {
    throw new Error('Prompt must be nonempty plain text, not a slash command, without control characters (max 16000 characters)')
  }
  return result
}

const names = new Set([
  'request.handle', 'request.auth', 'request.revocation', 'request.owner', 'prompt.activate',
  'net.workflow', 'net.queue', 'net.oidc', 'net.vercel_api', 'net.redis', 'net.neon', 'net.gateway', 'net.other',
  'connect.workflow', 'connect.queue', 'connect.oidc', 'connect.vercel_api', 'connect.redis', 'connect.neon',
  'connect.gateway', 'connect.other',
  'agent.create', 'agent.session_id',
  'prompt.send', 'prompt.headers', 'prompt.journal',
  'prompt.credential', 'prompt.hydrate', 'prompt.bind', 'prompt.accepted', 'prompt.assets',
  'model.prepare', 'model.headers', 'model.first_chunk', 'model.stream', 'tool.execute',
  'projector.history', 'projector.batch', 'journal.commit', 'sse.poll', 'sse.deliver',
  'sse.receive', 'event.apply', 'draft.write', 'draft.sanitize', 'draft.patch',
  'artifact.prepare', 'preview.presented', 'browser.longtask', 'prompt.started',
  'prompt.acknowledged', 'prompt.first_content', 'prompt.first_draft', 'prompt.finished',
  'prompt.turn', 'prompt.e2e',
])
const numbers = ['count', 'chars', 'bytes', 'status', 'failed', 'cancelled', 'incomplete',
  'first', 'seq', 'revision', 'fromPost', 'duplicate', 'step', 'uptime', 'registered', 'loaded']

// The app recorder already redacts content. Keep a second, bounded output boundary:
// never persist arbitrary CDP values, DOM text, URLs, headers, console logs or cookies.
export function sanitizeSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.traceEvents) || snapshot.traceEvents.length > 10000) throw new Error('Invalid or oversized browser trace snapshot')
  const traceEvents = []
  for (const event of snapshot.traceEvents) {
    if (!event || !names.has(event.name) || !['X', 'i'].includes(event.ph) || !Number.isFinite(event.ts)) continue
    if (event.ph === 'X' && (!Number.isFinite(event.dur) || event.dur < 0)) continue
    const args = {}
    if (/^[a-f0-9]{32}$/.test(event.args?.traceId ?? '')) args.traceId = event.args.traceId
    if (/^[a-f0-9-]{36}$/i.test(event.args?.sessionId ?? '')) args.sessionId = event.args.sessionId
    if (Number.isSafeInteger(event.args?.turnId) && event.args.turnId > 0) args.turnId = event.args.turnId
    for (const field of numbers) {
      const value = event.args?.[field]
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) args[field] = value
    }
    traceEvents.push({ name: event.name, cat: 'fx0', ph: event.ph, ts: event.ts,
      ...(event.ph === 'X' ? { dur: event.dur } : { s: 't' }), pid: 'browser', tid: 1, args })
  }
  return { traceEvents, displayTimeUnit: 'ms', dropped: Number.isSafeInteger(snapshot.dropped) && snapshot.dropped >= 0 ? snapshot.dropped : 0 }
}

// Every operand is a browser trace timestamp: (performance.timeOrigin + performance.now()) * 1000.
// Missing, non-finite, or backwards intervals are null, never zero and never a clock guess.
export function enterIntervalsMs(enterUs, targetsUs) {
  return Object.fromEntries(Object.entries(targetsUs).map(([key, targetUs]) => {
    const valid = Number.isFinite(enterUs) && Number.isFinite(targetUs) && targetUs >= enterUs
    return [key, valid ? (targetUs - enterUs) / 1000 : null]
  }))
}

// Milestones recorded after the send handler and the trusted Enter keydown.
const milestoneNames = ['prompt.started', 'prompt.acknowledged', 'prompt.first_content', 'prompt.first_draft', 'prompt.finished']

function captureDetails(snapshot, enterUs) {
  const start = snapshot.traceEvents.find(event => event.name === 'prompt.started' && event.ph === 'i')
  if (!start?.args.traceId) return {}
  const events = snapshot.traceEvents.filter(event => event.args.traceId === start.args.traceId)
  const finished = events.find(event => event.name === 'prompt.finished' && event.ph === 'i')
  const root = events.find(event => event.name === 'prompt.e2e' && event.ph === 'X')
  const context = finished?.args ?? events.find(event => event.args.turnId)?.args ?? start.args
  const preview = finished?.args.revision == null ? undefined : events.findLast(event =>
    event.name === 'preview.presented' && event.ph === 'i' && event.args.revision === finished.args.revision)
  const at = name => events.find(event => event.name === name && event.ph === 'i')?.ts ?? null
  return {
    traceId: start.args.traceId, sessionId: context.sessionId ?? null, turnId: context.turnId ?? null,
    elapsedMs: root ? (root.ts + root.dur - start.ts) / 1000 : null,
    milestonesMs: Object.fromEntries(milestoneNames
      .map(name => [name, events.find(event => event.name === name && event.ph === 'i')])
      .map(([name, event]) => [name, event ? (event.ts - start.ts) / 1000 : null])),
    enterToMs: enterIntervalsMs(enterUs ?? null, {
      handler: start.ts, acknowledged: at('prompt.acknowledged'), firstContent: at('prompt.first_content'),
      firstDraft: at('prompt.first_draft'), finished: at('prompt.finished'),
    }),
    finalArtifactPaintMs: preview ? (preview.ts - start.ts) / 1000 : null,
    stages: events.filter(event => event.ph === 'X').sort((a, b) => a.ts - b.ts).map(event => ({
      name: event.name, startMs: (event.ts - start.ts) / 1000, durationMs: event.dur / 1000,
    })),
  }
}

export function inspectCapture(snapshot, enterUs) {
  const starts = snapshot.traceEvents.filter(event => event.name === 'prompt.started' && event.ph === 'i')
  if (starts.length > 1) throw new Error('More than one prompt root was recorded; capture is not a single turn')
  const start = starts[0]
  if (!start) return { complete: false }
  if (!start.args.traceId) throw new Error('prompt.started has no valid traceId')
  const events = snapshot.traceEvents.filter(event => event.args.traceId === start.args.traceId)
  if (enterUs != null) {
    if (!Number.isFinite(enterUs)) throw new Error('Invalid Enter timestamp')
    if (events.some(event => event.ph === 'i' && milestoneNames.includes(event.name) && event.ts < enterUs)) {
      throw new Error('A prompt milestone precedes the observed Enter; browser timing is invalid')
    }
  }
  for (const event of events) {
    // A failed SSE read can recover through GET. Only terminal/root outcomes
    // decide whether the generation itself failed.
    if (['prompt.turn', 'prompt.e2e', 'prompt.finished'].includes(event.name) &&
        ['failed', 'cancelled', 'incomplete'].some(key => Boolean(event.args[key]))) throw new Error('Prompt trace reports failed, cancelled, or incomplete')
  }
  const roots = events.filter(event => event.name === 'prompt.e2e' && event.ph === 'X')
  if (roots.length > 1) throw new Error('Duplicate prompt.e2e root')
  const root = roots[0]
  if (!root) return { complete: false, traceId: start.args.traceId }
  const finished = events.find(event => event.name === 'prompt.finished' && event.ph === 'i')
  const turn = events.find(event => event.name === 'prompt.turn' && event.ph === 'X')
  if (!finished || !turn || !Number.isSafeInteger(finished.args.seq) || finished.args.seq <= 0 ||
      !finished.args.sessionId || !finished.args.turnId) throw new Error('prompt.e2e has no correlated journal completion/session/turn')
  const end = root.ts + root.dur
  if (root.ts < start.ts || turn.ts < start.ts || finished.ts < start.ts || end + 1 < finished.ts || end + 1 < turn.ts + turn.dur) {
    throw new Error('Invalid browser root timing')
  }
  const revision = finished.args.revision ?? root.args.revision
  const preview = events.findLast(event => event.name === 'preview.presented' && event.ph === 'i' &&
    event.args.sessionId === finished.args.sessionId && event.args.turnId === finished.args.turnId &&
    event.args.revision === revision && event.ts >= start.ts && event.ts <= end)
  if (revision != null && !preview) throw new Error('Final artifact paint is missing from the completed prompt.e2e trace')
  return { complete: true, ...captureDetails(snapshot, enterUs) }
}

const composerSelector = 'textarea#prompt, textarea#prompt-input'
function uiProbe(origin) {
  return `(() => {
    if (location.origin !== ${JSON.stringify(origin)}) return {onApp:false,signedOut:true};
    const input = document.querySelector(${JSON.stringify(composerSelector)});
    const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const dialog = [...document.querySelectorAll('[role="dialog"]')].some(visible);
    const admission = document.querySelector('[data-fx0-prompt-state]')?.dataset.fx0PromptState;
    return {onApp:true, signedOut:admission === 'auth' || location.pathname === '/login',
      ready:admission === 'ready' && visible(input) && !input.disabled && !input.readOnly && !input.closest('[inert]') && !dialog &&
        visible(document.querySelector('button[aria-label="Send message"]')),
      tracing:typeof window.__fx0Trace?.snapshot === 'function' && typeof window.__fx0Trace?.clear === 'function'};
  })()`
}

const sendSelector = 'button[aria-label="Send message"]'

// The submit boundary is one real Enter keypress in our composer, not a button click.
// It validates the ready composer, send button, and nonempty draft; focuses that input;
// observes the trusted keydown (timestamp only: no key value, draft, or DOM text); and
// dispatches one keyDown/keyUp pair. A failed or lost reply is never retried.
// Page-load timings from the browser's own Performance APIs, in ms from navigation start:
// paint and load milestones, and when the runner first saw the composer ready (polled
// every 200 ms, so coarse). Numbers only; anything else becomes null.
export function sanitizePageLoad(value) {
  const keys = ['fcpMs', 'lcpMs', 'domContentLoadedMs', 'loadMs', 'composerReadyMs']
  const result = {}
  for (const key of keys) {
    const number = value?.[key]
    result[key] = typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 600000 ? Math.round(number * 10) / 10 : null
  }
  return result
}

const pageLoadProbe = `(async () => {
  const navigation = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
  const lcp = await new Promise(resolve => {
    let last = null;
    try {
      const observer = new PerformanceObserver(list => { const entries = list.getEntries(); last = entries[entries.length - 1]?.startTime ?? last; });
      observer.observe({ type: 'largest-contentful-paint', buffered: true });
      setTimeout(() => { observer.disconnect(); resolve(last); }, 100);
    } catch { resolve(null); }
  });
  return { fcpMs: fcp, lcpMs: lcp, domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
    loadMs: navigation?.loadEventEnd ?? null, composerReadyMs: performance.now() };
})()`

export async function submitWithEnter(cdp, origin) {
  if (typeof origin !== 'string' || !origin) throw new Error('Expected app origin is required')
  // The browser helper redacts in-page exception text, so refusals are returned as fixed reasons.
  const refusal = await cdp.evaluate(`(() => {
    if (location.origin !== ${JSON.stringify(origin)}) return 'App origin changed';
    const input = document.querySelector(${JSON.stringify(composerSelector)});
    const button = document.querySelector(${JSON.stringify(sendSelector)});
    const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const dialog = [...document.querySelectorAll('[role="dialog"]')].some(visible);
    if (document.querySelector('[data-fx0-prompt-state]')?.dataset.fx0PromptState !== 'ready') return 'Composer is not ready';
    if (!visible(input) || input.disabled || input.readOnly || input.closest('[inert]') || dialog) return 'Composer unavailable';
    if (!visible(button) || button.disabled) return 'Send unavailable';
    if (!input.value.trim()) return 'Draft is empty';
    input.focus({ preventScroll: true });
    if (document.activeElement !== input) return 'Composer did not take focus';
    window.__fx0EnterCapture?.remove();
    const state = { enters: [], clicks: 0 };
    const onKeyDown = event => {
      if (!event.isTrusted || event.key !== 'Enter' || event.shiftKey || event.isComposing || event.target !== input) return;
      const at = (performance.timeOrigin + performance.now()) * 1000;
      if (Number.isFinite(at)) state.enters.push(at);
    };
    const onClick = () => { state.clicks++ };
    document.addEventListener('keydown', onKeyDown, true);
    button.addEventListener('click', onClick, true);
    state.remove = () => {
      document.removeEventListener('keydown', onKeyDown, true);
      button.removeEventListener('click', onClick, true);
    };
    window.__fx0EnterCapture = state;
    return null;
  })()`)
  if (refusal) throw new Error(refusal)
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...key })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  const observed = await cdp.evaluate(`(() => {
    const state = window.__fx0EnterCapture;
    if (!state) throw new Error('Enter observer missing');
    state.remove();
    return { count: state.enters.length, at: state.enters[0] ?? null, clicks: state.clicks };
  })()`)
  if (observed.count !== 1 || !Number.isFinite(observed.at)) throw new Error('Expected exactly one trusted Enter in the composer; no retry was attempted')
  if (observed.clicks !== 0) throw new Error('Send button was clicked; the Enter boundary is not proven')
  return { enterTimestampUs: observed.at }
}

// Read only after a complete turn, through the composer's own GET /api/model?session=<id>.
// Only three values leave the page; anything missing or malformed stays null, never guessed.
const unknownContext = { model: null, reasoningEffort: null, fast: null }
async function readGenerationContext(cdp, origin, sessionId) {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId ?? '')) return unknownContext
  try {
    const value = await cdp.evaluate(`(async () => {
      if (location.origin !== ${JSON.stringify(origin)}) return null;
      const response = await fetch(${JSON.stringify(`/api/model?session=${encodeURIComponent(sessionId)}`)}, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
      if (!response.ok) return null;
      const options = await response.json();
      // An empty string is the chat's explicit "no preference": the server's default applies.
      const setting = value => typeof value !== 'string' ? null : value.trim() || 'default';
      return {
        model: setting(options?.model),
        effort: setting(options?.effort),
        fast: typeof options?.fast === 'boolean' ? options.fast : null,
      };
    })()`)
    return { model: value?.model || null, reasoningEffort: value?.effort || null, fast: value?.fast ?? null }
  } catch { return unknownContext }
}

export async function run(options) {
  // Recheck the destination before any process or network side effects.
  const app = labTargetUrl(options.url).url
  console.error('WARNING: development-only LIVE prompt; this may incur charges and creates a chat/turn. No mock generation. Temporary or dedicated fx0 profile only.')
  const controller = new AbortController()
  const { signal } = controller
  const started = performance.now()
  const deadline = started + options.timeoutMs
  const stop = () => controller.abort()
  const timeout = setTimeout(stop, options.timeoutMs)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const directory = path.join(fileURLToPath(new URL('../', import.meta.url)), '.next/fx0-perf', `e2e-${stamp}-${process.pid}`)
  let browser
  let submitted = false
  let enterTimestampUs
  let snapshot = { traceEvents: [], displayTimeUnit: 'ms', dropped: 0 }
  let analysis = { complete: false }
  let generation = unknownContext
  let pageLoad = sanitizePageLoad(null)
  let failure
  let phase = 'Chrome startup'
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    browser = await launchChrome({ headless: options.headless, signal, timeoutMs: Math.min(15000, options.timeoutMs),
      profileDirectory: options.profileDirectory })
    const { cdp } = browser
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    const navigation = await cdp.send('Page.navigate', { url: app.href })
    if (navigation.errorText) throw new Error('App navigation failed')
    phase = 'composer/login'
    let loginPrinted = false
    while (true) {
      signal.throwIfAborted()
      // Manual OAuth may replace the execution context between polls. Retry only
      // this read-only readiness probe, never the send click.
      let state
      try { state = await cdp.evaluate(uiProbe(app.origin)) }
      catch { signal.throwIfAborted(); await delay(200, undefined, { signal }); continue }
      if (state?.onApp && state.ready) {
        if (!state.tracing) throw new Error('Browser tracing unavailable: build/start the local app with VERCEL= FX0_TRACE=1 before sending')
        pageLoad = sanitizePageLoad(await cdp.evaluate(pageLoadProbe).catch(() => null))
        break
      }
      if (state?.signedOut && !loginPrinted) {
        if (options.headless) throw new Error('Authentication required: rerun with --headed and sign in once in the new Chrome window; no prompt was sent')
        loginPrinted = true
        console.error(`Sign in manually in the new Chrome window. Waiting within the total ${options.timeoutMs} ms deadline; no credentials are captured.`)
      }
      await delay(200, undefined, { signal })
    }
    // A follow-up run sends a setup prompt first (not measured), keeps the page open for
    // followUpGapMs, then measures a second prompt in the same chat.
    // Optional pause after the app is ready and before typing, as a person looks at the
    // page before writing; anything the app does on open runs during it.
    if (options.settleMs) await delay(options.settleMs, undefined, { signal })
    const turns = options.followUpGapMs == null ? 1 : 2
    for (let turn = 1; turn <= turns; turn++) {
      if (turn === 2) {
        phase = 'follow-up gap'
        await delay(options.followUpGapMs, undefined, { signal })
      }
      phase = 'composer input'
      await cdp.evaluate(`(() => {
        if (location.origin !== ${JSON.stringify(app.origin)}) throw new Error('App origin changed');
        const input = document.querySelector(${JSON.stringify(composerSelector)});
        if (!input || input.disabled || input.readOnly || input.value) throw new Error('Composer unavailable or nonempty');
        window.__fx0Trace.clear();
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(options.prompt)});
        input.dispatchEvent(new Event('input', {bubbles:true}));
      })()`)
      while (!await cdp.evaluate(`location.origin === ${JSON.stringify(app.origin)} && (() => {
        const button = document.querySelector('button[aria-label="Send message"]');
        return !!button && !button.disabled;
      })()`)) await delay(50, undefined, { signal })
      // Optional think time between typing and Enter, as a person pauses before sending;
      // the composer's typing warm-up runs during it. Zero keeps the immediate send.
      if (options.thinkMs) await delay(options.thinkMs, undefined, { signal })
      phase = 'prompt.started'
      // Never retry this operation: a lost reply after the key event leaves the send state unknown.
      submitted = true
      enterTimestampUs = (await submitWithEnter(cdp, app.origin)).enterTimestampUs
      const startDeadline = Math.min(deadline, performance.now() + 10000)
      while (true) {
        signal.throwIfAborted()
        snapshot = sanitizeSnapshot(await cdp.evaluate(`(() => {
          if (location.origin !== ${JSON.stringify(app.origin)}) throw new Error('App origin changed');
          if (typeof window.__fx0Trace?.snapshot !== 'function') throw new Error('Trace unavailable');
          return window.__fx0Trace.snapshot();
        })()`))
        analysis = inspectCapture(snapshot, enterTimestampUs)
        if (snapshot.dropped) throw new Error('Browser trace dropped events; capture is incomplete')
        if (analysis.traceId) phase = 'prompt.e2e (journal done and final artifact paint)'
        else if (performance.now() >= startDeadline) throw new Error('No prompt.started within 10 seconds; prompt tracing must be wired into the real composer')
        if (analysis.complete) break
        await delay(100, undefined, { signal })
      }
      if (turn < turns) {
        // The composer accepts the next prompt once the setup turn has finished.
        while (!await cdp.evaluate(`location.origin === ${JSON.stringify(app.origin)} && (() => {
          const input = document.querySelector(${JSON.stringify(composerSelector)});
          return !!input && !input.disabled && !input.readOnly && !input.value;
        })()`)) await delay(100, undefined, { signal })
      }
    }
    if (analysis.complete) generation = await readGenerationContext(cdp, app.origin, analysis.sessionId)
  } catch (error) {
    failure = signal.aborted ? `Stopped or timed out during ${phase}; generation may still be running server-side` : error.message
  } finally {
    clearTimeout(timeout)
    try { await browser?.close() }
    catch { failure = `${failure ? `${failure}; ` : ''}Chrome/profile cleanup failed` }
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
  const summary = {
    status: failure ? 'failed' : 'success', source: 'live-app-browser-ui', browserOnly: true,
    viewport: { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    appUrl: `${app.origin}${app.pathname}`, capturedAt: new Date().toISOString(), artifactDirectory: directory,
    context: {
      model: generation.model, reasoningEffort: generation.reasoningEffort, fast: generation.fast,
      viewport: { width: 1440, height: 1000, dpr: 1 },
      history: app.searchParams.has('s') || options.followUpGapMs != null ? 'followup' : 'new-chat',
      capture: options.headless ? 'headless' : 'headed', startBoundary: 'handler',
    },
    runnerElapsedMs: performance.now() - started, sendAttempted: submitted, pageLoad,
    clock: 'browser performance clock, microsecond trace timestamps (timeOrigin + now)',
    labels: {
      milestonesMs: 'relative to prompt.started, the production send handler (not the Enter keypress)',
      enterToMs: 'relative to the trusted Enter keydown observed in the composer, on the same browser clock',
    },
    ...analysis, ...captureDetails(snapshot, enterTimestampUs), ...(failure ? { error: failure } : {}),
    note: 'Spans overlap; do not sum durations. Missing milestones are null, not zero. No server traces merged.',
  }
  await writeFile(path.join(directory, 'trace.json'), JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 })
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 })
  console.log(`Browser capture: ${directory}`)
  if (failure) {
    const error = new Error(failure)
    error.artifactDirectory = directory
    throw error
  }
  console.log(`prompt.e2e: ${analysis.elapsedMs.toFixed(3)} ms (from prompt.started). Spans overlap; do not sum.`)
  console.table(analysis.milestonesMs)
  console.table(analysis.enterToMs)
  console.table(analysis.stages)
  return summary
}

export async function main(args = process.argv.slice(2)) {
  let options
  try { options = parseArgs(args) }
  catch (error) { console.error(error.message); return 2 }
  if (options.help) { console.log(help); return 0 }
  try { await run(options); return 0 }
  catch (error) { console.error(`E2E capture failed: ${error.message}`); return 1 }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main()
}
