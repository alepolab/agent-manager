/**
 * Username-and-password sign-in, driven the way production serves it: the bun
 * preset hands each request to Nitro's localFetch, which builds a mock request
 * with no client address. Routes are called through node-mock-http's
 * fetchNodeRequestHandler, the same path, so nothing here can lean on a real
 * socket the way the first version of this test did.
 *
 *   node scripts/test-password-login.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import * as h3 from 'h3'
import { fetchNodeRequestHandler } from 'node-mock-http'

// The route uses Nuxt's auto-imports; give it h3's own.
Object.assign(globalThis, {
  defineEventHandler: h3.defineEventHandler, readBody: h3.readBody, createError: h3.createError,
  setResponseHeader: h3.setResponseHeader,
})

delete process.env.AUTH_DISABLED
process.env.AGENT_MANAGER_SECRET = 'x'.repeat(40)
process.env.DEV_USER = 'local'
process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'password-login-users-'))

const pl = await import('../server/utils/passwordLogin.ts')
const { currentUser, userFromCookieHeader } = await import('../server/utils/session.ts')
const route = (await import('../server/api/auth/password.post.ts')).default

/** A hash in the format, with the cost the first version of this feature used. */
const legacyHash = (plain) => {
  const salt = randomBytes(16)
  return ['scrypt', 16384, 8, 1, salt.toString('base64'), scryptSync(plain, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')].join('$')
}

// ── the hash ──
const stored = await pl.hashPassword('correct horse')
assert.match(stored, /^scrypt\$131072\$8\$1\$[^$]+\$[^$]+$/, 'new hashes meet the OWASP floor, N=2^17')
assert.equal(await pl.verifyPassword('correct horse', stored), true)
assert.equal(await pl.verifyPassword('correct horsf', stored), false)
assert.notEqual(await pl.hashPassword('correct horse'), stored, 'salted: the same password never hashes the same')
const legacy = legacyHash('correct horse')
assert.equal(await pl.verifyPassword('correct horse', legacy), true, 'a hash made at N=2^14 (the live instance\'s) still verifies')
assert.equal(await pl.verifyPassword('correct horsf', legacy), false)
{
  const logged = []
  const error = console.error
  console.error = (...a) => logged.push(a.join(' '))
  try {
    assert.equal(await pl.verifyPassword('x', 'scrypt$0$0$0$AAAA$AAAA'), false, 'a malformed hash is a refusal, not a throw')
    const tooCostly = ['scrypt', 2 ** 22, 8, 1, 'AAAAAAAAAAAAAAAAAAAAAA==', 'AAAAAAAAAAAAAAAAAAAAAA=='].join('$')
    assert.equal(await pl.verifyPassword('x', tooCostly), false)
  } finally { console.error = error }
  // Node reads an N of 0 as its default, so only the second is unusable.
  assert.equal(logged.length, 1, 'a hash too costly to check says so, rather than passing as a wrong password')
  assert.match(logged[0], /cannot be checked \(ERR_CRYPTO_INVALID_SCRYPT_PARAMS\)/)
}

// ── off until both variables are set ──
assert.equal(pl.passwordLoginConfigured(), false)
process.env.AGENT_MANAGER_LOGIN_USER = 'arisht'
process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH = legacy
assert.equal(pl.passwordLoginConfigured(), true)

// Nitro's error handler sends the message; plain h3 leaves it out.
const app = h3.createApp({
  onError: (err, event) => h3.send(event, JSON.stringify({ statusCode: err.statusCode, message: err.message }), 'application/json'),
})
app.use('/api/auth/password', route)
app.use('/api/whoami', h3.defineEventHandler(async e => ({ user: await currentUser(e), ip: h3.getRequestIP(e) ?? null })))
const listener = h3.toNodeListener(app)
const call = (path, init = {}) => fetchNodeRequestHandler(listener, `http://localhost${path}`, init)
const post = (body, headers = {}) => call('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const whoami = async (headers = {}) => (await (await call('/api/whoami', { headers })).json())

// Delays are recorded rather than slept, so the backoff can be read exactly.
let slept = []
pl._resetBackoff({ sleep: async (ms) => { slept.push(ms) } })

// ── the production path has no client address ──
const probe = await whoami()
assert.equal(probe.ip, null, 'as under the bun preset: getRequestIP finds nothing to key a per-address limit on')
assert.equal(probe.user, null, 'no session, no user')

// ── wrong username and wrong password are the same answer ──
const wrongPass = await post({ username: 'arisht', password: 'nope' })
const wrongUser = await post({ username: 'someone', password: 'correct horse' })
assert.equal(wrongPass.status, 401)
assert.equal(wrongUser.status, 401)
assert.equal((await wrongPass.json()).message, (await wrongUser.json()).message, 'a wrong username is not told apart from a wrong password')
assert.equal(wrongPass.headers.get('set-cookie'), null, 'and no session is handed out')
assert.equal((await post({ username: 'arisht' })).status, 400, 'a missing password is a bad request')

// ── a stranger's failures slow the account down but never lock the owner out ──
for (let i = 0; i < 6; i++) assert.equal((await post({ username: 'arisht', password: `guess${i}` })).status, 401)
assert.deepEqual(slept, [0, 250, 500, 1000, 2000, 4000, 4000, 4000], 'each failure doubles the wait, capped at four seconds')
slept = []
const ok = await post({ username: 'Arisht ', password: 'correct horse' })
assert.equal(ok.status, 200, 'THE REGRESSION: after a stranger\'s failures the owner was locked out for ten minutes')
assert.deepEqual(await ok.json(), { ok: true, login: 'arisht' }, 'the username is matched without case or stray spaces')
assert.deepEqual(slept, [4000], 'the owner waited out the backoff, and was let in')
slept = []
await post({ username: 'arisht', password: 'wrong once' })
assert.deepEqual(slept, [0], 'a success clears the backoff')

// ── a burst is checked one attempt at a time ──
{
  pl._resetBackoff({ sleep: async (ms) => { slept.push(ms) } })
  slept = []
  const burst = await Promise.all([
    ...Array.from({ length: 7 }, (_, i) => post({ username: 'arisht', password: `burst${i}` })),
    post({ username: 'arisht', password: 'correct horse' }),
  ])
  assert.deepEqual(burst.map(r => r.status), [401, 401, 401, 401, 401, 401, 401, 200])
  assert.deepEqual(slept, [0, 250, 500, 1000, 2000, 4000, 4000, 4000],
    'THE REGRESSION: every attempt in the burst read "no failures yet" and ran at full speed')

  // More than eight waiting at once: the extra ones are refused unchecked.
  pl._resetBackoff({ sleep: async (ms) => { slept.push(ms) } })
  const flood = await Promise.all(Array.from({ length: 12 }, (_, i) => post({ username: 'arisht', password: `flood${i}` })))
  const statuses = flood.map(r => r.status)
  assert.equal(statuses.filter(s => s === 401).length, 8, 'eight were checked')
  assert.equal(statuses.filter(s => s === 429).length, 4, 'four were refused without costing a hash')
  assert.ok(Number(flood.find(r => r.status === 429).headers.get('retry-after')) > 0, 'and told when to come back')

  // With the real clock: three attempts at once take at least the backoff between them.
  pl._resetBackoff()
  const started = Date.now()
  await Promise.all([0, 1, 2].map(i => post({ username: 'arisht', password: `timed${i}` })))
  assert.ok(Date.now() - started >= 700, `a burst of three took ${Date.now() - started} ms; it should wait 0 + 250 + 500`)
  pl._resetBackoff({ sleep: async () => {} })
}

// ── the right pair: a session the rest of the app reads ──
const cookie = ok.headers.get('set-cookie')?.split(';')[0]
assert.ok(cookie?.startsWith('am='), 'the same `am` session cookie GitHub sign-in sets')
const me = (await whoami({ cookie })).user
assert.equal(me?.login, 'arisht', 'currentUser reads it')
assert.equal(me.pw, undefined, 'the password fingerprint stays in the cookie, out of what the app is handed')
assert.equal((await userFromCookieHeader(`other=1; ${cookie}`))?.login, 'arisht', 'and so does the WebSocket upgrade check')
assert.equal(await userFromCookieHeader('am=garbage'), null, 'a tampered cookie is nobody')
assert.equal(await userFromCookieHeader(undefined), null)

// ── changing the password signs the password sessions out ──
process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH = legacyHash('a new password')
assert.equal((await whoami({ cookie })).user, null, 'THE REGRESSION: a session from the old password outlived it')
assert.equal(await userFromCookieHeader(cookie), null, 'on the WebSocket too')
process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH = legacy
assert.equal((await whoami({ cookie })).user?.login, 'arisht', 'the fingerprint is the only thing that changed')
delete process.env.AGENT_MANAGER_LOGIN_USER
assert.equal((await whoami({ cookie })).user, null, 'switching password sign-in off ends its sessions too')
process.env.AGENT_MANAGER_LOGIN_USER = 'arisht'

// A cookie sealed before fingerprints were (as the first version of this
// feature issued them) is the password account with no fingerprint: ended.
{
  const sealOld = async (user) => `am=${await h3.sealSession(
    { context: { sessions: { am: { id: 'old', createdAt: Date.now(), data: { user } } } } },
    { name: 'am', password: process.env.AGENT_MANAGER_SECRET })}`
  assert.equal(await userFromCookieHeader(await sealOld({ login: 'arisht', name: 'arisht' })), null,
    'THE REGRESSION: a password session issued before this change would never end')
  assert.equal((await userFromCookieHeader(await sealOld({ login: 'octocat', name: 'Octo' })))?.login, 'octocat',
    'a GitHub session, which never carries a fingerprint, is untouched')
}

// ── the password account is never a GitHub user ──
const profile = join(process.env.AGENT_USERS_DIR, 'arisht.json')
writeFileSync(profile, JSON.stringify({ login: 'arisht', githubId: 12345, updatedAt: Date.now() }))
const taken = await post({ username: 'arisht', password: 'correct horse' })
assert.equal(taken.status, 403, 'a password session would have been that GitHub user, with their token')
assert.match((await taken.json()).message, /AGENT_MANAGER_LOGIN_USER/)
assert.equal(taken.headers.get('set-cookie'), null)
assert.equal((await post({ username: 'arisht', password: 'not it' })).status, 401, 'and a wrong password learns nothing of it')
writeFileSync(profile, JSON.stringify({ login: 'arisht', jiraEmail: 'a@b.c', updatedAt: Date.now() }))
assert.equal((await post({ username: 'arisht', password: 'correct horse' })).status, 200, 'a profile of its own (Jira credentials) is fine')
rmSync(profile)

// ── a script uses the instance's API token, not the password ──
process.env.AGENT_MANAGER_API_TOKEN = 't'.repeat(40)
process.env.AGENT_MANAGER_API_LOGIN = 'local'
assert.equal((await whoami({ authorization: `Bearer ${'t'.repeat(40)}` })).user?.login, 'local', 'the bearer token still works beside password sign-in')
assert.equal((await whoami({ authorization: `Bearer ${'u'.repeat(40)}` })).user, null, 'and a wrong one is nobody')
delete process.env.AGENT_MANAGER_API_TOKEN

// ── not configured: the route says so ──
delete process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH
assert.equal((await post({ username: 'arisht', password: 'correct horse' })).status, 404)

console.log('ok - password sign-in: one sealed session, alike refusals, per-account backoff, sessions end with the password')
process.exit(0)
