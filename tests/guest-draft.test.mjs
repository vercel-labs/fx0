import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// guest-draft.ts imports lib/design-md without an extension, as Next resolves it.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../lib/design-md' || specifier === '../lib/prompt-limits' || specifier === '../lib/image-source') return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { GUEST_DRAFT_KEY, GUEST_DRAFT_TTL, GUEST_DRAFT_MAX_BYTES, saveGuestDraft, takeGuestDraft, parseGuestDraft, clearGuestDraft } = await import('../components/guest-draft.ts')

function storage() {
  const values = new Map()
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
}
const image = { data: 'aGVsbG8=', mimeType: 'image/png', preview: 'data:image/png;base64,aGVsbG8=' }
const draft = { text: 'Build a landing page', images: [image] }
const envelope = { version: 2, expiresAt: 100 + GUEST_DRAFT_TTL, text: draft.text, images: [{ data: image.data, mimeType: image.mimeType }], designMd: null, submit: false }

test('OAuth draft contains only unsent text and image bytes, restores once and expires after 15 minutes', () => {
  const store = storage()
  assert.equal(saveGuestDraft(store, draft, 100), true)
  assert.deepEqual(JSON.parse(store.getItem(GUEST_DRAFT_KEY)), envelope)
  assert.deepEqual(takeGuestDraft(store, 101), { ...draft, designMd: null, submit: false })
  assert.equal(takeGuestDraft(store, 102), null)
  saveGuestDraft(store, draft, 100)
  assert.equal(takeGuestDraft(store, 100 + GUEST_DRAFT_TTL), null)
  assert.equal(store.values.size, 0)
})

test('sign-in preserves original dimensions and density hints, including nameless pasted images', () => {
  for (const source of [{ width: 2880, height: 1800, density: 2 }, { width: 2880, height: 1800 }, { width: 1440, height: 900, density: 1 }]) {
    const store = storage()
    const pending = { ...draft, images: [{ ...image, source }], submit: true }
    assert.equal(saveGuestDraft(store, pending, 100), true)
    assert.deepEqual(takeGuestDraft(store, 101), { ...pending, designMd: null })
    assert.equal(takeGuestDraft(store, 102), null)
  }
})

test('draft source metadata is bounded and only numeric fields are stored', () => {
  const store = storage()
  for (const source of [{ width: -1, height: 1800 }, { width: 10000, height: 10000 }, { width: '2880', height: 1800 }, null]) {
    assert.equal(saveGuestDraft(store, { ...draft, images: [{ ...image, source }] }, 100), true)
    assert.equal(takeGuestDraft(store, 101).images[0].source, undefined)
  }
  const source = { width: 2880, height: 1800, density: 2, token: 'must-not-persist', filename: 'private.png' }
  assert.equal(saveGuestDraft(store, { ...draft, images: [{ ...image, source }] }, 100), true)
  const raw = store.getItem(GUEST_DRAFT_KEY)
  assert.doesNotMatch(raw, /must-not-persist|private.png/)
  assert.deepEqual(takeGuestDraft(store, 101).images[0].source, { width: 2880, height: 1800, density: 2 })
})

test('invalid shapes, credential fields, unsafe previews, timestamps and oversized bytes are rejected', () => {
  for (const value of [null, [], {}, { ...envelope, version: 1 }, { ...envelope, submit: 'yes' }, { ...envelope, designMd: { id: 'not-in-catalog', name: 'X' } }, { ...envelope, designMd: { id: 'vercel', name: 'Not Vercel' } }, { ...envelope, designMd: { name: 'design.md', text: '' } }, { ...envelope, designMd: { name: 'design.md', text: 'x'.repeat(100 * 1024 + 1) } }, { ...envelope, designMd: { name: 'design.md', text: 'ok', source: 'upload' } }, { ...envelope, token: 'secret' }, { ...envelope, expiresAt: 100 + GUEST_DRAFT_TTL + 1 }, { ...envelope, text: 42 }, { ...envelope, text: '😀'.repeat(64 * 1024 + 1) }, { ...envelope, images: Array(9).fill(envelope.images[0]) }, { ...envelope, images: [{ ...envelope.images[0], preview: 'https://private.example' }] }, { ...envelope, images: [{ data: 'javascript:alert(1)', mimeType: 'image/png' }] }, { ...envelope, images: [{ data: 'aGVsbG8=', mimeType: 'text/html' }] }, { ...envelope, images: [{ data: 'A'.repeat(3 * 1024 * 1024 + 4), mimeType: 'image/png' }] }]) {
    assert.equal(parseGuestDraft(JSON.stringify(value), 100), null)
  }
  assert.equal(parseGuestDraft('{', 100), null)
  assert.equal(parseGuestDraft(' '.repeat(GUEST_DRAFT_MAX_BYTES + 1), 100), null)
})

test('malformed drafts are consumed without retry; logout clears only this draft', () => {
  const store = storage()
  store.setItem(GUEST_DRAFT_KEY, '{bad')
  assert.equal(takeGuestDraft(store), null)
  assert.equal(store.values.size, 0)
  saveGuestDraft(store, draft)
  store.setItem('unrelated', 'keep')
  clearGuestDraft(store)
  assert.equal(store.getItem(GUEST_DRAFT_KEY), null)
  assert.equal(store.getItem('unrelated'), 'keep')
})

test('storage quota or access failure never destroys the in-memory draft', () => {
  const store = { getItem() { throw Error('blocked') }, setItem() { throw Error('quota') }, removeItem() { throw Error('blocked') } }
  assert.equal(saveGuestDraft(store, draft), false)
  assert.equal(takeGuestDraft(store), null)
  assert.doesNotThrow(() => clearGuestDraft(store))
  assert.deepEqual(draft, { text: 'Build a landing page', images: [image] })
})

test('a send interrupted by sign-in keeps its design.md and resumes once', () => {
  const store = storage()
  for (const designMd of [{ id: 'vercel', name: 'Vercel' }, { name: 'brand.md', text: '# Brand\n\nBlack and white.' }]) {
    assert.equal(saveGuestDraft(store, { ...draft, designMd, submit: true }, 100), true)
    assert.deepEqual(takeGuestDraft(store, 101), { ...draft, designMd, submit: true })
    assert.equal(takeGuestDraft(store, 102), null)
  }
  // Sign-in from the account button restores the draft without sending it.
  saveGuestDraft(store, draft, 100)
  assert.equal(takeGuestDraft(store, 101).submit, false)
})
