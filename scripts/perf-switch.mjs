// fx0 performance lab: open a chat from the history sidebar, as a person does, and time
// what the screen shows after the click. Each sample loads the app fresh (empty client
// cache), hovers a history item (which starts the app's prefetch), waits, then clicks
// with real input events. Only numbers are saved: no titles, chat ids or content.
//
//   node --experimental-strip-types scripts/perf-switch.mjs --profile DIR --url URL --out DIR
//     [--samples N (default 5)] [--hover-ms N (default 300)] [--label baseline|candidate]
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { labTargetUrl, launchChrome } from '../tests/fixtures/chrome-cdp.mjs'
import { labDirectory } from './perf-lab.mjs'

const LAB_PROMPT = 'Reply exactly OK. Do not use tools.'
const ITEM = 'div.group\\/row > button.group\\/item'

function parse(args) {
  const options = { samples: 5, hoverMs: 300, label: 'baseline' }
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]]
    if (value == null) throw new Error(`Missing value for ${flag}`)
    if (flag === '--profile') options.profile = path.resolve(value)
    else if (flag === '--url') options.url = labTargetUrl(value).url
    else if (flag === '--out') options.out = labDirectory(value)
    else if (flag === '--samples') options.samples = Number(value)
    else if (flag === '--hover-ms') options.hoverMs = Number(value)
    else if (flag === '--label') options.label = value
    else throw new Error(`Unknown argument ${flag}`)
  }
  if (!options.profile || !options.url || !options.out) throw new Error('--profile, --url and --out are required')
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 50) throw new Error('--samples must be 1..50')
  if (!Number.isInteger(options.hoverMs) || options.hoverMs < 0 || options.hoverMs > 10000) throw new Error('--hover-ms must be 0..10000')
  if (!/^[a-z0-9-]{1,32}$/.test(options.label)) throw new Error('--label must be a short id')
  return options
}

// Bounded numbers only; anything else becomes null.
const ms = value => (typeof value === 'number' && Number.isFinite(value) && value >= -60000 && value <= 600000 ? Math.round(value * 10) / 10 : null)

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await cdp.evaluate(expression).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

// Picks the index-th history item that is not a lab "Reply exactly OK" chat (those have
// no design). The title is read only to filter and is never returned.
const pickItem = (skip) => `(() => {
  const items = [...document.querySelectorAll(${JSON.stringify(ITEM)})]
    .filter(button => !button.disabled && button.getAttribute('aria-current') !== 'page'
      && !button.textContent.includes(${JSON.stringify(LAB_PROMPT.slice(0, 20))}));
  const button = items[${skip}];
  if (!button) return null;
  button.scrollIntoView({ block: 'center' });
  const box = button.getBoundingClientRect();
  button.setAttribute('data-perf-target', '1');
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, available: items.length };
})()`

// Installed before the click: timestamps on the page's performance clock.
const instrument = `(() => {
  // active: the clicked item is the current chat (an empty chat may show while loading).
  // content: current and no longer loading (aria-busy gone), i.e. the chat's own
  // transcript is on screen; painted marks two frames later. Same signal on both sides.
  const marks = window.__fx0Switch = { down: null, url: null, active: null, activePainted: null, content: null, painted: null };
  addEventListener('pointerdown', () => { marks.down ??= performance.now() }, { capture: true, once: true });
  const push = history.pushState;
  history.pushState = function (...args) { marks.url ??= performance.now(); return push.apply(this, args) };
  const target = document.querySelector('[data-perf-target]');
  const check = (observer) => {
    if (marks.down == null || target.getAttribute('aria-current') !== 'page') return;
    if (marks.active == null) {
      marks.active = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => { marks.activePainted ??= performance.now() }));
    }
    if (target.getAttribute('aria-busy') === 'true') return;
    marks.content = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => { marks.painted ??= performance.now() }));
    observer.disconnect();
  };
  const observer = new MutationObserver(() => check(observer));
  observer.observe(target, { attributes: true, attributeFilter: ['aria-current', 'aria-busy'] });
  return true;
})()`

const collect = `(() => {
  const marks = window.__fx0Switch;
  const origin = performance.timeOrigin;
  const presented = (window.__fx0Trace?.snapshot().traceEvents ?? [])
    .filter(event => event.name === 'preview.presented').map(event => event.ts / 1000 - origin)
    .filter(at => marks.down != null && at >= marks.down).sort((a, b) => a - b)[0] ?? null;
  const resource = (match) => {
    const entry = performance.getEntriesByType('resource').filter(e => e.name.includes(match)).sort((a, b) => b.startTime - a.startTime)[0];
    return entry ? { start: entry.startTime, ttfb: entry.responseStart, end: entry.responseEnd } : null;
  };
  return { marks, presented, session: resource('/api/session?'), frame: resource('/api/artifact-frame'),
    hasFrame: !!document.querySelector('iframe[src*="/api/artifact-frame"]') };
})()`

async function sample(options, index) {
  const browser = await launchChrome({ headless: true, profileDirectory: options.profile })
  try {
    const { cdp } = browser
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.navigate', { url: options.url.origin + '/' })
    await waitFor(cdp, `location.origin === ${JSON.stringify(options.url.origin)} && !!document.querySelector(${JSON.stringify(ITEM)}) && !!window.__fx0Trace`, 30000, 'history sidebar')
    await delay(1500) // let first-paint work settle
    const target = await cdp.evaluate(pickItem(index))
    if (!target) throw new Error('Not enough design chats in the history')
    await cdp.evaluate(instrument)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
    await delay(options.hoverMs)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    await waitFor(cdp, 'window.__fx0Switch?.painted != null', 20000, 'chat content shown')
    // A design chat then presents its preview; a chat without a design times out here
    // and is reported with hasPreview false.
    await waitFor(cdp, `${collect}.presented != null`, 15000, 'preview presented').catch(() => {})
    await delay(300)
    const raw = await cdp.evaluate(collect)
    const down = raw.marks.down
    const rel = value => (value == null || down == null ? null : ms(value - down))
    return {
      index, hoverMs: options.hoverMs,
      clickToUrl: rel(raw.marks.url), clickToActive: rel(raw.marks.active), clickToActivePainted: rel(raw.marks.activePainted),
      clickToContent: rel(raw.marks.content), clickToPainted: rel(raw.marks.painted),
      clickToPreview: rel(raw.presented), hasPreview: raw.hasFrame,
      // Resource timings relative to the click; a negative start means the hover prefetch began it.
      session: raw.session && { start: rel(raw.session.start), ttfb: rel(raw.session.ttfb), end: rel(raw.session.end) },
      frame: raw.frame && { start: rel(raw.frame.start), ttfb: rel(raw.frame.ttfb), end: rel(raw.frame.end) },
    }
  } finally { await browser.close() }
}

export async function main(args = process.argv.slice(2)) {
  const options = parse(args)
  await mkdir(options.out, { recursive: true, mode: 0o700 })
  const results = []
  for (let index = 0; index < options.samples; index++) {
    try {
      const result = await sample(options, index)
      results.push(result)
      console.log(`${options.label} #${index}: url ${result.clickToUrl} ms, chat shown ${result.clickToActivePainted} ms, content ${result.clickToPainted} ms, preview ${result.clickToPreview} ms, /api/session ${result.session?.start}..${result.session?.end} ms`)
    } catch (error) {
      console.error(`${options.label} #${index} failed: ${error.message}`)
      results.push({ index, failed: true })
    }
  }
  const file = path.join(options.out, `${options.label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeFile(file, JSON.stringify({ url: options.url.origin, label: options.label, results }, null, 2) + '\n', { mode: 0o600 })
  console.log(`Saved ${file}`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
