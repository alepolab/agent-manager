import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Per-developer profiles for a shared instance: the GitHub token from login
 * and the Jira credentials entered on the profile page, so a run started by a
 * developer pushes, comments and reads tickets as that developer. Tokens are
 * encrypted at rest with a key derived from AGENT_MANAGER_SECRET; the files
 * live outside the team's ~/.claude so nothing in the config tree holds a
 * secret.
 */
export interface UserProfile {
  login: string
  /** GitHub's numeric account id, captured at sign-in. It is what makes the
   *  noreply address resolve to this account rather than to nobody. */
  githubId?: number
  name?: string
  avatar?: string
  jiraEmail?: string
  /** Encrypted; never returned to the browser. */
  jiraToken?: string
  /** Encrypted; refreshed on every login. */
  githubToken?: string
  updatedAt: number
}

export type PublicProfile = Omit<UserProfile, 'jiraToken' | 'githubToken'> & { hasJiraToken: boolean, hasGithubToken: boolean }

const usersDir = () => process.env.AGENT_USERS_DIR || join(homedir(), '.agent-manager', 'users')
const profilePath = (login: string) => join(usersDir(), `${safe(login)}.json`)
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_')

function key(): Buffer {
  const secret = process.env.AGENT_MANAGER_SECRET
  if (!secret) throw new Error('AGENT_MANAGER_SECRET is not set; it is required to store credentials')
  return createHash('sha256').update(secret).digest()
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, data] = sealed.split(':')
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised sealed value')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}

export async function getProfile(login: string): Promise<UserProfile | null> {
  const p = profilePath(login)
  if (!existsSync(p)) return null
  try { return JSON.parse(await readFile(p, 'utf8')) as UserProfile } catch { return null }
}

export function toPublic(p: UserProfile): PublicProfile {
  const { jiraToken, githubToken, ...rest } = p
  return { ...rest, hasJiraToken: !!jiraToken, hasGithubToken: !!githubToken }
}

/** Merge a patch into the profile. Plain-text token fields are encrypted here, once. */
export async function saveProfile(login: string, patch: Partial<UserProfile> & { jiraTokenPlain?: string, githubTokenPlain?: string }): Promise<UserProfile> {
  await mkdir(usersDir(), { recursive: true })
  const { jiraTokenPlain, githubTokenPlain, ...rest } = patch
  const current = (await getProfile(login)) ?? { login, updatedAt: 0 }
  const next: UserProfile = { ...current, ...rest, login, updatedAt: Date.now() }
  if (jiraTokenPlain !== undefined) next.jiraToken = jiraTokenPlain ? encrypt(jiraTokenPlain) : undefined
  if (githubTokenPlain !== undefined) next.githubToken = githubTokenPlain ? encrypt(githubTokenPlain) : undefined
  const p = profilePath(login)
  const tmp = `${p}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  await rename(tmp, p)
  return next
}

/**
 * The environment a run started by this user should run its agents with:
 * GitHub and Jira identities, plus a per-user jira-cli config so `jira`
 * authenticates as them. Missing pieces are simply absent; the run then falls
 * back to whatever the host holds, and the profile page says what to add.
 */
/**
 * The identity a run's commits are authored with.
 *
 * The container has no git identity of its own, so git used whatever it could
 * find: a run committed as `Claude Code <claude-code@anthropic.com>`, and the
 * pull request on the target repository rendered a COLLEAGUE's name and avatar.
 * GitHub attributes a commit by matching its author email to an account, and
 * that address is registered to theirs. Nobody did anything — the identity was
 * simply never set, and the default landed on a real person.
 *
 * So it is set explicitly, to the GitHub Actions bot. The choice is deliberate:
 *
 * - It is unmistakably not a person. A pipeline commit should not wear a
 *   developer's face in a repository's history, and the starter is already
 *   recorded on the run, in the PR body's provenance section, and in the
 *   branch it pushed.
 * - The address is GitHub's own, published for exactly this, and resolves to
 *   the bot rather than to anybody's inbox.
 * - It cannot silently become a person again the way an unset identity did.
 *
 * Overridable per deployment: an operator who wants a different bot sets
 * GIT_BOT_NAME and GIT_BOT_EMAIL rather than editing this.
 */
const ACTIONS_BOT_NAME = 'github-actions[bot]'
const ACTIONS_BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'

/**
 * The identity a run's commits are authored with: the developer who signed in
 * and started the run, falling back to the GitHub Actions bot when there is no
 * signed-in developer to attribute to.
 *
 * The container has no git identity of its own, so git used whatever it could
 * find. A run committed as `Claude Code <claude-code@anthropic.com>` and the
 * pull request rendered a COLLEAGUE's name and avatar — GitHub attributes a
 * commit by matching its author email to an account, and that address is
 * registered to theirs. Nobody did anything; the identity was never set, and
 * the default landed on a real person.
 *
 * The noreply form is deliberate. It is the address GitHub issues for exactly
 * this, it resolves to the right account, and it publishes no private address
 * into a repository's history. A profile saved before githubId was captured
 * falls back to the login-only form, which GitHub still resolves for accounts
 * that have not disabled it.
 *
 * The bot is the floor, not the norm: an anonymous run — auth disabled, or a
 * watch dispatch with no starter — has nobody to attribute to, and must still
 * not be left guessing. GIT_BOT_NAME and GIT_BOT_EMAIL override that floor for
 * a deployment with its own bot.
 */
export function gitIdentity(profile?: Pick<UserProfile, 'login' | 'name' | 'githubId'>): Record<string, string> {
  const name = profile
    ? (profile.name?.trim() || profile.login)
    : (process.env.GIT_BOT_NAME?.trim() || ACTIONS_BOT_NAME)
  const email = profile
    ? (profile.githubId
        ? `${profile.githubId}+${profile.login}@users.noreply.github.com`
        : `${profile.login}@users.noreply.github.com`)
    : (process.env.GIT_BOT_EMAIL?.trim() || ACTIONS_BOT_EMAIL)
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  }
}

export async function envForUser(login: string | undefined): Promise<Record<string, string>> {
  // The commit identity first, and unconditionally. An anonymous run — auth
  // disabled, or a watch dispatch with no starter — still commits, and these
  // early returns were exactly the path that left git to pick an identity for
  // itself and land it on a real person's account.
  // The commit identity is set on every path, including the ones that return
  // early: an anonymous run still commits, and these returns were exactly where
  // git was left to invent an identity for itself.
  if (!login) return { ...gitIdentity() }
  const p = await getProfile(login)
  if (!p) return { ...gitIdentity() }
  const env: Record<string, string> = { ...gitIdentity(p) }
  if (p.githubToken) {
    const t = decrypt(p.githubToken)
    env.GH_TOKEN = t
    env.GITHUB_TOKEN = t
  }
  if (p.jiraToken && p.jiraEmail) {
    env.JIRA_API_TOKEN = decrypt(p.jiraToken)
    env.JIRA_EMAIL = p.jiraEmail
    env.JIRA_BASE_URL = jiraBaseUrl()
    env.JIRA_CONFIG_FILE = await jiraConfigFor(p)
  }
  return env
}

/** A jira-cli config naming this user's login; the token travels in JIRA_API_TOKEN. */
const jiraBaseUrl = () => (process.env.JIRA_BASE_URL || process.env.JIRA_SERVER || 'https://alepo.atlassian.net').replace(/\/+$/, '')

async function jiraConfigFor(p: UserProfile): Promise<string> {
  const server = jiraBaseUrl()
  const path = join(usersDir(), `${safe(p.login)}.jira.yml`)
  const body = [
    `installation: cloud`,
    `server: ${server}`,
    `login: ${p.jiraEmail}`,
    `auth_type: basic`,
    ...(process.env.JIRA_DEFAULT_PROJECT ? [`project:`, `    key: ${process.env.JIRA_DEFAULT_PROJECT}`] : []),
    '',
  ].join('\n')
  await mkdir(usersDir(), { recursive: true })
  await writeFile(path, body, { mode: 0o600 })
  return path
}
