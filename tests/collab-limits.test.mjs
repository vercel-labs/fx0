import assert from 'node:assert/strict'
import test from 'node:test'
import { clientAddress, collabLimits, HourlyCounter } from '../lib/collab/limits.ts'

const HOUR = 60 * 60 * 1000
const request = (forwardedFor) => new Request('https://demo.example/api/collab', forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } })

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

test('the hourly counter checks every use against its own limit, counts only when told, and starts over each hour', () => {
  const counter = new HourlyCounter()
  const now = 5 * HOUR + 10
  const uses = (browser, address) => [{ key: `browser:${browser}`, limit: 2 }, { key: `address:${address}`, limit: 3 }]
  const single = [{ key: 'browser:once', limit: 1 }]
  for (let check = 0; check < 3; check++) assert.equal(counter.allows(single, now), true, 'checking counts nothing')
  counter.add(single, now)
  assert.equal(counter.allows(single, now), false)
  counter.add(uses('a', 'x'), now)
  counter.add(uses('b', 'x'), now)
  counter.add(uses('c', 'x'), now)
  assert.equal(counter.allows(uses('d', 'x'), now), false, 'the shared address is at its own limit of 3')
  assert.equal(counter.allows(uses('d', 'y'), now), true)
  counter.add(uses('a', 'y'), now)
  assert.equal(counter.allows(uses('a', 'z'), now), false, 'browser a is at its limit of 2')
  assert.equal(counter.allows([], now), true)
  assert.equal(counter.allows(uses('a', 'x'), 6 * HOUR), true, 'a new hour starts over')
})
