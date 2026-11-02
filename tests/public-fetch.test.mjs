import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import dns from 'node:dns/promises'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { isPublicAddress, publicDestination, fetchPublicText, MAX_FETCH_BYTES } from '../lib/public-fetch.ts'
import { createTools } from '../lib/tools.ts'

const publicIp = '93.184.216.34'
const lookup = async () => [{ address: publicIp, family: 4 }]

test('only public IPs are admitted, including alternate and IPv6 encodings', async () => {
  for (const ip of ['0.1.2.3', '10.0.0.1', '100.100.100.200', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '224.1.1.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '3fff::1']) {
    assert.equal(isPublicAddress(ip), false, ip)
  }
  for (const ip of [publicIp, '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip)
  for (const url of ['http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://localhost./', 'http://foo.local/', 'https://u:p@example.com', 'file:///tmp/test', 'ftp://example.com/']) {
    await assert.rejects(publicDestination(url, lookup), undefined, url)
  }
  // One private answer among public ones is enough to refuse the host.
  await assert.rejects(publicDestination('https://example.com', async () => [{ address: publicIp, family: 4 }, { address: '10.1.1.1', family: 4 }]))
  assert.equal((await publicDestination('https://example.com', lookup)).address.address, publicIp)
})

function transport(t, replies, resolve = lookup) {
  const requests = []
  t.mock.method(dns, 'lookup', resolve)
  t.mock.method(http, 'request', (url, options, callback) => {
    const request = new EventEmitter()
    request.end = () => queueMicrotask(() => {
      const response = Readable.from(replies.shift().chunks, { objectMode: false })
      Object.assign(response, request.reply)
      callback(response)
    })
    request.reply = replies[0]
    requests.push({ url: url.href, options })
    return request
  })
  return requests
}

test('connections pin DNS, preserve Host, and validate every redirect before connecting', async (t) => {
  const requests = transport(t, [{ statusCode: 302, headers: { location: 'http://127.0.0.1/private' }, chunks: [] }])
  await assert.rejects(fetchPublicText('http://example.com', new AbortController().signal))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].options.agent, false)
  requests[0].options.lookup('example.com', { all: true }, (error, addresses) => {
    assert.equal(error, null)
    assert.deepEqual(addresses, [{ address: publicIp, family: 4 }])
  })
})

test('public redirect chains succeed and loops stop after five hops', async (t) => {
  let requests = transport(t, [{ statusCode: 302, headers: { location: '/next' }, chunks: [] }, { statusCode: 200, headers: {}, chunks: [Buffer.from('hello')] }])
  assert.deepEqual(await fetchPublicText('http://example.com', new AbortController().signal), { status: 200, url: 'http://example.com/next', raw: 'hello', contentType: undefined })
  assert.equal(requests.length, 2)
  t.mock.restoreAll()
  requests = transport(t, Array.from({ length: 6 }, () => ({ statusCode: 302, headers: { location: '/loop' }, chunks: [] })))
  await assert.rejects(fetchPublicText('http://example.com', new AbortController().signal), /Too many redirects/)
  assert.equal(requests.length, 6)
})

test('large advertised, chunked and compressed bodies are rejected before unbounded buffering', async (t) => {
  for (const reply of [
    { headers: { 'content-length': String(MAX_FETCH_BYTES + 1) }, chunks: [] },
    { headers: {}, chunks: [Buffer.alloc(MAX_FETCH_BYTES), Buffer.from('x')] },
    { headers: { 'content-encoding': 'gzip' }, chunks: [] },
  ]) {
    transport(t, [{ statusCode: 200, ...reply }])
    await assert.rejects(fetchPublicText('http://example.com', new AbortController().signal))
    t.mock.restoreAll()
  }
})

test('already cancelled and slow DNS requests cannot open connections', async (t) => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(fetchPublicText('http://example.com', controller.signal))
  t.mock.method(dns, 'lookup', () => new Promise(() => {}))
  await assert.rejects(fetchPublicText('http://example.com', AbortSignal.timeout(10)))
})

function webFetch() {
  const host = {
    reportInvocation: () => 1, storeResult: () => {}, readResult: () => undefined, askUser: async () => ({}),
    log: () => {}, spawnSubagent: async () => 'done', capabilitySearch: () => [],
    readDesign: async () => ({ html: null, artifactRevision: 0 }),
    publishDesign: async () => ({ ok: true, revision: 1, changed: true }),
    editDesign: async () => ({ ok: true, revision: 2, changed: true }),
  }
  const tool = createTools(host).find((candidate) => candidate.name === 'web_fetch')
  return (url) => tool.execute({ url }, { signal: new AbortController().signal })
}

test('web_fetch refuses private destinations without opening a connection', async (t) => {
  // A public-looking name that resolves inside the network, as a rebinding host would.
  const requests = transport(t, [], async () => [{ address: '10.0.0.5', family: 4 }])
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('web_fetch must not use an unchecked fetch') })
  const fetchUrl = webFetch()
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:3000/api/debug', 'http://[::1]/', 'http://rebind.example/']) {
    assert.deepEqual(await fetchUrl(url), { error: 'public page fetch failed' }, url)
  }
  assert.equal(requests.length, 0)
  assert.equal(network.mock.callCount(), 0)
})

test('web_fetch still reads public pages as text', async (t) => {
  transport(t, [{ statusCode: 200, headers: {}, chunks: [Buffer.from('<html><head><style>p{}</style></head><body><p>Hello <b>there</b></p><script>x()</script></body></html>')] }])
  assert.deepEqual(await webFetch()('http://example.com/page'), { status: 200, url: 'http://example.com/page', content: 'Hello there' })
  t.mock.restoreAll()
  transport(t, [{ statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, chunks: [Buffer.from('<p>Hi <svg><path d="M0 0"/></svg></p>')] }])
  assert.equal((await webFetch()('http://example.com/page')).content, 'Hi')
})

test('web_fetch returns SVG, XML, JSON and CSS as is, so their markup is not lost', async (t) => {
  const svg = '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><path d="m1 1h8"/></svg>'
  for (const [headers, body] of [
    [{ 'content-type': 'image/svg+xml' }, svg],
    [{}, svg],
    [{}, `<?xml version="1.0"?>\n${svg}`],
    [{ 'content-type': 'application/json' }, '{"a":"<b>"}'],
    [{ 'content-type': 'text/css' }, 'a::before{content:"<i>"}'],
  ]) {
    transport(t, [{ statusCode: 200, headers, chunks: [Buffer.from(body)] }])
    assert.deepEqual(await webFetch()('http://example.com/logo.svg'), { status: 200, url: 'http://example.com/logo.svg', content: body }, body)
    t.mock.restoreAll()
  }
})
