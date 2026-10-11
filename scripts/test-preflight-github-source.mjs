/**
 * The start box says whose GitHub account a run will use, and warns only when
 * none reaches it. It used to warn "you have no GitHub token" to anyone without
 * a profile token, although such runs fall back to this host's own `gh` login
 * and open their pull requests fine - 76 of them on the live instance.
 *
 * The account named must be the one the pull request is opened as: preflight
 * builds the agents' environment through launchEnv, the function callAgent
 * builds it with, and a saved credential is never answered from the cache.
 *
 *   node scripts/test-preflight-github-source.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'gh-source-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'gh-source-runs-'))
process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'gh-source-users-'))
process.env.AGENT_MANAGER_SECRET = 'x'.repeat(40)
delete process.env.AGENT_GH_TOKEN
delete process.env.GH_TOKEN
delete process.env.GITHUB_TOKEN

const { githubSourceFor, _resetGithubSources } = await import('../server/utils/githubSource.ts')
const { launchEnv } = await import('../server/utils/agentCaller.ts')
const { saveProfile } = await import('../server/utils/users.ts')

// gh answers with whichever account owns the token it is given; none means the host login.
const ACCOUNTS = { 'profile-token': 'dev-gh', 'bot-token': 'alepo-bot', 'new-token': 'dev-gh-new' }
const asked = []
const gh = hostLogin => async (env) => { asked.push(env); return env.GH_TOKEN ? (ACCOUNTS[env.GH_TOKEN] ?? null) : hostLogin }

// ── the host's gh login, no token anywhere: THE CASE that warned falsely ──
_resetGithubSources()
let s = await githubSourceFor('arisht', { baseEnv: {}, userEnv: {}, revision: '', ask: gh('arishtjain-alepo') })
assert.deepEqual(s, { ok: true, via: 'host', login: 'arishtjain-alepo' }, 'THE REGRESSION: a run that pushes as the host login was said to have no GitHub')

// ── the starter's own profile token, accepted by GitHub ──
_resetGithubSources()
s = await githubSourceFor('dev', { baseEnv: {}, userEnv: { GH_TOKEN: 'profile-token' }, revision: 'r1', ask: gh('arishtjain-alepo') })
assert.deepEqual(s, { ok: true, via: 'profile', login: 'dev-gh' })
assert.equal(asked.at(-1).GH_TOKEN, 'profile-token', 'gh is asked in the environment the agents get')

// ── a profile token GitHub rejected: envForUser left GH_TOKEN unset, so it is the host ──
_resetGithubSources()
s = await githubSourceFor('dev', { baseEnv: {}, userEnv: {}, revision: 'r1', ask: gh('arishtjain-alepo') })
assert.equal(s.via, 'host', 'a rejected profile token is not the account a run uses')

// ── the instance token alone ──
_resetGithubSources()
process.env.AGENT_GH_TOKEN = 'bot-token'
s = await githubSourceFor('dev', { baseEnv: { GH_TOKEN: 'bot-token' }, userEnv: {}, revision: '', ask: gh('arishtjain-alepo') })
assert.deepEqual(s, { ok: true, via: 'instance', login: 'alepo-bot' })

// ── BOTH a profile token and AGENT_GH_TOKEN: the launch spreads the starter's
// credentials last, so the pull request goes out as the developer, and that is
// who preflight must name. It used to name the bot.
_resetGithubSources()
const base = { GH_TOKEN: 'bot-token', GITHUB_TOKEN: 'bot-token' }
const user = { GH_TOKEN: 'profile-token', GITHUB_TOKEN: 'profile-token' }
assert.equal(launchEnv(base, user).GH_TOKEN, 'profile-token', 'the launch environment: the starter over the base')
s = await githubSourceFor('dev', { baseEnv: base, userEnv: user, revision: 'r1', ask: gh('arishtjain-alepo') })
assert.deepEqual(s, { ok: true, via: 'profile', login: 'dev-gh' }, 'THE MISMATCH: preflight named a different account from the PR author')
assert.equal(asked.at(-1).GH_TOKEN, launchEnv(base, user).GH_TOKEN, 'gh was asked with the token the agents get')
delete process.env.AGENT_GH_TOKEN

// callAgent builds its environment through the same function, so the two cannot drift.
const caller = readFileSync(new URL('../server/utils/agentCaller.ts', import.meta.url), 'utf8')
assert.match(caller, /\n {6}env: \{ \.\.\.launchEnv\(await agentEnvFor\(\), userEnv\) \},/, 'callAgent builds the env with launchEnv')

// ── gh missing or signed out, but a token is in the run's environment: no false warning, no name ──
_resetGithubSources()
s = await githubSourceFor('dev', { baseEnv: { GITHUB_TOKEN: 'x' }, userEnv: {}, revision: '', ask: async () => null })
assert.deepEqual(s, { ok: true, via: 'host', login: null })

// ── nothing at all: the warning is right ──
_resetGithubSources()
s = await githubSourceFor('nobody', { baseEnv: {}, userEnv: {}, revision: '', ask: async () => null })
assert.deepEqual(s, { ok: false, via: null, login: null })

// ── cached: the preflight runs on every keystroke pause ──
_resetGithubSources()
asked.length = 0
const host = { baseEnv: {}, userEnv: {}, revision: '', ask: gh('arishtjain-alepo') }
await githubSourceFor('arisht', { ...host, now: 1000 })
await githubSourceFor('arisht', { ...host, now: 1000 + 4 * 60 * 1000 })
assert.equal(asked.length, 1, 'asked once within five minutes')
await githubSourceFor('arisht', { ...host, now: 1000 + 6 * 60 * 1000 })
assert.equal(asked.length, 2, 'and again after')

// ── a saved credential is never answered from the cache: re-signing in with
// GitHub replaces a rejected token, and the very next preflight names the new
// account rather than the host for five more minutes. The revision is read from
// the real stored profile here.
_resetGithubSources()
await saveProfile('dev2', { githubTokenPlain: 'old-token' })
s = await githubSourceFor('dev2', { baseEnv: {}, userEnv: {}, ask: gh('arishtjain-alepo'), now: 5000 })
assert.equal(s.login, 'arishtjain-alepo', 'the rejected token falls back to the host')
await saveProfile('dev2', { githubTokenPlain: 'new-token' })
s = await githubSourceFor('dev2', { baseEnv: {}, userEnv: { GH_TOKEN: 'new-token' }, ask: gh('arishtjain-alepo'), now: 5000 + 60 * 1000 })
assert.deepEqual(s, { ok: true, via: 'profile', login: 'dev-gh-new' }, 'THE STALE NAME: a new GitHub sign-in was answered from the cache')

// ── the answer never carries the token ──
_resetGithubSources()
s = await githubSourceFor('dev', { baseEnv: {}, userEnv: { GH_TOKEN: 'secret-token-value' }, revision: 'r9', ask: async () => 'dev-gh' })
assert.ok(!JSON.stringify(s).includes('secret-token-value'))

console.log('ok - preflight names the GitHub account a run uses, and warns only when none reaches it')
