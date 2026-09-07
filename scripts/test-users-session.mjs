/**
 * Self-checks for the profile store's encryption, the per-user environment,
 * and the public-path rule of the auth middleware.
 *
 *   node scripts/test-users-session.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'users-'))
process.env.AGENT_MANAGER_SECRET = 'test-secret-that-is-long-enough-for-sealing-0001'
const U = await import('../server/utils/users.ts')
const S = await import('../server/utils/session.ts')

assert.equal(U.decrypt(U.encrypt('hunter2')), 'hunter2', 'round trip')
assert.notEqual(U.encrypt('hunter2'), U.encrypt('hunter2'), 'a fresh IV each time')
process.env.AGENT_MANAGER_SECRET = 'a-different-secret-that-is-also-long-enough-000'
const sealedElsewhere = U.encrypt('x')
process.env.AGENT_MANAGER_SECRET = 'test-secret-that-is-long-enough-for-sealing-0001'
assert.throws(() => U.decrypt(sealedElsewhere), 'a value sealed under another key does not open')

const p = await U.saveProfile('sandeep', { name: 'Sandeep', jiraEmail: 'sandeep@example.com', jiraTokenPlain: 'jira-secret', githubTokenPlain: 'gh-secret' })
assert.ok(p.jiraToken.startsWith('v1:') && p.githubToken.startsWith('v1:'), 'tokens are stored sealed')
const raw = readFileSync(join(process.env.AGENT_USERS_DIR, 'sandeep.json'), 'utf8')
assert.ok(!raw.includes('jira-secret') && !raw.includes('gh-secret'), 'no plaintext token on disk')
assert.deepEqual(U.toPublic(p).hasJiraToken, true)
assert.ok(!('jiraToken' in U.toPublic(p)), 'public view carries no sealed token')

const env = await U.envForUser('sandeep')
assert.equal(env.GH_TOKEN, 'gh-secret'); assert.equal(env.GITHUB_TOKEN, 'gh-secret'); assert.equal(env.JIRA_API_TOKEN, 'jira-secret')
assert.match(readFileSync(env.JIRA_CONFIG_FILE, 'utf8'), /login: sandeep@example\.com/, 'a per-user jira config names the user')
assert.equal(env.GIT_AUTHOR_NAME, 'Sandeep', 'a run commits as the developer who started it, by display name')
assert.equal(env.GIT_AUTHOR_EMAIL, 'sandeep@users.noreply.github.com',
  'with no numeric id captured, the login-only noreply form still resolves')
// No tokens for an unknown or absent user — but the git identity is still set,
// because an anonymous run still commits and git must not be left to invent one.
// A run once committed as claude-code@anthropic.com and the pull request
// rendered a colleague's name, because GitHub matches a commit to an account by
// its author email.
for (const who of ['nobody', undefined]) {
  const e = await U.envForUser(who)
  assert.equal(e.GH_TOKEN, undefined, `no github token for ${who}`)
  assert.equal(e.JIRA_API_TOKEN, undefined, `no jira token for ${who}`)
  assert.equal(e.GIT_AUTHOR_NAME, 'github-actions[bot]', `bot identity for ${who}`)
  assert.equal(e.GIT_AUTHOR_EMAIL, '41898282+github-actions[bot]@users.noreply.github.com')
}
await U.saveProfile('sandeep', { jiraTokenPlain: '' })
assert.equal((await U.envForUser('sandeep')).JIRA_API_TOKEN, undefined, 'an empty token clears it')

assert.equal(S.isPublicApiPath('/api/health'), true)
assert.equal(S.isPublicApiPath('/api/auth/login'), true)
assert.equal(S.isPublicApiPath('/api/runs'), false)
assert.equal(S.isPublicApiPath('/api/me'), false, 'me needs a session so the client can tell signed-out apart')

rmSync(process.env.AGENT_USERS_DIR, { recursive: true, force: true })
console.log('users + session: all assertions passed')
