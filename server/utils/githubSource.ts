/**
 * Which GitHub account a run's agents will push and open pull requests as.
 *
 * Preflight used to answer this from the starter's profile and AGENT_GH_TOKEN
 * alone, and warned "you have no GitHub token" to everyone without either. But
 * a run with neither falls back to the host's own `gh` login (see envForUser),
 * and on an instance whose operator signed `gh` in, every such run opened its
 * pull request fine: the warning was false for exactly the developers who sign
 * in with a password. So `gh` is asked, in the environment the agents get.
 *
 * The answer names the account, never the token.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { agentEnvFor } from './agentCaller.ts'

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

export async function githubSourceFor(
  login: string | undefined,
  opts: { hasProfileToken?: boolean, env?: Record<string, string>, ask?: GhAsker, now?: number } = {},
): Promise<GithubSource> {
  const now = opts.now ?? Date.now()
  const key = login ?? ''
  const hit = cache.get(key)
  if (hit && now - hit.at < (hit.source.ok ? FOUND_MS : MISSED_MS)) return hit.source

  const env = opts.env ?? await agentEnvFor(login)
  // AGENT_GH_TOKEN is spread last in agentEnvFor, so it wins over a profile
  // token; a profile token reaches GH_TOKEN only when GitHub accepted it.
  const via: GithubVia = process.env.AGENT_GH_TOKEN
    ? 'instance'
    : opts.hasProfileToken && env.GH_TOKEN && env.GH_TOKEN !== process.env.GH_TOKEN ? 'profile' : 'host'
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
