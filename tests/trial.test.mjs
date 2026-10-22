import assert from 'node:assert/strict'
import test from 'node:test'
import { memoryRedis, turnCredentialWith } from './fixtures/memory-redis.mjs'

const trial = await import('../lib/trial.ts').catch(() => ({}))

test('a guest cookie proves only its random owner and never carries a Gateway credential', async (t) => {
  assert.equal(typeof trial.newGuestSession, 'function', 'anonymous trial identity is missing')
  const previous = process.env.SESSION_SECRET
  process.env.SESSION_SECRET = 'trial-test-session-password-long-enough'
  t.after(() => { if (previous === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previous })
  const first = trial.newGuestSession()
  const second = trial.newGuestSession()
  assert.notEqual(first.userId, second.userId)
  const cookie = await trial.sealGuestSession(first)
  const decoded = await trial.readGuestSession(cookie)
  assert.deepEqual(decoded, first)
  assert.equal(decoded.kind, 'guest')
  assert.equal(decoded.accessToken, undefined)
  assert.equal(decoded.refreshToken, undefined)
  assert.equal(decoded.teamId, undefined)
  assert.equal(await trial.readGuestSession(`${cookie.slice(0, -5)}wrong`), null)
  assert.equal(await trial.readGuestSession(await trial.sealGuestSession({ ...first, expiresAt: 1 })), null)
})

test('durable sponsored credentials survive recovery without storing the server key', async (t) => {
  const store = memoryRedis()
  const { values } = store
  const credentials = await turnCredentialWith(t, store)
  assert.equal(typeof credentials.readExecutionFunding, 'function', 'admission-bound funding is missing')
  const credentialOf = async (chatId, turnId) => {
    const funding = await credentials.readExecutionFunding(chatId, turnId)
    return funding.ok ? funding.credential : null
  }
  const previous = { secret: process.env.SESSION_SECRET, key: process.env.AI_GATEWAY_API_KEY, enabled: process.env.FX0_FREE_PROMPTS }
  Object.assign(process.env, { SESSION_SECRET: 'trial-test-session-password-long-enough', AI_GATEWAY_API_KEY: 'synthetic-server-key-never-store', FX0_FREE_PROMPTS: '1' })
  t.after(() => {
    for (const [name, value] of Object.entries({ SESSION_SECRET: previous.secret, AI_GATEWAY_API_KEY: previous.key, FX0_FREE_PROMPTS: previous.enabled })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  })
  const proof = { kind: 'trial', userId: 'guest:' + 'a'.repeat(32), loginId: 'a'.repeat(32), expiresAt: Date.now() + 86400000 }
  await credentials.saveTrialCredential('chat-a', proof, 1)
  const raw = values.get('test:credential:chat-a:turn:1')
  assert.ok(raw && !raw.includes(process.env.AI_GATEWAY_API_KEY))
  assert.deepEqual(await credentialOf('chat-a', 1), proof)
  assert.equal(await credentialOf('chat-a'), null, 'unknown resumed turn cannot use the latest credential')
  const paid = { userId: 'real-user', loginId: 'paid-login', accessToken: 'synthetic-user-token', teamId: 'team_paid', expiresAt: Date.now() + 3600000 }
  await credentials.saveTurnCredential('chat-a', paid, 2)
  assert.deepEqual(await credentialOf('chat-a', 1), proof)
  assert.equal((await credentialOf('chat-a', 2)).accessToken, paid.accessToken)
  const renewed = { ...paid, accessToken: 'renewed-user-token', expiresAt: paid.expiresAt + 3600000 }
  await credentials.renewLatestCredential('chat-a', renewed)
  assert.equal((await credentialOf('chat-a', 2)).accessToken, renewed.accessToken)
  values.delete('test:credential:chat-a:turn:1')
  assert.equal(await credentialOf('chat-a', 1), null, 'expired sponsorship cannot fall back to a paid credential')
  await credentials.saveTrialCredential('chat-a', proof, 1)
  await credentials.dropLoginCredentials(proof.loginId)
  assert.equal(await credentialOf('chat-a', 1), null)
  assert.equal((await credentialOf('chat-a', 2)).accessToken, renewed.accessToken, 'signout of one identity keeps another login intact')
  await credentials.dropChatCredential('chat-a')
  assert.equal(await credentialOf('chat-a', 2), null)
})

test('the picker\'s base model with fast on counts as the free-prompt model', async () => {
  const { usesFreePrompts } = await import('../lib/trial-policy.ts')
  assert.equal(usesFreePrompts('anthropic/claude-opus-5.5-fast', 'low'), true)
  assert.equal(usesFreePrompts('anthropic/claude-opus-5.5', 'low', true), true)
  assert.equal(usesFreePrompts('anthropic/claude-opus-5.5', 'low', false), false)
  assert.equal(usesFreePrompts('anthropic/claude-opus-5.5', 'high', true), false)
  assert.equal(usesFreePrompts('anthropic/claude-sonnet-5.5', 'low', true), false)
})

test('every address in one IPv6 /64 shares a free-prompt allowance', () => {
  const same = ['2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:0db8:0001:0002::', '2001:DB8:1:2:abcd::5']
  assert.equal(new Set(same.map(trial.allowanceAddress)).size, 1)
  assert.equal(trial.allowanceAddress('2001:db8:1:2::1'), '2001:0db8:0001:0002::/64')
  for (const other of ['2001:db8:1:3::1', '2001:db8:2:2::1', '2001:db9:1:2::1', '::1']) {
    assert.notEqual(trial.allowanceAddress(other), trial.allowanceAddress('2001:db8:1:2::1'), other)
  }
  assert.equal(trial.allowanceAddress('203.0.113.7'), '203.0.113.7')
  assert.equal(trial.allowanceAddress('::ffff:203.0.113.7'), '203.0.113.7')
  assert.notEqual(trial.allowanceAddress('::ffff:203.0.113.7'), trial.allowanceAddress('::ffff:203.0.113.8'))
})

test('the free-prompt bucket follows the prefix and not the address', (t) => {
  const previous = { secret: process.env.SESSION_SECRET, vercel: process.env.VERCEL }
  Object.assign(process.env, { SESSION_SECRET: 'trial-test-session-password-long-enough', VERCEL: '1' })
  t.after(() => {
    for (const [name, value] of Object.entries({ SESSION_SECRET: previous.secret, VERCEL: previous.vercel })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  })
  const bucket = (ip) => trial.trialIpHash(new Headers({ 'x-forwarded-for': ip }))
  assert.equal(bucket('2001:db8:1:2::1'), bucket('2001:db8:1:2:dead:beef:0:1'))
  assert.notEqual(bucket('2001:db8:1:2::1'), bucket('2001:db8:1:3::1'))
  assert.notEqual(bucket('203.0.113.7'), bucket('203.0.113.8'))
})
