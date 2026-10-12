/**
 * Each developer's agents run on their own Claude credential, never the
 * instance's, and a developer with none is refused.
 *
 *   node scripts/test-claude-credential.mjs
 *
 * The instance credential is set in this process's environment throughout, as
 * it would be on a host that still has one: the point is that it never reaches
 * an agent, neither beside a developer's token nor in place of a missing one.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'claude-cred-users-'))
process.env.AGENT_USERS_DIR = dir
process.env.AGENT_MANAGER_SECRET = 'x'.repeat(40)
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-INSTANCE'
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-INSTANCE'
delete process.env.AUTH_DISABLED

const { saveProfile, envForUser, toPublic, getProfile, claudeCredentialProblem, anthropicKindOf } = await import('../server/utils/users.ts')
const { launchEnv } = await import('../server/utils/agentCaller.ts')
const { runPreflight, preflightFailure } = await import('../server/utils/preflight.ts')
const { normalizeSDKMessage } = await import('../server/utils/messageNormalizer.ts')
const claudeCheck = async (startedBy, opts) => (await runPreflight({ id: 'r', startedBy }, [], fetch, opts)).checks.find(c => c.name === 'Claude credential')
const launched = async (login) => launchEnv({ ...process.env }, await envForUser(login))

try {
  assert.equal(anthropicKindOf('sk-ant-oat01-abc'), 'oauth')
  assert.equal(anthropicKindOf('sk-ant-api03-abc'), 'apikey')
  assert.equal(anthropicKindOf('hunter2'), null)

  // A subscription token replaces BOTH instance credentials: an instance API
  // key left beside it would win, and bill the instance.
  await saveProfile('alice', { anthropicTokenPlain: 'sk-ant-oat01-ALICE' })
  const a = await launched('alice')
  assert.equal(a.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-ALICE')
  assert.ok(!('ANTHROPIC_API_KEY' in a), 'the instance API key is unset, not merely blank')
  assert.equal(claudeCredentialProblem(a, 'alice'), null)

  // An API key the same way round.
  await saveProfile('carol', { anthropicTokenPlain: 'sk-ant-api03-CAROL' })
  const c = await launched('carol')
  assert.equal(c.ANTHROPIC_API_KEY, 'sk-ant-api03-CAROL')
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in c))

  // Stored sealed, and never sent to the browser.
  const raw = readFileSync(join(dir, 'alice.json'), 'utf8')
  assert.ok(!raw.includes('ALICE'), 'the token is encrypted at rest')
  const pub = toPublic(await getProfile('alice'))
  assert.equal(pub.hasAnthropicToken, true)
  assert.equal(pub.anthropicKind, 'oauth')
  assert.ok(!('anthropicToken' in pub))

  // No credential of one's own: nothing of the instance's remains, and the
  // refusal names who must add one. Same for a profile-less login and nobody.
  await saveProfile('bob', { jiraEmail: 'bob@example.com' })
  for (const login of ['bob', 'dave', undefined]) {
    const env = await launched(login)
    for (const v of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) assert.ok(!(v in env), `${v} withheld from ${login ?? 'nobody'}`)
    const problem = claudeCredentialProblem(env, login)
    assert.ok(problem, `${login ?? 'nobody'} is refused`)
    if (login) assert.match(problem, new RegExp(`@${login}`))
  }

  // Clearing the credential clears it, and the kind with it.
  await saveProfile('alice', { anthropicTokenPlain: '' })
  assert.equal((await getProfile('alice')).anthropicToken, undefined)
  assert.equal((await getProfile('alice')).anthropicKind, undefined)
  assert.ok(claudeCredentialProblem(await launched('alice'), 'alice'))

  // Preflight refuses the run before any step, naming who must add one; it
  // passes the developer who has one; and a stubbed runner is not asked.
  const refused = await claudeCheck('alice')
  assert.equal(refused.level, 'fail')
  assert.match(refused.detail, /@alice/)
  assert.match(preflightFailure({ checks: [refused] }), /Claude credential/)
  const passed = await claudeCheck('carol')
  assert.equal(passed.level, 'ok')
  assert.match(passed.detail, /@carol's API key/)
  assert.equal((await claudeCheck('alice', { launchesAgents: false })).level, 'skip')

  // A credential the API rejects is said out loud in the chat, not swallowed:
  // the SDK reports it as a synthetic assistant message, which used to vanish.
  const [rejected] = normalizeSDKMessage({
    type: 'assistant', error: 'authentication_failed',
    message: { content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }] },
  }, 's')
  assert.equal(rejected?.kind, 'error')
  assert.match(rejected.content, /401 OAuth access token is invalid.*Profile page/)
  assert.deepEqual(normalizeSDKMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, 's'), [], 'an ordinary assistant message still adds nothing')

  // Something that is not a Claude credential is not stored as one.
  await assert.rejects(saveProfile('erin', { anthropicTokenPlain: 'hunter2' }), /Not a Claude credential/)

  // Local mode: one person, their own host, whose login stands.
  process.env.AUTH_DISABLED = '1'
  const local = await launched('local')
  assert.equal(local.ANTHROPIC_API_KEY, 'sk-ant-api03-INSTANCE')
  assert.equal(claudeCredentialProblem({}, 'local'), null)
  delete process.env.AUTH_DISABLED

  console.log('claude credential: per developer, instance withheld, missing refused')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
