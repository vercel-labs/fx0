// Standalone offline viewer for fx0 performance runs and A/B comparisons.
// Pure string renderer: no filesystem, network, fonts, or external scripts. The one inline script is
// pinned by a CSP hash; data payloads are non-executable JSON. Text is escaped here and set with textContent in the script.
import { createHash } from 'node:crypto'
import { exportChromeTrace } from './perf-lab-data.mjs'

const METRICS = [
  ['sendingMs', 'Sending'],
  ['firstTextMs', 'First text received (not painted)'],
  ['firstDraftMs', 'First draft received (not painted)'],
  ['finishedMs', 'Turn finished (journaled)'],
  ['previewMs', 'Final preview presented'],
]
const META = [
  ['environment', 'Environment'], ['durability', 'Durability'], ['condition', 'Condition'], ['workload', 'Workload'],
  ['workloadHash', 'Workload hash'], ['model', 'Model'], ['reasoningEffort', 'Reasoning effort'], ['fast', 'Fast mode'],
  ['accountHash', 'Account hash'], ['teamHash', 'Team hash'], ['viewport', 'Viewport'], ['revision', 'Revision'],
  ['sourceHash', 'Source hash'], ['instrumentation', 'Instrumentation'], ['history', 'History'], ['capture', 'Capture'],
  ['startBoundary', 'Start boundary'],
]
const STAGES = {
  'prompt.started': 'Send handler start', 'prompt.send': 'Browser POST', 'prompt.headers': 'Response headers',
  'prompt.acknowledged': 'Accepted (headers)', 'prompt.first_content': 'First text received (not painted)',
  'prompt.first_draft': 'First draft received (not painted)', 'prompt.finished': 'Turn finished (journaled)',
  'prompt.turn': 'Turn (browser root)', 'prompt.e2e': 'End to end (send to preview)',
  'request.handle': 'Server request handler', 'request.auth': 'Request auth', 'request.revocation': 'Revocation check',
  'request.owner': 'Chat ownership check', 'prompt.activate': 'Reserve new chat',
  'net.workflow': 'Network: Vercel Workflow', 'net.queue': 'Network: Vercel Queues', 'net.oidc': 'Network: OIDC',
  'net.vercel_api': 'Network: Vercel API', 'net.redis': 'Network: Redis', 'net.neon': 'Network: Neon',
  'net.gateway': 'Network: AI Gateway', 'net.other': 'Network: other', 'prompt.journal': 'Journal write',
  'connect.workflow': 'Connect: Vercel Workflow', 'connect.queue': 'Connect: Vercel Queues', 'connect.oidc': 'Connect: OIDC',
  'connect.vercel_api': 'Connect: Vercel API', 'connect.redis': 'Connect: Redis', 'connect.neon': 'Connect: Neon',
  'connect.gateway': 'Connect: AI Gateway', 'connect.other': 'Connect: other',
  'agent.create': 'Create libfx agent', 'agent.session_id': 'New libfx session id',
  'prompt.credential': 'Save turn credential', 'prompt.hydrate': 'Hydrate session', 'prompt.bind': 'Bind libfx session',
  'prompt.accepted': 'Turn accepted', 'prompt.assets': 'Prepare assets', 'model.prepare': 'Model prepare',
  'model.headers': 'Model response headers', 'model.first_chunk': 'Model first chunk', 'model.stream': 'Model stream',
  'tool.execute': 'Tool execution', 'projector.history': 'Projector history', 'projector.batch': 'Projector batch',
  'journal.commit': 'Journal commit', 'sse.poll': 'SSE poll', 'sse.deliver': 'SSE deliver',
  'sse.receive': 'SSE receive (browser)', 'event.apply': 'Apply event (browser)', 'draft.write': 'Draft write',
  'draft.sanitize': 'Draft sanitize', 'draft.patch': 'Draft patch', 'artifact.prepare': 'Artifact prepare',
  'preview.presented': 'Preview presented (paint signal)', 'browser.longtask': 'Browser long task',
}
const MILESTONES = ['prompt.started', 'prompt.send', 'prompt.headers', 'prompt.first_content', 'prompt.finished']
const FLAG_ARGS = new Set(['count', 'chars', 'bytes', 'status', 'failed', 'cancelled', 'first', 'seq', 'revision',
  'fromPost', 'duplicate', 'step', 'incomplete', 'uptime', 'registered', 'loaded'])
const LANE = /^(?:browser|server:[A-Za-z0-9-]{1,64})$/u
const ID = /^[A-Za-z0-9-]{1,64}$/u
const ROW = 22
const IDLE = 'Hover or focus an event. Click pins it. Escape clears.'

const SCRIPT = `(() => {
  const pins = new WeakMap()
  const idle = '${IDLE}'
  const rootOf = node => node.closest('[data-run]')
  const panelOf = root => root.querySelector('[data-details]')
  const show = (root, el) => {
    const panel = panelOf(root)
    if (!panel) return
    if (!el) { panel.textContent = idle; return }
    const d = el.dataset
    const rows = [['Stage', d.readable], ['Raw trace name', d.raw], ['Lane', d.lane],
      ['Start from trace origin', '+' + d.start + ' ms'], ['Duration', d.dur ? d.dur + ' ms (exact)' : 'instant event']]
    for (const [key, value] of Object.entries(JSON.parse(d.args || '{}'))) rows.push(['arg ' + key, String(value)])
    const list = document.createElement('dl')
    for (const [key, value] of rows) {
      const dt = document.createElement('dt')
      const dd = document.createElement('dd')
      dt.textContent = key
      dd.textContent = value
      list.append(dt, dd)
    }
    panel.replaceChildren(list)
  }
  const preview = (event, on) => {
    const el = event.target.closest('[data-event]')
    const root = el && rootOf(el)
    if (root && !pins.get(root)) show(root, on ? el : null)
  }
  document.addEventListener('mouseover', event => preview(event, true))
  document.addEventListener('mouseout', event => preview(event, false))
  document.addEventListener('focusin', event => preview(event, true))
  document.addEventListener('focusout', event => preview(event, false))
  document.addEventListener('click', event => {
    const link = event.target.closest('a[data-download]')
    if (link) {
      const text = document.getElementById(link.dataset.download).textContent
      link.href = URL.createObjectURL(new Blob([JSON.stringify(JSON.parse(text), null, 2)], { type: 'application/json' }))
      return
    }
    const el = event.target.closest('[data-event]')
    const root = el && rootOf(el)
    if (!root) return
    if (pins.get(root) === el) pins.delete(root)
    else pins.set(root, el)
    show(root, pins.get(root) ?? null)
  })
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    for (const root of document.querySelectorAll('[data-run]')) {
      pins.delete(root)
      show(root, null)
    }
  })
  document.addEventListener('input', event => {
    const root = rootOf(event.target)
    if (!root) return
    if (event.target.matches('[data-filter]')) {
      const query = event.target.value.trim().toLowerCase()
      const items = [...root.querySelectorAll('[data-event]')]
      let shown = 0
      for (const el of items) {
        const hit = !query || el.dataset.search.includes(query)
        el.hidden = !hit
        if (hit) shown++
      }
      root.querySelector('[data-count]').textContent = shown + ' of ' + items.length + ' events shown'
    } else if (event.target.matches('[data-zoom-range]')) {
      const zoom = 2 ** (Number(event.target.value) / 100 * 6)
      root.style.setProperty('--zoom', String(zoom))
      root.querySelector('[data-zoom-out]').textContent = '×' + zoom.toFixed(1)
    }
  })
  document.addEventListener('change', event => {
    const select = event.target
    if (!select.matches('select[data-side]')) return
    const root = select.closest('[data-compare]')
    for (const panel of root.querySelectorAll('[data-run][data-side="' + select.dataset.side + '"]')) {
      panel.hidden = panel.dataset.index !== select.value
    }
  })
})()`

const STYLE = `:root{color-scheme:dark;--bg:#0e0f11;--panel:#16181b;--line:#2b2f35;--text:#e4e6ea;--muted:#8e949d;--browser:#8ea9c4;--server:#c2ab84;--mark:#e8c96f;--bad:#e27d7d;--good:#72c596;--focus:#cfe0f2}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
main{max-width:1160px;margin:0 auto;padding:24px 20px 56px}
h1{font-size:18px;margin:4px 0 8px}
h2{font-size:16px;margin:24px 0 4px}
h3{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:22px 0 8px;font-weight:600}
.kicker,.muted{color:var(--muted)}
.note{border-left:3px solid var(--mark);padding:4px 10px;margin:8px 0;background:var(--panel)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px 14px;margin:8px 0}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 18px;margin:0}
dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
.badge{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 6px;margin:2px 6px 2px 0;font-size:12px}
.badge.good{color:var(--good);border-color:var(--good)}
.badge.bad{color:var(--bad);border-color:var(--bad)}
.badge.warn{color:var(--mark);border-color:var(--mark)}
table{border-collapse:collapse;width:100%;margin-bottom:8px}
th,td{padding:4px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{color:var(--muted);font-weight:500}
th:first-child,td:first-child,.text th,.text td{text-align:left}
.neg{color:var(--bad)}
.pos{color:var(--good)}
.neutral{color:var(--muted)}
.phase{display:grid;grid-template-columns:minmax(200px,280px) 1fr 110px;gap:10px;align-items:center;margin:6px 0}
.bar{height:10px;background:var(--line);border-radius:2px;position:relative;overflow:hidden}
.bar i{position:absolute;top:0;bottom:0;left:0;background:var(--browser)}
.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:10px 0}
input[type=search]{background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:4px 8px;font:inherit;width:240px}
select{background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:4px;font:inherit;padding:3px 6px}
.button{font:inherit;color:var(--text);background:transparent;border:1px solid var(--line);border-radius:4px;padding:4px 10px;text-decoration:none;display:inline-block;margin:4px 8px 4px 0}
.button:hover{border-color:var(--muted)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:4px;background:#111316}
.track{position:relative;width:calc(var(--zoom,1)*100%);padding:0 6px 8px}
.axis{position:relative;height:22px;border-bottom:1px solid var(--line)}
.tick{position:absolute;top:0;bottom:0;border-left:1px solid var(--line);padding-left:4px;color:var(--muted);font-size:11px;white-space:nowrap}
.lane{margin-top:10px}
.lane-head{color:var(--muted);font-size:11px;margin-bottom:2px}
.lane-body{position:relative}
.span{position:absolute;height:18px;min-width:3px;margin:0;padding:0 5px;border:0;border-radius:3px;background:var(--browser);color:#0b0c0e;font:11px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:left;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer}
.span.server{background:var(--server)}
.span.is-failed{background:var(--bad)}
.mark{position:absolute;width:10px;height:10px;margin-left:-5px;padding:0;border:0;background:var(--mark);transform:rotate(45deg);cursor:pointer}
.details{min-height:72px;border:1px solid var(--line);border-radius:4px;padding:10px 12px;margin-top:10px;background:var(--panel)}
.details p{margin:0;color:var(--muted)}
@media (max-width:640px){.phase{grid-template-columns:1fr}}`

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-" +
  createHash('sha256').update(SCRIPT).digest('base64') + "'; base-uri 'none'; form-action 'none'"

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\u2028': '&#8232;', '\u2029': '&#8233;' }
const esc = value => String(value ?? '').replace(/[&<>"'\u2028\u2029]/gu, char => ESC[char])
// Inside a non-executing JSON script block: escape markup and line separators so no sequence can close the element.
const jsonScript = value => JSON.stringify(value)
  .replace(/[<>&\u2028\u2029]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNumber = value => typeof value === 'number' && Number.isFinite(value)
const fmt = (value, digits = 3) => (isNumber(value) ? value.toFixed(digits) : 'unknown')
const ms = value => (isNumber(value) ? `${value.toFixed(3)} ms` : 'unknown')
const codeHtml = code => `<code>${esc(code)}</code> ${esc(String(code).replaceAll('_', ' '))}`
const badge = (text, kind) => `<span class="badge ${kind}">${esc(text)}</span>`
const isoOf = micros => {
  const date = new Date(micros / 1000)
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString()
}

// Keep only fields this viewer can show. Core already validates runs; this stops hostile or extra fields from reaching markup.
function cleanText(value) {
  return typeof value === 'string' && value.length <= 200 ? value : null
}

function cleanArgs(args) {
  const out = {}
  if (!isRecord(args)) return out
  for (const [key, value] of Object.entries(args)) {
    if (FLAG_ARGS.has(key) && (typeof value === 'boolean' || isNumber(value))) out[key] = value
    else if (key === 'turnId' && isNumber(value)) out[key] = value
    else if ((key === 'traceId' || key === 'sessionId') && typeof value === 'string' && ID.test(value)) out[key] = value
  }
  return out
}

function cleanEvent(event) {
  if (!isRecord(event) || typeof event.name !== 'string' || event.name.length > 64) return null
  if ((event.ph !== 'X' && event.ph !== 'i') || typeof event.pid !== 'string' || !LANE.test(event.pid)) return null
  if (!isNumber(event.ts) || event.ts < 0) return null
  if (event.ph === 'X' && (!isNumber(event.dur) || event.dur < 0)) return null
  return { name: event.name, ph: event.ph, ts: event.ts, dur: event.ph === 'X' ? event.dur : undefined,
    pid: event.pid, args: cleanArgs(event.args) }
}

function cleanMeta(key, value) {
  if (key === 'viewport') {
    if (!isRecord(value) || !isNumber(value.width) || !isNumber(value.height) || !isNumber(value.dpr)) return null
    return { width: value.width, height: value.height, dpr: value.dpr }
  }
  if (typeof value === 'string') return value.length <= 200 ? value : null
  return typeof value === 'boolean' || isNumber(value) || value === null ? value : null
}

// Projects a run onto the fields this viewer renders and exports. Invalid trace events are counted, not rendered.
function project(run) {
  if (!isRecord(run)) throw new TypeError('renderRun expects a run object')
  const trace = isRecord(run.trace) ? run.trace : {}
  const traceEvents = []
  let invalid = 0
  for (const raw of Array.isArray(trace.traceEvents) ? trace.traceEvents : []) {
    const event = cleanEvent(raw)
    if (event) traceEvents.push(event)
    else invalid++
  }
  const source = isRecord(run.metadata) ? run.metadata : {}
  const metadata = Object.fromEntries(META.map(([key]) => [key, cleanMeta(key, source[key])]))
  const metrics = Object.fromEntries(METRICS.map(([key]) => {
    const value = isRecord(run.metrics) ? run.metrics[key] : null
    return [key, isNumber(value) && value >= 0 ? value : null]
  }))
  const dropped = isNumber(trace.dropped) && trace.dropped >= 0 ? trace.dropped : null
  return {
    invalid,
    run: {
      version: run.version,
      id: cleanText(run.id),
      label: cleanText(run.label),
      pairId: cleanText(run.pairId),
      recordedAt: cleanText(run.recordedAt),
      status: cleanText(run.status),
      issues: Array.isArray(run.issues) ? run.issues.map(cleanText).filter(Boolean) : [],
      metadata,
      metrics,
      trace: { traceEvents, displayTimeUnit: 'ms', dropped },
    },
  }
}

function chromeOf(run) {
  try {
    return exportChromeTrace(run)
  } catch {
    return null
  }
}

function metaText(key, value) {
  if (value === null || value === undefined || value === 'unknown') return 'unknown'
  if (key === 'viewport') return `${value.width}×${value.height} @${value.dpr}x`
  if (key === 'fast') return value ? 'on' : 'off'
  if (key === 'startBoundary' && value === 'handler') return 'handler (accepted send handler, not the physical Enter key)'
  return String(value)
}

// Browser-lane phases only. A missing or inverted milestone is null (unknown), never zero.
function phases(events) {
  const browser = events.filter(event => event.pid === 'browser')
  const at = (name, ph) => browser.find(event => event.name === name && (ph ? event.ph === ph : true))
  const started = at('prompt.started')
  const send = at('prompt.send', 'X')
  const headers = at('prompt.headers')
  const text = at('prompt.first_content')
  const gap = (from, to) => (from && to && to.ts >= from.ts ? (to.ts - from.ts) / 1000 : null)
  return [
    ['Before POST (send handler to request)', gap(started, send)],
    ['POST to response headers', gap(send, headers)],
    ['Headers to first text received', gap(headers, text)],
    ['Send handler to first text received', gap(started, text)],
  ]
}

function eventButton(event, lane, pct) {
  const readable = STAGES[event.name] ?? event.name
  const span = event.ph === 'X'
  const failed = event.args.failed === true || event.args.cancelled === true
  const cls = span ? `span ${lane.kind}${failed ? ' is-failed' : ''}` : 'mark'
  // Spans that outlive the prompt window (an idle background stream) are clipped at the axis edge.
  const visible = span ? Math.max(0, Math.min(event.dur, lane.total - (event.ts - lane.origin))) : 0
  const width = span ? `width:${pct(visible)}%;` : ''
  const search = `${readable} ${event.name} ${lane.label} ${lane.pid} ${JSON.stringify(event.args)}`.toLowerCase()
  return `<button type="button" class="${cls}" data-event aria-label="${esc(readable)}" ` +
    `style="left:${pct(event.ts - lane.origin)}%;${width}top:${lane.top}px" ` +
    `data-readable="${esc(readable)}" data-raw="${esc(event.name)}" data-lane="${esc(`${lane.label} (${lane.pid})`)}" ` +
    `data-start="${((event.ts - lane.origin) / 1000).toFixed(3)}" ` +
    `data-dur="${span ? (event.dur / 1000).toFixed(3) : ''}" data-args="${esc(JSON.stringify(event.args))}" ` +
    `data-search="${esc(search)}">${span ? esc(readable) : ''}</button>`
}

// Each process keeps its own clock. Lanes share one axis origin, which is only approximately aligned.
// Spans are packed into rows so overlapping or nested spans never appear as serial durations.
function timeline(events) {
  if (!events.length) return { html: '', origin: 0, shown: 0 }
  const origin = events.reduce((min, event) => Math.min(min, event.ts), Infinity)
  const fullEnd = events.reduce((max, event) => Math.max(max, event.ts + (event.dur ?? 0)), -Infinity)
  // Frame the prompt itself: end at the browser root plus a small margin, not at the last idle stream.
  const root = events.find(event => event.pid === 'browser' && event.name === 'prompt.e2e' && event.ph === 'X')
  const rootEnd = root ? root.ts + root.dur : fullEnd
  const end = Math.min(fullEnd, rootEnd + (rootEnd - origin) * 0.06)
  const total = Math.max(end - origin, 1)
  const clipped = events.filter(event => event.ts > end || event.ts + (event.dur ?? 0) > end).length
  const pct = value => (value / total * 100).toFixed(4)
  const firstTs = new Map()
  for (const event of events) firstTs.set(event.pid, Math.min(firstTs.get(event.pid) ?? Infinity, event.ts))
  const pids = [...firstTs.keys()].sort((a, b) => (a === 'browser' ? -1 : b === 'browser' ? 1
    : firstTs.get(a) - firstTs.get(b) || (a < b ? -1 : 1)))
  let servers = 0
  const lanes = pids.map(pid => {
    const label = pid === 'browser' ? 'browser' : `server ${++servers}`
    const mine = events.filter(event => event.pid === pid && event.ts <= end)
    const marks = mine.filter(event => event.ph === 'i')
    const spans = mine.filter(event => event.ph === 'X').sort((a, b) => a.ts - b.ts || b.dur - a.dur)
    const busyUntil = []
    const packed = spans.map(span => {
      let row = busyUntil.findIndex(until => until <= span.ts)
      if (row < 0) row = busyUntil.push(0) - 1
      busyUntil[row] = span.ts + span.dur
      return { span, row }
    })
    const offset = marks.length ? 1 : 0
    const lane = { label, pid, kind: pid === 'browser' ? 'browser' : 'server', origin, total }
    const items = [
      ...marks.map(event => eventButton(event, { ...lane, top: 2 }, pct)),
      ...packed.map(({ span, row }) => eventButton(span, { ...lane, top: (row + offset) * ROW + 2 }, pct)),
    ]
    const height = (busyUntil.length + offset) * ROW + 4
    return `<div class="lane"><div class="lane-head">${esc(label)} · ${esc(pid)} · ${mine.length} events</div>` +
      `<div class="lane-body" style="height:${height}px">${items.join('')}</div></div>`
  })
  const raw = total / 8
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map(multiple => multiple * magnitude).find(size => size >= raw)
  const ticks = []
  for (let t = 0; t <= total && ticks.length < 12; t += step) {
    ticks.push(`<span class="tick" style="left:${pct(t)}%">${+(t / 1000).toFixed(3)} ms</span>`)
  }
  const clipNote = clipped
    ? `<p class="muted">The axis frames the prompt. ${clipped} event(s) run past it: spans are clipped at the right edge (hover for full durations) and later events are omitted from the timeline; all remain in the downloads.</p>`
    : ''
  const shown = events.filter(event => event.ts <= end).length
  return { html: `${clipNote}<div class="axis">${ticks.join('')}</div>${lanes.join('')}`, origin, shown }
}

function runView(run, id, attrs = '') {
  const { run: p, invalid } = project(run)
  const events = p.trace.traceEvents
  const axis = timeline(events)
  const chrome = chromeOf(p)
  const missing = MILESTONES.filter(name => !events.some(event => event.pid === 'browser' && event.name === name))
  const servers = new Set(events.filter(event => event.pid !== 'browser').map(event => event.pid)).size
  const safe = esc(String(p.id ?? 'run').replace(/[^A-Za-z0-9-]/gu, '').slice(0, 40) || 'run')
  const statusKind = p.status === 'complete' ? 'good' : p.status === 'failed' ? 'bad' : 'warn'
  const row = ([key, html]) => `<dt>${esc(key)}</dt><dd>${html}</dd>`
  const health = [
    ['Status', esc(p.status ?? 'unknown')],
    ['Issues', p.issues.length ? p.issues.map(codeHtml).join(', ') : 'none'],
    ['Recorder dropped events', isNumber(p.trace.dropped)
      ? (p.trace.dropped ? `${p.trace.dropped} (exhaustive breakdown invalid)` : '0') : 'unknown'],
    ['Invalid events dropped by renderer', String(invalid)],
    ['Missing browser milestones', missing.length ? esc(missing.join(', ')) : 'none'],
    ['Server lanes', servers ? `${servers} recorded` : 'none recorded (server breakdown unknown, not zero)'],
  ]
  const phaseList = phases(events)
  const scale = Math.max(1, ...phaseList.map(([, value]) => value ?? 0))
  const phaseHtml = phaseList.map(([label, value]) => `<div class="phase"><span>${esc(label)}</span>` +
    `<div class="bar">${isNumber(value) ? `<i style="width:${(value / scale * 100).toFixed(2)}%"></i>` : ''}</div>` +
    `<span>${esc(ms(value))}</span></div>`).join('')
  const metricRows = METRICS.map(([key, label]) => `<tr data-metric="${key}"><td>${esc(label)}</td>` +
    `<td>${esc(ms(p.metrics[key]))}</td><td class="muted">${key}</td></tr>`).join('')
  const controls = events.length
    ? `<p class="note">Shared axis: each process keeps its own wall clock, so lanes align only approximately. ` +
      `Gaps between browser and server are not network latency. Origin: ${esc(isoOf(axis.origin))} (earliest event).</p>` +
      `<div class="controls"><label>Filter <input type="search" data-filter aria-label="Filter timeline events" ` +
      `placeholder="stage, name, lane"></label><label>Zoom <input type="range" min="0" max="100" step="1" value="0" ` +
      `data-zoom-range aria-label="Zoom"></label><output data-zoom-out>×1.0</output>` +
      `<span class="muted" data-count>${axis.shown} of ${axis.shown} events shown</span></div>` +
      `<div class="scroll"><div class="track">${axis.html}</div></div>` +
      `<div class="details" data-details><p>${esc(IDLE)}</p></div>`
    : '<p class="muted">No trace events recorded. The timeline is unavailable; this is not a zero-duration measurement.</p>'
  const downloads = `<a class="button" href="#" download="fx0-${safe}-run.json" data-download="dl-${id}-run">` +
    'Download run JSON</a>' + (chrome
      ? `<a class="button" href="#" download="fx0-${safe}-chrome.json" data-download="dl-${id}-chrome">` +
        'Download Chrome trace</a>'
      : '<span class="muted">Chrome trace unavailable: run did not pass export validation</span>')
  const payloads = `<script type="application/json" id="dl-${id}-run">${jsonScript(p)}</script>` +
    (chrome ? `<script type="application/json" id="dl-${id}-chrome">${jsonScript(chrome)}</script>` : '')
  return `<section class="run" data-run${attrs}>` +
    `<header><h2>${esc(p.label ?? 'run')} <span class="badge ${statusKind}">${esc(p.status ?? 'unknown')}</span></h2>` +
    `<p class="muted">trace ${esc(p.id ?? 'unknown')} · pair ${esc(p.pairId ?? 'none')} · ` +
    `recorded ${esc(p.recordedAt ?? 'unknown')}</p></header>` +
    `<h3>Trace health</h3><div class="card"><dl>${health.map(row).join('')}</dl></div>` +
    `<h3>Condition</h3><div class="card"><dl>${META.map(([key, label]) =>
      row([label, esc(metaText(key, p.metadata[key]))])).join('')}</dl></div>` +
    `<h3>Browser phases (browser clock only)</h3><div class="card">${phaseHtml}</div>` +
    `<h3>Metrics</h3><div class="card"><table class="text"><tbody>${metricRows}</tbody></table>` +
    '<p class="muted">unknown means not recorded or not applicable; it is never zero.</p></div>' +
    `<h3>Timeline</h3>${controls}` +
    `<div>${downloads}</div>${payloads}</section>`
}

function metricRow(metric, control) {
  const before = metric.baseline ?? {}
  const after = metric.candidate ?? {}
  const improvement = metric.improvementPercent
  const kind = control || !isNumber(improvement) || improvement === 0 ? 'neutral' : improvement < 0 ? 'neg' : 'pos'
  const label = METRICS.find(([key]) => key === metric.name)?.[1] ?? metric.name
  return `<tr data-metric="${esc(metric.name)}"><td>${esc(label)}</td>` +
    `<td>${fmt(before.n, 0)}</td><td>${fmt(before.p50)}</td><td>${fmt(before.p95)}</td>` +
    `<td>${fmt(after.n, 0)}</td><td>${fmt(after.p50)}</td><td>${fmt(after.p95)}</td>` +
    `<td>${fmt(metric.pairedDeltaMs)}</td>` +
    `<td class="${kind}">${isNumber(improvement) ? `${improvement > 0 ? '+' : ''}${improvement.toFixed(2)} %` : 'unknown'}</td></tr>`
}

function shell(title, body) {
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="color-scheme" content="dark">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n<title>${esc(title)}</title>\n` +
    `<style>${STYLE}</style>\n</head>\n<body>\n<main>\n${body}\n</main>\n<script>${SCRIPT}</script>\n</body>\n</html>\n`
}

// One complete, offline HTML document for a single run: health, metadata, phases, metrics, and a packed timeline.
export function renderRun(run) {
  const { run: p } = project(run)
  const label = p.label ?? 'run'
  return shell(`fx0 perf lab · ${label}`,
    `<p class="kicker">fx0 performance lab · single run</p>${runView(run, 'run')}`)
}

// Comparison summary plus every supplied run. Selecting a run toggles its panel; nothing is fetched.
export function renderComparison(comparison, { baselineRuns = [], candidateRuns = [] } = {}) {
  if (!isRecord(comparison)) throw new TypeError('renderComparison expects a comparison object')
  if (!Array.isArray(baselineRuns) || !Array.isArray(candidateRuns)) {
    throw new TypeError('baselineRuns and candidateRuns must be arrays')
  }
  const reasons = Array.isArray(comparison.reasons) ? comparison.reasons.filter(reason => typeof reason === 'string') : []
  const pairs = Array.isArray(comparison.pairs) ? comparison.pairs.filter(isRecord) : []
  const counts = isRecord(comparison.counts) ? comparison.counts : {}
  const metrics = Array.isArray(comparison.metrics) ? comparison.metrics.filter(isRecord) : []
  const compatible = comparison.compatible === true
  const control = comparison.control === true
  const smallSample = comparison.smallSample === true
  const badges = [
    compatible ? badge('compatible', 'good') : badge('not comparable: deltas hidden', 'bad'),
    control ? badge('A/A control: differences are noise, not speedup', 'warn') : '',
    smallSample ? badge('small sample: descriptive, not proof', 'warn') : '',
  ].join('')
  const pick = (runs, id) => {
    const index = runs.findIndex(run => isRecord(run) && run.id === id)
    return index < 0 ? 0 : index
  }
  const pair = pairs[0]
  const selectedBaseline = pair ? pick(baselineRuns, pair.baselineId) : 0
  const selectedCandidate = pair ? pick(candidateRuns, pair.candidateId) : 0
  const picker = (side, runs, selected) => {
    const options = runs.length
      ? runs.map((run, index) => `<option value="${index}"${index === selected ? ' selected' : ''}>` +
        `${esc(`${run?.label ?? 'run'} · ${run?.id ?? index}`)}</option>`).join('')
      : '<option value="">no runs supplied</option>'
    return `<label>${side} run <select data-side="${side}"${runs.length ? '' : ' disabled'}>${options}</select></label>`
  }
  const panels = (side, runs, selected) => runs.map((run, index) => {
    const attrs = ` data-side="${side}" data-index="${index}"${index === selected ? '' : ' hidden'}`
    try {
      return runView(run, `${side[0]}${index}`, attrs)
    } catch {
      return `<section class="run" data-run${attrs}><p class="badge bad">run could not be rendered: not a run object</p></section>`
    }
  }).join('')
  const countKeys = ['baseline', 'candidate', 'paired', 'valid', 'failed', 'unpaired']
  const countsTable = `<table><thead><tr>${countKeys.map(key => `<th>${key}</th>`).join('')}</tr></thead>` +
    `<tbody><tr>${countKeys.map(key => `<td>${fmt(counts[key], 0)}</td>`).join('')}</tr></tbody></table>`
  let metricsHtml
  if (!compatible) metricsHtml = '<p class="note">Not comparable: deltas, improvement, and the metric table are hidden.</p>'
  else if (!metrics.length) metricsHtml = '<p class="note">No valid complete pairs: no deltas.</p>'
  else {
    metricsHtml = '<table><thead><tr><th>Metric</th><th>Base n</th><th>Base p50</th><th>Base p95</th>' +
      '<th>Cand n</th><th>Cand p50</th><th>Cand p95</th><th>Paired Δ ms</th><th>Improvement</th></tr></thead>' +
      `<tbody>${metrics.map(metric => metricRow(metric, control)).join('')}</tbody></table>` +
      (control ? '<p class="note">A/A control: colors are neutral. Any difference is measurement noise.</p>' : '')
  }
  const pairsTable = pairs.length
    ? '<table class="text"><thead><tr><th>Pair</th><th>Baseline trace</th><th>Candidate trace</th><th>Status</th></tr>' +
      '</thead><tbody>' + pairs.map(item => `<tr><td>${esc(item.pairId ?? 'unpaired')}</td>` +
        `<td>${esc(item.baselineId ?? 'none')}</td><td>${esc(item.candidateId ?? 'none')}</td>` +
        `<td>${esc(item.status ?? 'unknown')}</td></tr>`).join('') + '</tbody></table>'
    : '<p class="note">No pairs.</p>'
  const runsJson = runs => runs.map(run => {
    try {
      return project(run).run
    } catch {
      return null
    }
  })
  const body = `<div data-compare><p class="kicker">fx0 performance lab · A/B comparison</p>` +
    '<h1>Baseline vs candidate</h1>' +
    `<div class="card">${badges}${reasons.length ? `<ul>${reasons.map(reason => `<li>${codeHtml(reason)}</li>`).join('')}</ul>` : ''}</div>` +
    `<h3>Counts</h3>${countsTable}<h3>Metrics</h3>${metricsHtml}<h3>Pairs</h3>${pairsTable}` +
    `<h3>Runs</h3><div class="controls">${picker('baseline', baselineRuns, selectedBaseline)}` +
    `${picker('candidate', candidateRuns, selectedCandidate)}</div>` +
    panels('baseline', baselineRuns, selectedBaseline) + panels('candidate', candidateRuns, selectedCandidate) +
    '<div><a class="button" href="#" download="fx0-comparison.json" data-download="dl-comparison">' +
    'Download comparison JSON</a></div>' +
    `<script type="application/json" id="dl-comparison">${jsonScript({
      comparison: plain(comparison),
      baselineRuns: runsJson(baselineRuns),
      candidateRuns: runsJson(candidateRuns),
    })}</script></div>`
  return shell('fx0 perf lab · comparison', body)
}

// Depth- and size-bounded copy of JSON-like data: keeps primitives and plain records/arrays only.
function plain(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, 200)
  if (typeof value === 'boolean' || value === null || isNumber(value)) return value
  if (depth > 6) return null
  if (Array.isArray(value)) return value.slice(0, 500).map(item => plain(item, depth + 1))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key.slice(0, 64), plain(item, depth + 1)]))
  }
  return null
}
