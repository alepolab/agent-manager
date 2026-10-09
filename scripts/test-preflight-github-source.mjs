/**
 * The start box says whose GitHub account a run will use, and warns only when
 * none reaches it. It used to warn "you have no GitHub token" to anyone without
 * a profile token, although such runs fall back to this host's own `gh` login
 * and open their pull requests fine - 76 of them on the live instance.
 *
 *   node scripts/test-preflight-github-source.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'gh-source-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'gh-source-runs-'))
delete process.env.AGENT_GH_TOKEN
delete process.env.GH_TOKEN
delete process.env.GITHUB_TOKEN

const { githubSourceFor, _resetGithubSources } = await import('../server/utils/githubSource.ts')

const asked = []
const gh = login => async (env) => { asked.push(env); return login }

// ── the host's gh login, no token anywhere: THE CASE that warned falsely ──
_resetGithubSources()
let s = await githubSourceFor('arisht', { env: {}, ask: gh('arishtjain-alepo') })
assert.deepEqual(s, { ok: true, via: 'host', login: 'arishtjain-alepo' }, 'THE REGRESSION: a run that pushes as the host login was said to have no GitHub')

// ── the starter's own profile token, accepted by GitHub ──
_resetGithubSources()
s = await githubSourceFor('dev', { hasProfileToken: true, env: { GH_TOKEN: 'profile-token' }, ask: gh('dev-gh') })
assert.deepEqual(s, { ok: true, via: 'profile', login: 'dev-gh' })
assert.equal(asked.at(-1).GH_TOKEN, 'profile-token', 'gh is asked in the environment the agents get')

// ── a profile token GitHub rejected: envForUser left GH_TOKEN unset, so it is the host ──
_resetGithubSources()
s = await githubSourceFor('dev', { hasProfileToken: true, env: {}, ask: gh('arishtjain-alepo') })
assert.equal(s.via, 'host', 'a rejected profile token is not the account a run uses')

// ── the instance token wins, as agentEnvFor spreads it last ──
_resetGithubSources()
process.env.AGENT_GH_TOKEN = 'bot-token'
s = await githubSourceFor('dev', { hasProfileToken: true, env: { GH_TOKEN: 'bot-token' }, ask: gh('alepo-bot') })
assert.deepEqual(s, { ok: true, via: 'instance', login: 'alepo-bot' })
delete process.env.AGENT_GH_TOKEN

// ── gh missing or signed out, but a token is in the run's environment: no false warning, no name ──
_resetGithubSources()
s = await githubSourceFor('dev', { env: { GITHUB_TOKEN: 'x' }, ask: gh(null) })
assert.deepEqual(s, { ok: true, via: 'host', login: null })

// ── nothing at all: the warning is right ──
_resetGithubSources()
s = await githubSourceFor('nobody', { env: {}, ask: gh(null) })
assert.deepEqual(s, { ok: false, via: null, login: null })

// ── cached: the preflight runs on every keystroke pause ──
_resetGithubSources()
asked.length = 0
await githubSourceFor('arisht', { env: {}, ask: gh('arishtjain-alepo'), now: 1000 })
await githubSourceFor('arisht', { env: {}, ask: gh('arishtjain-alepo'), now: 1000 + 4 * 60 * 1000 })
assert.equal(asked.length, 1, 'asked once within five minutes')
await githubSourceFor('arisht', { env: {}, ask: gh('arishtjain-alepo'), now: 1000 + 6 * 60 * 1000 })
assert.equal(asked.length, 2, 'and again after')

// ── the answer never carries the token ──
_resetGithubSources()
s = await githubSourceFor('dev', { hasProfileToken: true, env: { GH_TOKEN: 'secret-token-value' }, ask: gh('dev-gh') })
assert.ok(!JSON.stringify(s).includes('secret-token-value'))

console.log('ok - preflight names the GitHub account a run uses, and warns only when none reaches it')
