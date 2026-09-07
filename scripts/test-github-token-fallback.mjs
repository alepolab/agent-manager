// A developer's stored GitHub token that GitHub rejects must not be handed to a
// run: with GH_TOKEN set, gh and git ignore the working login the host mounts,
// and a real run lost its provisioner to "Invalid username or token" while the
// container could reach GitHub perfectly well without that token.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'gh-token-users-'))
process.env.AGENT_MANAGER_SECRET = 'test-secret-long-enough-for-the-store-0000'

const { saveProfile, envForUser } = await import('../server/utils/users.ts')

const answer = status => async () => new Response(status === 200 ? '{"login":"dev"}' : 'nope', { status })

// Rejected: the token stays out of the environment, the identity stays.
await saveProfile('dev', { name: 'Dev', githubTokenPlain: 'ghp_stale' })
const rejected = await envForUser('dev', answer(401))
assert.equal(rejected.GH_TOKEN, undefined, 'a rejected token is not injected')
assert.equal(rejected.GITHUB_TOKEN, undefined)
assert.ok(rejected.GIT_AUTHOR_NAME || rejected.GIT_COMMITTER_NAME, 'the commit identity is still set')

// Accepted: injected as before.
await saveProfile('dev', { githubTokenPlain: 'ghp_fresh' })
const accepted = await envForUser('dev', answer(200))
assert.equal(accepted.GH_TOKEN, 'ghp_fresh')
assert.equal(accepted.GITHUB_TOKEN, 'ghp_fresh')

// Memoised: the second call for the same token does not ask GitHub again.
let asked = 0
const again = await envForUser('dev', async () => { asked++; return new Response('nope', { status: 401 }) })
assert.equal(again.GH_TOKEN, 'ghp_fresh', 'the cached verdict is used')
assert.equal(asked, 0)

// GitHub unreachable: the token is kept, because nothing proved it wrong.
await saveProfile('dev', { githubTokenPlain: 'ghp_unverified' })
const offline = await envForUser('dev', async () => { throw new Error('ENOTFOUND api.github.com') })
assert.equal(offline.GH_TOKEN, 'ghp_unverified')

console.log('github token fallback: all checks passed')
