/**
 * Username-and-password sign-in, driven over real HTTP: the password route
 * sets the same sealed session the rest of the app reads, wrong answers are
 * refused alike and then throttled, and the chat WebSocket reads the cookie.
 *
 *   node scripts/test-password-login.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import * as h3 from 'h3'

// The route uses Nuxt's auto-imports; give it h3's own.
Object.assign(globalThis, {
  defineEventHandler: h3.defineEventHandler, readBody: h3.readBody, createError: h3.createError,
  getRequestIP: h3.getRequestIP, setResponseHeader: h3.setResponseHeader,
})

delete process.env.AUTH_DISABLED
process.env.AGENT_MANAGER_SECRET = 'x'.repeat(40)
process.env.DEV_USER = 'local'

const pl = await import('../server/utils/passwordLogin.ts')
const { currentUser, userFromCookieHeader } = await import('../server/utils/session.ts')
const route = (await import('../server/api/auth/password.post.ts')).default

// ── the hash ──
const stored = await pl.hashPassword('correct horse')
assert.match(stored, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/)
assert.equal(await pl.verifyPassword('correct horse', stored), true)
assert.equal(await pl.verifyPassword('correct horsf', stored), false)
assert.notEqual(await pl.hashPassword('correct horse'), stored, 'salted: the same password never hashes the same')
assert.equal(await pl.verifyPassword('x', 'scrypt$0$0$0$AAAA$AAAA'), false, 'a malformed hash is a wrong password, not a throw')

// ── off until both variables are set ──
assert.equal(pl.passwordLoginConfigured(), false)
process.env.AGENT_MANAGER_LOGIN_USER = 'arisht'
process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH = stored
assert.equal(pl.passwordLoginConfigured(), true)

const app = h3.createApp()
app.use('/api/auth/password', route)
app.use('/api/whoami', h3.defineEventHandler(async e => ({ user: await currentUser(e) })))
const server = createServer(h3.toNodeListener(app))
await new Promise(res => server.listen(0, '127.0.0.1', res))
const base = `http://127.0.0.1:${server.address().port}`
const post = (body, headers = {}) => fetch(`${base}/api/auth/password`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const whoami = async (headers = {}) => (await (await fetch(`${base}/api/whoami`, { headers })).json()).user

try {
  // ── signed out until signed in ──
  assert.equal(await whoami(), null, 'no session, no user')

  // ── wrong username and wrong password are the same answer ──
  const wrongPass = await post({ username: 'arisht', password: 'nope' })
  const wrongUser = await post({ username: 'someone', password: 'correct horse' })
  assert.equal(wrongPass.status, 401)
  assert.equal(wrongUser.status, 401)
  assert.equal((await wrongPass.json()).message, (await wrongUser.json()).message, 'a wrong username is not told apart from a wrong password')
  assert.equal(wrongPass.headers.get('set-cookie'), null, 'and no session is handed out')
  assert.equal((await post({ username: 'arisht' })).status, 400, 'a missing password is a bad request')

  // ── the right pair: a session the rest of the app reads ──
  const ok = await post({ username: 'Arisht ', password: 'correct horse' })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true, login: 'arisht' }, 'the username is matched without case or stray spaces')
  const cookie = ok.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie?.startsWith('am='), 'the same `am` session cookie GitHub sign-in sets')
  assert.equal((await whoami({ cookie }))?.login, 'arisht', 'currentUser reads it')
  assert.equal((await userFromCookieHeader(`other=1; ${cookie}`))?.login, 'arisht', 'and so does the WebSocket upgrade check')
  assert.equal(await userFromCookieHeader('am=garbage'), null, 'a tampered cookie is nobody')
  assert.equal(await userFromCookieHeader(undefined), null)

  // ── throttled after five failures, before the password is even checked ──
  pl._resetThrottle()
  for (let i = 0; i < 5; i++) assert.equal((await post({ username: 'arisht', password: `guess${i}` })).status, 401)
  const locked = await post({ username: 'arisht', password: 'correct horse' })
  assert.equal(locked.status, 429, 'the sixth try is refused, even with the right password')
  assert.ok(Number(locked.headers.get('retry-after')) > 0, 'and says when to come back')
  assert.equal(pl.lockedFor('127.0.0.1', Date.now() + 11 * 60 * 1000), 0, 'ten minutes later it is open again')
  pl._resetThrottle()

  // ── a script uses the instance's API token, not the password ──
  process.env.AGENT_MANAGER_API_TOKEN = 't'.repeat(40)
  process.env.AGENT_MANAGER_API_LOGIN = 'local'
  assert.equal((await whoami({ authorization: `Bearer ${'t'.repeat(40)}` }))?.login, 'local', 'the bearer token still works beside password sign-in')
  assert.equal(await whoami({ authorization: `Bearer ${'u'.repeat(40)}` }), null, 'and a wrong one is nobody')
  delete process.env.AGENT_MANAGER_API_TOKEN

  // ── not configured: the route says so ──
  delete process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH
  assert.equal((await post({ username: 'arisht', password: 'correct horse' })).status, 404)
} finally {
  server.close()
}

console.log('ok - password sign-in: one sealed session, alike refusals, throttled')
process.exit(0)
