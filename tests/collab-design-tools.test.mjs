import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesignTools } from '../lib/collab/design-tools.ts'

const HTML = '<!doctype html><html><head><title>Shared</title></head><body><h1>Hello team</h1><button>RSVP</button></body></html>'

// The tools run alone: what they store or tell the teammate is recorded instead.
function tools({ html = '', revision = 0, pending = [], review = true } = {}) {
  const recorded = { text: [], published: [], activity: [], told: [] }
  const design = createDesignTools({
    html, revision, pending, review,
    hooks: {
      onText: (text) => { recorded.text.push(text) },
      onPublish: (published) => { recorded.published.push(published) },
      onActivity: (event) => { recorded.activity.push(event) },
    },
    tellTeammate: async (from, channel, text) => { recorded.told.push(`${from} ${channel}: ${text}`) },
  })
  // A failed result becomes { error }; a JSON output is parsed.
  const call = async (seat, name, toolArguments = {}) => {
    const result = await design.run(seat, name, toolArguments)
    if (!result.success) return { error: result.error }
    return result.output.startsWith('{') ? JSON.parse(result.output) : result.output
  }
  return { design, recorded, call }
}

const staleError = (current) => ({ error: `Stale design revision. The current revision is ${current}; call read_design and merge your change into it before publishing.` })

test('a publish needs the current base revision and a valid page, and stores the normalized HTML', async () => {
  const { call, recorded } = tools()
  const publish = (html, baseRevision = 0) => call('Builder', 'publish_design', { html, base_revision: baseRevision })
  assert.deepEqual(await publish(HTML, 1), staleError(0))
  assert.deepEqual(await call('Builder', 'publish_design', { base_revision: 0 }), { error: 'publish_design needs the complete HTML document as text' })
  for (const [html, error] of [
    [HTML.replace('</head>', '<script src="https://tracker.example/a.js"></script></head>'), 'design artifact scripts must be inline'],
    [HTML.replace('</h1>', '</h1><img src="https://images.example/a.png" alt="">'), 'design artifact src values must use a compatible embedded data: URL'],
    ['<html><body>No doctype</body></html>', 'design artifact must start with <!doctype html>, but it starts with "<html><body>No doctype</…"'],
  ]) assert.deepEqual(await publish(html), { error })
  assert.deepEqual(recorded.published, [], 'a rejected page is never stored')

  assert.deepEqual(await publish(`  ${HTML}\n`), { published: true, revision: 1, bytes: Buffer.byteLength(HTML) })
  assert.deepEqual(recorded.published, [HTML])
  assert.deepEqual(recorded.activity, [{ agent: 'Builder', kind: 'publish', text: 'Published the shared design', revision: 1 }])
  assert.deepEqual(recorded.told, ['Builder notice: Builder published revision 1. Read it before relying on an earlier copy; earlier approvals no longer apply.'])
  assert.deepEqual(await call('Reviewer', 'read_design'), { html: HTML, revision: 1, pending_requests: [] })
  assert.deepEqual(await publish(HTML, 0), staleError(1))
})

test('the review gate follows the exact current revision', async () => {
  const { call, recorded } = tools()
  const review = (revision, summary = 'Looks right.') => call('Reviewer', 'finish_review', { revision, summary, addressed_message_ids: [] })
  const reply = (content = 'Done.') => call('Builder', 'room_reply', { content, addressed_message_ids: [] })
  assert.deepEqual(await review(0), { error: 'Nothing has been published yet; wait for the Builder.' })
  await call('Builder', 'publish_design', { html: HTML, base_revision: 0 })
  assert.deepEqual(await reply(), { error: 'Wait for the Reviewer to approve revision 1 first.' })
  assert.deepEqual(await review(1), { error: 'Read revision 1 with read_design before approving it.' })
  await call('Reviewer', 'read_design')
  assert.deepEqual(await review(0), { error: 'Revision 1 is current. Read it and review that revision.' })
  assert.deepEqual(await review(1, ' Checked the heading. '), { approved: true, revision: 1, addressed_message_ids: [] })
  // A repeated approval of the same revision is accepted without a second notice or activity entry.
  assert.deepEqual(await review(1, 'Checked it again.'), { approved: true, revision: 1, addressed_message_ids: [] })
  assert.deepEqual(recorded.told.slice(1), ['Reviewer notice: Reviewer approved revision 1. Notes: Checked the heading.'])
  assert.deepEqual(recorded.activity.filter((event) => event.kind === 'review'), [{ agent: 'Reviewer', kind: 'review', text: ' Checked the heading. ', revision: 1 }])

  // A newer publish invalidates the approval the Builder was about to rely on.
  await call('Builder', 'publish_design', { html: HTML.replace('Hello team', 'Hello everyone'), base_revision: 1 })
  assert.deepEqual(await reply(), { error: 'Wait for the Reviewer to approve revision 2 first.' })
  assert.deepEqual(await review(2), { error: 'Read revision 2 with read_design before approving it.' })
  await call('Reviewer', 'read_design')
  assert.deepEqual(await review(2), { approved: true, revision: 2, addressed_message_ids: [] })
  assert.equal(await reply('Reviewed and ready.'), 'Posted to the room.')
  assert.deepEqual(recorded.text, ['Reviewed and ready.'])
})

test('tools check text bounds, seats and arguments; a run that leaves the page alone settles with the Builder\'s pass or reply, and a change needs approval and a reply', async () => {
  const { design, call, recorded } = tools()
  const unsettled = 'The Builder neither replied to the room nor passed on its open requests'
  assert.equal(design.completionError().message, unsettled)
  assert.deepEqual([
    await call('Builder', 'room_reply', { content: 'x'.repeat(4001) }),
    await call('Builder', 'send_message', { content: 'x'.repeat(4001) }),
    await call('Builder', 'send_message', { content: '   ' }),
    await call('Reviewer', 'room_reply', { content: 'Hello.' }),
    await call('Builder', 'finish_review', { revision: 0, summary: 'Fine.' }),
    await call('Builder', 'delete_design'),
    await call('Builder', 'read_design', ['not', 'an', 'object']),
  ], [
    { error: 'room_reply needs 1–4000 characters of content' },
    { error: 'send_message needs 1–4000 characters of content' },
    { error: 'send_message needs 1–4000 characters of content' },
    { error: 'room_reply is not one of your tools' },
    { error: 'finish_review is not one of your tools' },
    { error: 'delete_design is not one of your tools' },
    { error: 'Tool arguments must be a JSON object' },
  ])
  // Only the Builder answers the room, so the Reviewer's pass ends its turn without settling anything.
  assert.equal(await call('Reviewer', 'pass'), 'Nothing posted.')
  assert.equal(design.completionError().message, unsettled)
  assert.equal(await call('Builder', 'pass', { addressed_message_ids: [] }), 'Nothing posted.')
  assert.equal(design.completionError(), undefined)
  assert.deepEqual([recorded.activity, recorded.told, recorded.text], [[], [], []], 'a pass or a rejected call has no effect')

  assert.equal(await call('Builder', 'send_message', { content: 'Check the header.' }), 'Sent to Reviewer.')
  assert.deepEqual(recorded.told, ['Builder team: Check the header.'])
  assert.deepEqual(recorded.activity, [{ agent: 'Builder', kind: 'message', text: 'Check the header.' }])
  // Limits count UTF-16 units, so the longest reply may end in an emoji; a reply alone settles a room with no design.
  const longest = 'x'.repeat(3998) + '👋'
  assert.equal(longest.length, 4000)
  const replied = tools()
  assert.equal(await replied.call('Builder', 'room_reply', { content: longest, addressed_message_ids: [] }), 'Posted to the room.')
  assert.equal(replied.design.completionError(), undefined)

  // An existing design left as it was settles with a pass; a new revision refuses the pass and needs this run's approval, then a reply.
  const designed = tools({ html: HTML, revision: 2 })
  assert.equal(designed.design.completionError().message, unsettled)
  assert.equal(await designed.call('Builder', 'pass', { addressed_message_ids: [] }), 'Nothing posted.')
  assert.equal(designed.design.completionError(), undefined)
  await designed.call('Builder', 'publish_design', { html: HTML.replace('Hello team', 'Hello all'), base_revision: 2 })
  assert.deepEqual(await designed.call('Builder', 'pass', { addressed_message_ids: [] }), { error: 'You changed the page this run. Once the Reviewer approves revision 3, tell the room with room_reply.' })
  assert.equal(designed.design.completionError().message, 'The Reviewer did not approve revision 3')
  await designed.call('Reviewer', 'read_design')
  assert.deepEqual(await designed.call('Reviewer', 'finish_review', { revision: 3, summary: 's'.repeat(2001) }), { error: 'finish_review needs a summary of 1–2000 characters' })
  assert.deepEqual(await designed.call('Reviewer', 'finish_review', { revision: 3, summary: 's'.repeat(2000), addressed_message_ids: [] }), { approved: true, revision: 3, addressed_message_ids: [] })
  assert.equal(designed.design.completionError().message, 'The Builder did not reply to the room about revision 3')
  await designed.call('Builder', 'room_reply', { content: 'Updated the heading.', addressed_message_ids: [] })
  assert.equal(designed.design.completionError(), undefined)
})

test('the Builder\'s pass must account for every pending request too', async () => {
  const pending = [
    { id: 11, authorId: 'alice', author: 'Alice', role: 'user', text: 'Bob, should the header be green?', createdAt: 1000 },
    { id: 14, authorId: 'bob', author: 'Bob', role: 'user', text: 'hmm no', createdAt: 2000 },
  ]
  const { call, design, recorded } = tools({ html: HTML, revision: 1, pending })
  for (const ids of [undefined, [], [14], [11, 11, 14], [11, 14, 99]]) {
    const result = await call('Builder', 'pass', ids === undefined ? {} : { addressed_message_ids: ids })
    assert.match(result.error, /addressed_message_ids must contain each of \[11,14\]/, `pass accepted ${JSON.stringify(ids)}`)
    assert.ok(design.completionError())
  }
  assert.equal(await call('Builder', 'pass', { addressed_message_ids: [14, 11] }), 'Nothing posted.')
  assert.equal(design.completionError(), undefined)
  assert.deepEqual([recorded.activity, recorded.told, recorded.text], [[], [], []])
})

test('approval and a visible reply each need exact coverage of every pending person request', async () => {
  const pending = [
    { id: 11, authorId: 'alice', author: 'Alice', role: 'user', text: 'Keep the RSVP button.', createdAt: 1000 },
    { id: 14, authorId: 'bob', author: 'Bob', role: 'user', text: 'Add the Tuesday heading.', createdAt: 2000 },
  ]
  const { call, design, recorded } = tools({ html: HTML, revision: 1, pending })
  const current = await call('Reviewer', 'read_design')
  assert.deepEqual(current.pending_requests, pending.map(({ id, authorId, author, text, createdAt }) => ({ id, authorId, author, text, createdAt })))
  for (const ids of [undefined, [], [14], [11], [11, 11, 14], [11, 14, 99], ['11', 14]]) {
    const result = await call('Reviewer', 'finish_review', { revision: 1, summary: 'Checked only what was listed.', ...(ids === undefined ? {} : { addressed_message_ids: ids }) })
    assert.match(result.error, /address|request|pending|cover/i, `Reviewer accepted ${JSON.stringify(ids)}`)
  }
  assert.deepEqual(recorded.activity, [])
  assert.deepEqual(await call('Reviewer', 'finish_review', { revision: 1, summary: 'Checked both the RSVP button and Tuesday heading.', addressed_message_ids: current.pending_requests.map((request) => request.id) }), { approved: true, revision: 1, addressed_message_ids: [11, 14] })
  for (const ids of [undefined, [], [14], [11, 14, 14], [11, 14, 99]]) {
    const result = await call('Builder', 'room_reply', { content: 'Updated the Tuesday heading.', ...(ids === undefined ? {} : { addressed_message_ids: ids }) })
    assert.match(result.error, /address|request|pending|cover/i, `Builder accepted ${JSON.stringify(ids)}`)
  }
  assert.deepEqual(recorded.text, [], 'an approval does not let a partial reply silently close both requests')
  assert.ok(design.completionError())
  const latest = await call('Builder', 'read_design')
  assert.equal(await call('Builder', 'room_reply', { content: 'Kept the RSVP button and added the Tuesday heading.', addressed_message_ids: latest.pending_requests.map((request) => request.id) }), 'Posted to the room.')
  assert.equal(design.completionError(), undefined)
})

test('with review off the Builder has no teammate, and replies to its own change without an approval', async () => {
  const pending = [{ id: 11, authorId: 'alice', author: 'Alice', role: 'user', text: 'Say hello to everyone.', createdAt: 1000 }]
  const { call, design, recorded } = tools({ html: HTML, revision: 1, pending, review: false })
  assert.deepEqual([
    await call('Builder', 'send_message', { content: 'Check it.' }),
    await call('Builder', 'finish_review', { revision: 1, summary: 'Fine.', addressed_message_ids: [11] }),
  ], [{ error: 'send_message is not one of your tools' }, { error: 'finish_review is not one of your tools' }])
  await call('Builder', 'read_design')
  assert.equal((await call('Builder', 'publish_design', { html: HTML.replace('Hello team', 'Hello everyone'), base_revision: 1 })).revision, 2)
  assert.deepEqual(recorded.told, [], 'a publish tells no teammate')
  assert.deepEqual(await call('Builder', 'pass', { addressed_message_ids: [11] }), { error: 'You changed the page this run. Tell the room with room_reply.' })
  assert.equal(design.completionError().message, 'The Builder did not reply to the room about revision 2')
  assert.equal(await call('Builder', 'room_reply', { content: 'Now it says hello to everyone.', addressed_message_ids: [11] }), 'Posted to the room.')
  assert.equal(design.completionError(), undefined)
})
