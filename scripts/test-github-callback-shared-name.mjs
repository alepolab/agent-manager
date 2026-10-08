/**
 * GitHub sign-in refuses the password account's name. A GitHub token saved
 * under that login would go to every password session, ones already issued
 * included, as that person - their token on every run, their identity.
 *
 * The callback route is driven with GitHub's three endpoints stubbed.
 *
 *   node scripts/test-github-callback-shared-name.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { fetchNodeRequestHandler } from 'node-mock-http'

Object.assign(globalThis, {
  defineEventHandler: h3.defineEventHandler, getQuery: h3.getQuery, createError: h3.createError, sendRedirect: h3.sendRedirect,
})

delete process.env.AUTH_DISABLED
process.env.AGENT_MANAGER_SECRET = 'x'.repeat(40)
process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'callback-users-'))
process.env.GITHUB_CLIENT_ID = 'client'
process.env.GITHUB_CLIENT_SECRET = 'not-a-real-secret'
process.env.GITHUB_ORG = 'alepolab'
process.env.AGENT_MANAGER_LOGIN_USER = 'Shared-Name'
process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH = 'scrypt$16384$8$1$AAAA$AAAA'

const route = (await import('../server/api/auth/callback.get.ts')).default
const { getProfile } = await import('../server/utils/users.ts')

let githubLogin = 'shared-name'
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const u = String(url)
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  if (u === 'https://github.com/login/oauth/access_token') return json({ access_token: 'gho_not_a_real_token' })
  if (u === 'https://api.github.com/user') return json({ id: 4242, login: githubLogin, name: 'Someone' })
  if (u.startsWith('https://api.github.com/user/memberships/orgs/')) return json({ state: 'active' })
  return realFetch(url, init)
}

const app = h3.createApp()
app.use('/api/auth/callback', route)
const listener = h3.toNodeListener(app)

const sealed = async () => `am=${await h3.sealSession(
  { context: { sessions: { am: { id: 's', createdAt: Date.now(), data: { oauthState: 'st' } } } } },
  { name: 'am', password: process.env.AGENT_MANAGER_SECRET })}`
const callback = async () => fetchNodeRequestHandler(listener, 'http://localhost/api/auth/callback?code=c&state=st', { headers: { cookie: await sealed() } })

// ── the shared name, in any case: refused before anything is saved ──
for (const login of ['shared-name', 'SHARED-NAME', 'Shared-Name']) {
  githubLogin = login
  const res = await callback()
  assert.equal(res.status, 302)
  assert.match(decodeURIComponent(res.headers.get('location')), /^\/login\?error=.*password account/,
    `@${login} is sent back to the login page, told why`)
  assert.equal(await getProfile(login), null, `THE REGRESSION: @${login}'s GitHub token was saved under the password account's name`)
}
assert.ok(!existsSync(join(process.env.AGENT_USERS_DIR, 'shared-name.json')))

// ── any other member signs in as before ──
githubLogin = 'octocat'
const ok = await callback()
assert.equal(ok.status, 302)
assert.equal(ok.headers.get('location'), '/')
assert.equal((await getProfile('octocat'))?.githubId, 4242, 'their profile is saved')

// ── with password sign-in off, the name is nobody's to refuse ──
delete process.env.AGENT_MANAGER_LOGIN_USER
githubLogin = 'shared-name'
assert.equal((await callback()).headers.get('location'), '/')

console.log('ok - GitHub sign-in refuses the password account\'s name')
process.exit(0)
