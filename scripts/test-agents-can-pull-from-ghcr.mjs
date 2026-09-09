#!/usr/bin/env node
/**
 * Runs could not pull a single product image. The developer's token reached
 * `git` and `gh` — envForUser sets GH_TOKEN and GITHUB_TOKEN — but never the
 * registry, because docker reads credentials from a config file and nothing
 * wrote one. Run d6a07ffd spent sixty turns and fourteen minutes cycling
 * between that and a port collision:
 *
 *   Error response from daemon: unable to retrieve auth token:
 *   invalid username/password: unauthorized
 *
 * The token type was verified against the real registry before this was built:
 * a GitHub OAuth token with read:packages exchanges for a GHCR pull token
 * (200 OK), so no classic PAT is needed.
 *
 * The credential is written as a file rather than handed to the agent to
 * `docker login` with, so it never appears in a command line — an agent's
 * commands land in the step log and in evidence artifacts, and one has already
 * written GITHUB_CLIENT_SECRET into a stack report by running `env`.
 */
import assert from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'ghcr-'))
process.env.AGENT_MANAGER_SECRET = 'test-secret-at-least-32-characters-long'
const { saveProfile, envForUser } = await import('../server/utils/users.ts')

const LOGIN = 'someone-alepo'
const TOKEN = 'gho_pretend_token_value_0123456789'
const okFetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) })

let failures = 0
// Awaited. Two of these checks are async, and a synchronous helper would run
// their assertions detached — the check could never fail, which is worse than
// not having it.
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`) }
}

await saveProfile(LOGIN, { githubTokenPlain: TOKEN })
const env = await envForUser(LOGIN, okFetch)

await check('DOCKER_CONFIG is handed to the run', () => {
  assert.ok(env.DOCKER_CONFIG, 'without it docker never looks at the credential we wrote')
  assert.ok(existsSync(join(env.DOCKER_CONFIG, 'config.json')), 'DOCKER_CONFIG must point at a directory containing config.json — docker reads the directory, not the file')
})

await check('it authenticates to ghcr.io with this developer\'s token', () => {
  const cfg = JSON.parse(readFileSync(join(env.DOCKER_CONFIG, 'config.json'), 'utf8'))
  assert.ok(cfg.auths['ghcr.io'], 'the registry the deployment repo pulls product images from')
  const [user, tok] = Buffer.from(cfg.auths['ghcr.io'].auth, 'base64').toString('utf8').split(':')
  assert.equal(user, LOGIN, 'per developer, so pulls stay attributable on a shared instance')
  assert.equal(tok, TOKEN, 'the same token GH_TOKEN carries — not a second credential to keep in step')
})

await check('the credential file is not world-readable', () => {
  const mode = statSync(join(env.DOCKER_CONFIG, 'config.json')).mode & 0o777
  assert.equal(mode, 0o600, `docker's format is base64, not encryption, so the file permission is the only protection (got ${mode.toString(8)})`)
})

await check('it lives with the profile, never in run artifacts', () => {
  assert.ok(env.DOCKER_CONFIG.startsWith(process.env.AGENT_USERS_DIR),
    'a run artifacts directory is kept as evidence and travels into pull request bodies')
})

// A token GitHub has already rejected must not become a registry credential:
// that turns a clear "your token is dead" into a confusing registry 401.
await check('a rejected token writes no credential', async () => {
  const dead = 'someone-else'
  await saveProfile(dead, { githubTokenPlain: 'gho_dead' })
  const badFetch = async () => ({ ok: false, status: 401, headers: { get: () => null } })
  const e2 = await envForUser(dead, badFetch)
  assert.ok(!e2.DOCKER_CONFIG, 'no DOCKER_CONFIG when the token is known bad')
  assert.ok(!e2.GH_TOKEN, 'and no GH_TOKEN either — the existing behaviour is unchanged')
})

await check('clearing the token removes the credential file', async () => {
  const dir = env.DOCKER_CONFIG
  assert.ok(existsSync(dir), 'precondition')
  await saveProfile(LOGIN, { githubTokenPlain: '' })
  assert.ok(!existsSync(dir), 'a credential file outliving its credential hands a revoked value to the next run')
})

rmSync(process.env.AGENT_USERS_DIR, { recursive: true, force: true })
console.log(failures === 0 ? '\nagents can pull from ghcr: all checks passed' : `\nagents can pull from ghcr: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
