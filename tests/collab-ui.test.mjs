import assert from 'node:assert/strict'
import test from 'node:test'
import { errorText, inviteLink, postRoom, readInviteLink, readRevisionSource, readRoom, readWorkspace, RequestError, roomUrl } from '../components/collab-api.ts'
import { memberLabel, replyMarkdown } from '../components/collab-state.ts'

function browserAt(t, href) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href } } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else delete globalThis.window
  })
}

test('member labels name the viewer', () => {
  assert.equal(memberLabel({ id: 'a', name: 'Ada' }, 'a'), 'Ada (you)')
  assert.equal(memberLabel({ id: 'b', name: 'Bo' }, 'a'), 'Bo')
})

test('invite links carry the room in the query and the invite only in the fragment', (t) => {
  browserAt(t, 'https://fx0.test/collab?room=old&view=chat#invite=stale')
  assert.equal(roomUrl('room 1').toString(), 'https://fx0.test/collab?room=room+1')
  const link = inviteLink('room 1', 'a+b/c')
  assert.equal(link, 'https://fx0.test/collab?room=room+1#invite=a%2Bb%2Fc')
  assert.deepEqual(readInviteLink(new URL(link)), { roomId: 'room 1', invite: 'a+b/c' })
  assert.deepEqual(readInviteLink(new URL('https://fx0.test/collab')), { roomId: null, invite: '' })
})

test('reads use GET, room actions post their JSON body and nothing uses the HTTP cache', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }))
  assert.deepEqual(await readWorkspace(), { ok: true })
  assert.deepEqual(await readRoom('a b'), { ok: true })
  await readRoom('a b', 7)
  await readRevisionSource('a b', 3)
  await postRoom({ action: 'create', name: 'Ada', title: 'Launch' })
  await postRoom({ action: 'join', id: 'a', invite: 'secret', name: 'Bo' })
  await postRoom({ action: 'message', id: 'a', text: 'Hi', requestId: 'r1' })
  await postRoom({ action: 'retry', id: 'a' })
  assert.deepEqual(await postRoom({ action: 'invite', id: 'a' }), { ok: true })
  const post = (body) => ['/api/collab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, cache: 'no-store' }]
  assert.deepEqual(fetch.mock.calls.map((call) => call.arguments), [
    ['/api/collab', { method: 'GET', cache: 'no-store' }],
    ['/api/collab?room=a+b', { method: 'GET', cache: 'no-store' }],
    ['/api/collab?room=a+b&since=7', { method: 'GET', cache: 'no-store' }],
    ['/api/collab?room=a+b&revision=3', { method: 'GET', cache: 'no-store' }],
    post('{"action":"create","name":"Ada","title":"Launch"}'),
    post('{"action":"join","id":"a","invite":"secret","name":"Bo"}'),
    post('{"action":"message","id":"a","text":"Hi","requestId":"r1"}'),
    post('{"action":"retry","id":"a"}'),
    post('{"action":"invite","id":"a"}'),
  ])
})

test('a failed request keeps its status and the server message, or a generic one', async (t) => {
  const responses = [Response.json({ error: 'Room is full.' }, { status: 409 }), new Response('<html>', { status: 502 })]
  t.mock.method(globalThis, 'fetch', async () => responses.shift())
  await assert.rejects(postRoom({ action: 'invite', id: 'a' }), (error) => error instanceof RequestError && error.status === 409 && error.message === 'Room is full.')
  await assert.rejects(readWorkspace(), (error) => error instanceof RequestError && error.status === 502 && error.message === 'Could not reach the room. Please try again.')
  assert.equal(errorText(new RequestError('Room is full.', 409)), 'Room is full.')
  assert.equal(errorText('offline'), 'Something went wrong. Please try again.')
})

test('replies keep their markdown but images become links that load nothing', () => {
  assert.equal(replyMarkdown('**Done.** ![tracker](https://example.com/p.png) and ![ref][1]'), '**Done.** [tracker](https://example.com/p.png) and [ref][1]')
  assert.equal(replyMarkdown('No images here.'), 'No images here.')
})
