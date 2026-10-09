/**
 * Which GitHub account a run's agents will push and open pull requests as.
 *
 * Preflight used to answer this from the starter's profile and AGENT_GH_TOKEN
 * alone, and warned "you have no GitHub token" to everyone without either. But
 * a run with neither falls back to the host's own `gh` login (see envForUser),
 * and on an instance whose operator signed `gh` in, every such run opened its
 * pull request fine: the warning was false for exactly the developers who sign
 * in with a password. So `gh` is asked, in the environment the agents get -
 * built by launchEnv, the one function callAgent builds it with, so the
 * account named here is the account the pull request is opened as.
 *
 * The answer names the account, never the token.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { agentEnvFor, launchEnv } from './agentCaller.ts'
import { envForUser, getProfile } from './users.ts'

const execFileP = promisify(execFile)

export type GithubVia = 'profile' | 'instance' | 'host'
export interface GithubSource { ok: boolean, via: GithubVia | null, login: string | null }

/** The login `gh` resolves in `env`, or null when it is not signed in or not installed. */
export type GhAsker = (env: Record<string, string>) => Promise<string | null>

const askGh: GhAsker = async (env) => {
  try {
    const { stdout } = await execFileP('gh', ['api', 'user', '-q', '.login'], { env, timeout: 8_000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

const FOUND_MS = 5 * 60 * 1000
const MISSED_MS = 60 * 1000
const cache = new Map<string, { at: number, source: GithubSource }>()

/**
 * Which stored credential the answer is for. A developer whose token was
 * rejected falls back to the host; once they sign in with GitHub again the new
 * token reaches their runs at once, and an answer cached by login alone named
 * the host for five more minutes. Keyed by a digest of the stored token, so a
 * saved credential is a new key.
 */
async function credentialRevision(login: string | undefined): Promise<string> {
  if (!login) return ''
  const stored = (await getProfile(login))?.githubToken ?? ''
  return stored ? createHash('sha256').update(stored).digest('hex').slice(0, 16) : ''
}

export async function githubSourceFor(
  login: string | undefined,
  opts: {
    /** The starter's credentials as the runner resolves them; envForUser by default. */
    userEnv?: Record<string, string>
    /** The shared base; agentEnvFor() by default. */
    baseEnv?: Record<string, string>
    /** Stands in for the stored-credential revision; read from the profile by default. */
    revision?: string
    ask?: GhAsker
    now?: number
  } = {},
): Promise<GithubSource> {
  const now = opts.now ?? Date.now()
  const key = `${login ?? ''}\0${opts.revision ?? await credentialRevision(login)}`
  const hit = cache.get(key)
  if (hit && now - hit.at < (hit.source.ok ? FOUND_MS : MISSED_MS)) return hit.source

  const userEnv = opts.userEnv ?? await envForUser(login).catch(() => ({} as Record<string, string>))
  const env = launchEnv(opts.baseEnv ?? await agentEnvFor(), userEnv)
  // In launchEnv's order: a profile token envForUser accepted, then the
  // instance token, then whatever the host's gh holds.
  const via: GithubVia = userEnv.GH_TOKEN ? 'profile' : process.env.AGENT_GH_TOKEN ? 'instance' : 'host'
  const found = await (opts.ask ?? askGh)(env)
  const source: GithubSource = found
    ? { ok: true, via, login: found }
    // gh could not say: a token in the run's environment may still work (no gh
    // on this host), so say so without a name rather than warn falsely.
    : env.GH_TOKEN || env.GITHUB_TOKEN ? { ok: true, via, login: null } : { ok: false, via: null, login: null }
  cache.set(key, { at: now, source })
  return source
}

/** For tests. */
export function _resetGithubSources() { cache.clear() }
