import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'

// Runs the existing production app, not a mocked page. No auth, provider, Redis
// or database credentials are inherited. Empty values also override dotenv files.
test('normal fx0 serves guests without auth, Ampersand or database configuration', async () => {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const env = { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' }
  for (const name of [
    'APP_URL', 'SESSION_SECRET', 'VERCEL_OAUTH_CLIENT_ID', 'VERCEL_OAUTH_CLIENT_SECRET',
    'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'AI_GATEWAY_API_KEY',
    'AMPERSAND_API_KEY', 'AMPERSAND_BASE_URL', 'AMPERSAND_MODEL', 'FX0_COLLAB_ORIGIN',
  ]) env[name] = ''
  env.FX0_FREE_PROMPTS = '0'
  const child = spawn(process.execPath, [
    'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port),
  ], { cwd: new URL('../', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-32768) })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const request = (path, options) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...options })
  try {
    let started = false
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && child.exitCode === null) {
      try { started = (await request('/api/auth/me')).ok } catch {}
      if (started) break
      await sleep(100)
    }
    assert.ok(started, `production server must start without configuration: ${output}`)
    for (const cookie of ['', `fx0-collab=${'a'.repeat(43)}`]) {
      const response = await request('/', { headers: { accept: 'text/html', cookie } })
      assert.equal(response.status, 200)
      const html = await response.text()
      assert.match(html, /aria-label="fx0 home"/)
      assert.match(html, /href="\/"/)
      assert.doesNotMatch(html, /NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|"digest":"\d+"/)
      assert.doesNotMatch(html, /AMPERSAND|DATABASE_URL|SESSION_SECRET|\/api\/ampersand|fx0 together/)
      assert.deepEqual(await (await request('/api/auth/me', { headers: { cookie } })).json(), { user: null })
      assert.equal((await request('/api/sessions', { headers: { cookie } })).status, 401)
    }
    assert.doesNotMatch(output, /collab request failed|DATABASE_URL is required|SESSION_SECRET must|Error:/)
  } finally {
    child.kill('SIGTERM')
    await exited
  }
})
