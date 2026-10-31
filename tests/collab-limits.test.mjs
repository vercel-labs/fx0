import assert from 'node:assert/strict'
import test from 'node:test'
import { clientAddress, collabLimits, HOURLY_MESSAGE_LIMIT_MESSAGE } from '../lib/collab/limits.ts'
import { createRoomsDatabase, storeOn } from './fixtures/rooms-db.mjs'

const HOUR = 60 * 60 * 1000
const request = (forwardedFor) => new Request('https://demo.example/api/ampersand', forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } })

test('limits are off by default, parse whole numbers and refuse anything else', () => {
  assert.deepEqual(collabLimits({}), {
    paused: false, dailyMessages: null, hourlyMessages: null, maxMembers: null, maxRunningRooms: null, roomTtlDays: null, addresses: null,
  })
  assert.deepEqual(collabLimits({
    FX0_COLLAB_PAUSED: '1', FX0_COLLAB_DAILY_MESSAGES: '500', FX0_COLLAB_HOURLY_MESSAGES: '30', FX0_COLLAB_MAX_MEMBERS: '8', FX0_COLLAB_MAX_RUNNING_ROOMS: '4',
    FX0_COLLAB_ROOM_TTL_DAYS: '7', FX0_COLLAB_TRUSTED_PROXIES: '1', FX0_COLLAB_HOURLY_ADDRESS_MESSAGES: '120', FX0_COLLAB_HOURLY_ROOMS: '40',
  }), {
    paused: true, dailyMessages: 500, hourlyMessages: 30, maxMembers: 8, maxRunningRooms: 4, roomTtlDays: 7,
    addresses: { trustedProxies: 1, hourlyMessages: 120, hourlyRooms: 40 },
  })
  assert.deepEqual(collabLimits({ FX0_COLLAB_TRUSTED_PROXIES: '0' }).addresses, { trustedProxies: 0, hourlyMessages: null, hourlyRooms: null })
  for (const [name, value] of [['FX0_COLLAB_DAILY_MESSAGES', '0'], ['FX0_COLLAB_HOURLY_MESSAGES', '1.5'], ['FX0_COLLAB_MAX_MEMBERS', '-2'], ['FX0_COLLAB_TRUSTED_PROXIES', 'one'], ['FX0_COLLAB_PAUSED', 'yes']]) {
    assert.throws(() => collabLimits({ [name]: value }), new RegExp(name), `${name}=${value}`)
  }
  for (const name of ['FX0_COLLAB_HOURLY_ROOMS', 'FX0_COLLAB_HOURLY_ADDRESS_MESSAGES']) {
    assert.throws(() => collabLimits({ [name]: '20' }), /need FX0_COLLAB_TRUSTED_PROXIES/, name)
  }
})

test('the client address is the entry the trusted proxies received, and a header too short to hold it is refused', (t) => {
  const log = t.mock.method(console, 'error', () => {})
  assert.equal(clientAddress(request('203.0.113.7, 130.211.0.1'), 1), '203.0.113.7')
  assert.equal(clientAddress(request('10.0.0.1, 198.51.100.2,203.0.113.7, 130.211.0.1'), 1), '203.0.113.7')
  assert.equal(clientAddress(request('203.0.113.7'), 0), '203.0.113.7')
  for (const header of ['130.211.0.1', undefined]) {
    assert.throws(() => clientAddress(request(header), 1), { message: 'Client address unavailable' })
  }
  assert.deepEqual(log.mock.calls.map((call) => call.arguments[1]), [{ entries: 1, trustedProxies: 1 }, { entries: 0, trustedProxies: 1 }])
})

test('message admission reserves every hourly key atomically, deduplicates and forgets prior hours', async (t) => {
  const db = await createRoomsDatabase()
  t.after(() => db.close())
  const store = storeOn(db)
  for (const method of ['takeRunUnit', 'hourlyAllows', 'hourlyAdd']) assert.equal(method in store, false)
  const now = Date.now(), hour = Math.floor(now / HOUR)
  t.mock.method(Date, 'now', () => now)
  const token = 'a'.repeat(43)
  const { room } = await store.createRoom({ name: 'Alice', title: 'Limits', token })
  const uses = (browser, address) => [{ key: `browser:${browser}`, limit: 2 }, { key: `address:${address}`, limit: 3 }]
  const single = [{ key: 'browser:once', limit: 1 }]
  const append = (requestId, hourlyUses) => store.appendMessage(room.id, token, { text: 'Build this', requestId, dailyLimit: null, hourlyUses })
  const counters = async () => (await db.query('SELECT key, hour, count FROM ampersand_hourly ORDER BY key')).rows
  assert.equal((await append('once', single)).inserted, true)
  for (let repeat = 0; repeat < 3; repeat++) assert.equal((await append('once', single)).inserted, false)
  assert.deepEqual(await counters(), [{ key: 'browser:once', hour, count: 1 }])
  await assert.rejects(append('too-many', single), { message: HOURLY_MESSAGE_LIMIT_MESSAGE })
  await append('a-x', uses('a', 'x'))
  await append('b-x', uses('b', 'x'))
  await append('c-x', uses('c', 'x'))
  const before = await counters()
  await assert.rejects(append('d-x', uses('d', 'x')), { message: HOURLY_MESSAGE_LIMIT_MESSAGE })
  assert.deepEqual(await counters(), before, 'a full shared address consumes no browser reservation')
  await append('d-y', uses('d', 'y'))
  await append('a-y', uses('a', 'y'))
  const after = await counters()
  await assert.rejects(append('a-z', uses('a', 'z')), { message: HOURLY_MESSAGE_LIMIT_MESSAGE })
  assert.deepEqual(await counters(), after, 'a full browser consumes no address reservation')
  await append('unlimited', [])
  assert.deepEqual(await counters(), after)
  // Advance persisted counters to the previous hour rather than bypassing admission with a test-only counter API.
  await db.query('UPDATE ampersand_hourly SET hour = $1', [hour - 1])
  await append('next-hour', uses('a', 'x'))
  await append('once-next-hour', single)
  assert.deepEqual((await db.query('SELECT DISTINCT hour FROM ampersand_hourly')).rows, [{ hour }])
  assert.ok((await counters()).every((row) => row.count === 1))
})
