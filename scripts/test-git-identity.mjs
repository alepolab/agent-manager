/**
 * A run's commits carry an identity that is not a person.
 *
 *   node scripts/test-git-identity.mjs
 *
 * The container had no git identity, so git used whatever it could find. A run
 * committed as `Claude Code <claude-code@anthropic.com>` and the pull request on
 * alepo-dev-team-infra rendered a COLLEAGUE's name and avatar:
 *
 *   commit.author:    Claude Code <claude-code@anthropic.com>
 *   github author:    Karim13014
 *
 * GitHub attributes a commit by matching its author email to an account, and
 * that address is registered to theirs. Nobody did anything — the identity was
 * never set, and the default landed on a real person.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'ident-'))
delete process.env.GIT_BOT_NAME
delete process.env.GIT_BOT_EMAIL

const U = await import('../server/utils/users.ts')

const VARS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']

// Author AND committer: GitHub renders the author, but a committer left unset
// falls back to the same guessing this exists to stop.
// With a signed-in developer, the commits are theirs.
const mine = U.gitIdentity({ login: 'ashwanisingh-alepo', name: 'Ashwani Singh', githubId: 12345 })
assert.equal(mine.GIT_AUTHOR_NAME, 'Ashwani Singh')
assert.equal(mine.GIT_AUTHOR_EMAIL, '12345+ashwanisingh-alepo@users.noreply.github.com',
  'the numeric id is what makes the address resolve to that account')
assert.equal(mine.GIT_COMMITTER_EMAIL, mine.GIT_AUTHOR_EMAIL)

// A profile saved before the id was captured still gets a resolvable address.
const noId = U.gitIdentity({ login: 'someone' })
assert.equal(noId.GIT_AUTHOR_NAME, 'someone', 'the login stands in for a missing display name')
assert.equal(noId.GIT_AUTHOR_EMAIL, 'someone@users.noreply.github.com')

// No developer to attribute to: the bot is the floor, never a guess.
const id = U.gitIdentity()
for (const v of VARS) assert.ok(id[v], `${v} must be set`)
assert.equal(id.GIT_AUTHOR_NAME, 'github-actions[bot]')
assert.equal(id.GIT_AUTHOR_EMAIL, '41898282+github-actions[bot]@users.noreply.github.com')
assert.equal(id.GIT_COMMITTER_NAME, id.GIT_AUTHOR_NAME)
assert.equal(id.GIT_COMMITTER_EMAIL, id.GIT_AUTHOR_EMAIL)

// Never a real person's address, however the identity is configured.
assert.ok(id.GIT_AUTHOR_EMAIL.endsWith('@users.noreply.github.com'),
  'the address must be a noreply one: it resolves to the bot and reaches nobody')
assert.ok(!/anthropic\.com$/.test(id.GIT_AUTHOR_EMAIL),
  'claude-code@anthropic.com is the exact address that misattributed a commit')

// Every path sets it. These early returns were the bug: an anonymous run - auth
// disabled, or a watch dispatch with no starter - still commits.
for (const login of [undefined, 'nobody-has-this-profile']) {
  const env = await U.envForUser(login)
  for (const v of VARS) {
    assert.ok(env[v], `${v} must be set even for login=${login}`)
  }
  assert.equal(env.GIT_AUTHOR_EMAIL, id.GIT_AUTHOR_EMAIL)
}

// A real run attributes to its starter.
{
  const dir = process.env.CLAUDE_DIR
  process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'ident2-'))
  const U2 = await import('../server/utils/users.ts?fresh')
  await U2.saveProfile('dev', { name: 'A Developer', githubId: 99 })
  const env = await U2.envForUser('dev')
  assert.equal(env.GIT_AUTHOR_NAME, 'A Developer', 'a run commits as the developer who started it')
  assert.equal(env.GIT_AUTHOR_EMAIL, '99+dev@users.noreply.github.com')
  rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
  process.env.CLAUDE_DIR = dir
}

// An operator can point the FALLBACK at their own bot without editing code.
process.env.GIT_BOT_NAME = 'alepo-bot'
process.env.GIT_BOT_EMAIL = 'alepo-bot@users.noreply.github.com'
assert.equal(U.gitIdentity().GIT_AUTHOR_NAME, 'alepo-bot')
assert.equal(U.gitIdentity().GIT_COMMITTER_EMAIL, 'alepo-bot@users.noreply.github.com')

// Whitespace in a pasted override must not produce a broken identity.
process.env.GIT_BOT_NAME = '   '
assert.equal(U.gitIdentity().GIT_AUTHOR_NAME, 'github-actions[bot]',
  'a blank override falls back rather than committing with an empty name')

delete process.env.GIT_BOT_NAME
delete process.env.GIT_BOT_EMAIL
rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('git identity: a run commits as its starter, and as the bot when there is none')
