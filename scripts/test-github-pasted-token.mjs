/**
 * A GitHub token pasted on the Profile page: checked with GitHub before it is
 * stored, used for the person's runs, and kept when they sign in again.
 *
 *   node scripts/test-github-pasted-token.mjs
 *
 * GitHub is a stand-in fetch here; the server asks the same endpoint.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'gh-pasted-'))
process.env.AGENT_USERS_DIR = dir
process.env.AGENT_MANAGER_SECRET = 's'.repeat(40)
delete process.env.AGENT_GH_TOKEN
delete process.env.AUTH_DISABLED

const u = await import('../server/utils/users.ts')

const ACCOUNTS = { 'good-octocat': { login: 'octocat', id: 583231 }, 'good-alice': { login: 'alice', id: 1001 }, 'oauth-alice': { login: 'alice', id: 1001 } }
const github = async (url, { headers }) => {
  const token = headers.Authorization.replace('Bearer ', '')
  if (token === 'unreachable') throw new Error('getaddrinfo ENOTFOUND api.github.com')
  const who = ACCOUNTS[token]
  return who ? new Response(JSON.stringify(who), { status: 200 }) : new Response('{}', { status: 401 })
}

try {
  // ── a password account pastes a token: GitHub is asked whose it is ──
  const p = await u.savePastedGithubToken('tester', '  good-octocat \n', github)
  assert.equal(p.githubTokenSource, 'pasted')
  assert.equal(p.githubLogin, 'octocat', 'the account the token acts as, not the login here')
  assert.equal(p.githubId, 583231)
  assert.ok(!readFileSync(join(dir, 'tester.json'), 'utf8').includes('good-octocat'), 'stored encrypted')
  const env = await u.envForUser('tester', github)
  assert.equal(env.GH_TOKEN, 'good-octocat', 'whitespace from the paste taken out, and the token reaches the run')
  assert.equal(env.GIT_AUTHOR_EMAIL, '583231+octocat@users.noreply.github.com', 'commits attributed to the token\'s account')
  const docker = JSON.parse(readFileSync(join(env.DOCKER_CONFIG, 'config.json'), 'utf8'))
  assert.equal(Buffer.from(docker.auths['ghcr.io'].auth, 'base64').toString(), 'octocat:good-octocat', 'the registry user is the token\'s account')
  const pub = u.toPublic(p)
  assert.equal(pub.githubLogin, 'octocat')
  assert.ok(!('githubToken' in pub), 'never sent to the browser')

  // ── refusals store nothing ──
  await assert.rejects(u.savePastedGithubToken('tester', 'revoked', github), /GitHub rejected this token/)
  await assert.rejects(u.savePastedGithubToken('tester', 'unreachable', github), /Could not reach GitHub/)
  assert.equal((await u.envForUser('tester', github)).GH_TOKEN, 'good-octocat', 'a refused token left the stored one in place')

  // ── a GitHub user pastes their own; signing in again keeps it ──
  await u.saveProfile('alice', { name: 'Alice', githubId: 1001, githubTokenPlain: 'oauth-alice', fromSignIn: true })
  assert.equal((await u.getProfile('alice')).githubTokenSource, 'sign-in')
  await u.savePastedGithubToken('alice', 'good-alice', github)
  await u.saveProfile('alice', { name: 'Alice Smith', githubId: 1001, githubTokenPlain: 'oauth-alice', fromSignIn: true })
  const after = await u.getProfile('alice')
  assert.equal(u.decrypt(after.githubToken), 'good-alice', 'sign-in does not replace a pasted token')
  assert.equal(after.githubTokenSource, 'pasted')
  assert.equal(after.name, 'Alice Smith', 'but name and avatar still refresh')

  // ── removing it: sign-in's token comes back at the next login ──
  await u.removePastedGithubToken('alice')
  const removed = await u.getProfile('alice')
  assert.equal(removed.githubToken, undefined)
  assert.equal(removed.githubTokenSource, undefined)
  assert.equal(removed.githubLogin, 'alice', 'their own account stays theirs')
  assert.equal(removed.githubId, 1001)
  await u.saveProfile('alice', { githubId: 1001, githubTokenPlain: 'oauth-alice', fromSignIn: true })
  assert.equal(u.decrypt((await u.getProfile('alice')).githubToken), 'oauth-alice')

  // A password account's removal takes the other account's identity with it.
  await u.removePastedGithubToken('tester')
  const t = await u.getProfile('tester')
  assert.equal(t.githubLogin, undefined)
  assert.equal(t.githubId, undefined)
  assert.equal((await u.envForUser('tester', github)).GIT_AUTHOR_EMAIL, 'tester@users.noreply.github.com', 'back to the login-only form')

  // ── profiles from before this change behave as before: sign-in refreshes them ──
  await u.saveProfile('legacy', { githubTokenPlain: 'old' })
  await u.saveProfile('legacy', { githubTokenPlain: 'oauth-alice', fromSignIn: true })
  assert.equal(u.decrypt((await u.getProfile('legacy')).githubToken), 'oauth-alice')

  // ── identity-only sign-in: GitHub proves who you are, and grants nothing else ──
  const g = await import('../server/utils/githubSignIn.ts')
  delete process.env.GITHUB_SIGNIN_SCOPE
  assert.match(g.signInScopes(), /\brepo\b/, 'by default sign-in asks for repository access, as before')
  process.env.GITHUB_SIGNIN_SCOPE = 'identity'
  assert.equal(g.signInScopes(), 'read:org read:user user:email', 'identity only: who you are, and org membership')
  assert.doesNotMatch(g.signInScopes(), /repo|packages/)

  // How the callback records it: no token when identity-only (see callback.get.ts).
  const callbackSrc = readFileSync(join(import.meta.dirname, '..', 'server', 'api', 'auth', 'callback.get.ts'), 'utf8')
  assert.match(callbackSrc, /signInIdentityOnly\(\) \? \{\} : \{ githubTokenPlain: token\.access_token \}/, 'the callback stores the token only outside identity mode')
  assert.match(callbackSrc, /fromSignIn: true/, 'and as a sign-in, so a pasted token is kept')
  assert.match(readFileSync(join(import.meta.dirname, '..', 'server', 'api', 'auth', 'login.get.ts'), 'utf8'), /set\('scope', signInScopes\(\)\)/, 'and login asks for exactly these scopes')
  const signIn = (login, token) => u.saveProfile(login, { name: login, githubId: 77, ...(g.signInIdentityOnly() ? {} : { githubTokenPlain: token }), fromSignIn: true })

  await signIn('newbie', 'oauth-broad')
  const fresh = await u.getProfile('newbie')
  assert.equal(fresh.githubToken, undefined, 'the sign-in token is not stored')
  assert.equal(fresh.githubLogin, 'newbie', 'but who they are on GitHub is')
  assert.ok(!('GH_TOKEN' in await u.envForUser('newbie', github)), 'so runs get no token from sign-in')

  // A broad token an earlier sign-in stored is removed at the next one.
  delete process.env.GITHUB_SIGNIN_SCOPE
  await signIn('veteran', 'oauth-alice')
  assert.equal(u.decrypt((await u.getProfile('veteran')).githubToken), 'oauth-alice')
  process.env.GITHUB_SIGNIN_SCOPE = 'identity'
  await signIn('veteran', 'oauth-alice')
  const cleared = await u.getProfile('veteran')
  assert.equal(cleared.githubToken, undefined, "the old sign-in token no longer grants the access this instance stopped asking for")
  assert.equal(cleared.githubTokenSource, undefined)

  // A pasted PAT is theirs: identity sign-in leaves it, and the account it acts as.
  await u.savePastedGithubToken('patuser', 'good-octocat', github)
  await signIn('patuser', 'oauth-broad')
  const kept = await u.getProfile('patuser')
  assert.equal(u.decrypt(kept.githubToken), 'good-octocat', 'a pasted PAT survives identity sign-in')
  assert.equal(kept.githubLogin, 'octocat')
  delete process.env.GITHUB_SIGNIN_SCOPE

  console.log('github pasted token: checked before stored, used by runs, kept across sign-ins, removable')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
