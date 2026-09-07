import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import { envForUser } from './users.ts'

const execFileP = promisify(execFile)

/**
 * "Promote to team": copy an agent, skill or command from this instance's
 * config directory into the alepo-engineering plugin source and open a pull
 * request for it, as the developer who asked. The plugin is the team's source
 * of truth, so a promotion is a PR, never a direct write to anyone's config.
 */
export type PromoteKind = 'agent' | 'skill' | 'command'

export class PromoteError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode }
}

const REPO = () => process.env.TEAM_REPO || 'alepolab/agent-manager'
const repoUrl = () => process.env.TEAM_REPO_URL || `https://github.com/${REPO()}.git`
const checkoutDir = () => join(process.env.AGENT_WORKSPACE_ROOT || join(homedir(), 'alepo-workspace'), 'agent-manager')

export type PrOpener = (opts: { token: string, head: string, title: string, body: string }) => Promise<string>
let openPr: PrOpener = async ({ token, head, title, body }) => {
  const res = await fetch(`https://api.github.com/repos/${REPO()}/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-manager', 'content-type': 'application/json' },
    body: JSON.stringify({ title, body, head, base: 'main' }),
  })
  if (!res.ok) throw new PromoteError(502, `GitHub refused the pull request (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`)
  return ((await res.json()) as { html_url: string }).html_url
}
/** Test seam. */
export function setPrOpener(fn: PrOpener) { openPr = fn }

const SLUG = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/

/** Where a kind lives on this instance, and where it belongs in the plugin. */
function locate(kind: PromoteKind, slug: string): { from: string, to: string } {
  if (!SLUG.test(slug)) throw new PromoteError(400, 'invalid slug')
  if (kind === 'agent') return { from: resolveClaudePath('agents', `${slug}.md`), to: join('engineering', 'agents', `${slug}.md`) }
  if (kind === 'command') return { from: resolveClaudePath('commands', `${slug}.md`), to: join('engineering', 'commands', `${slug}.md`) }
  if (kind === 'skill') return { from: resolveClaudePath('skills', slug), to: join('engineering', 'skills', slug) }
  throw new PromoteError(400, 'kind must be agent, skill or command')
}

// ponytail: one promotion at a time; a per-checkout lock if two developers ever race
let busy = false

export async function promoteToTeam(kind: PromoteKind, slug: string, login: string): Promise<{ branch: string, pr: string, path: string }> {
  if (busy) throw new PromoteError(409, 'Another promotion is in progress; try again in a moment')
  busy = true
  try {
    const { from, to } = locate(kind, slug)
    if (!existsSync(from)) throw new PromoteError(404, `${kind} "${slug}" is not on this instance`)
    const env = await envForUser(login).catch(() => ({} as Record<string, string>))
    const token = env.GITHUB_TOKEN || process.env.AGENT_GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (!token) throw new PromoteError(400, 'No GitHub token: sign in with GitHub, or set AGENT_GH_TOKEN on the instance')

    const dir = checkoutDir()
    // The image's git credential helper reads GITHUB_TOKEN, so the push and
    // the PR both happen as the developer, never as the server.
    const gitEnv = { ...process.env, GITHUB_TOKEN: token, GIT_TERMINAL_PROMPT: '0' }
    const git = async (args: string[], cwd = dir) => (await execFileP('git', args, { cwd, env: gitEnv, maxBuffer: 8 * 1024 * 1024 })).stdout
    if (!existsSync(join(dir, '.git'))) {
      await mkdir(dirname(dir), { recursive: true })
      await execFileP('git', ['clone', '--quiet', repoUrl(), dir], { env: gitEnv })
    }
    await git(['fetch', '--quiet', 'origin', 'main'])
    const branch = `promote/${kind}-${slug.replace(/\//g, '-')}-${Date.now().toString(36)}`
    await git(['checkout', '--quiet', '-B', branch, 'origin/main'])
    const dest = join(dir, to)
    await mkdir(dirname(dest), { recursive: true })
    await cp(from, dest, { recursive: true, force: true })
    await git(['add', '--all', '--', to])
    if (!(await git(['status', '--porcelain', '--', to])).trim()) {
      await git(['checkout', '--quiet', 'origin/main'])
      throw new PromoteError(409, `"${slug}" already matches the team version`)
    }
    const title = `feat(plugin): promote ${kind} ${slug} to the team`
    await git(['-c', `user.name=${login}`, '-c', `user.email=${login}@users.noreply.github.com`, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', title])
    await git(['push', '--quiet', '-u', 'origin', branch])
    const pr = await openPr({ token, head: branch, title, body: `Promoted from Agent Manager by @${login}.\n\nFile: \`${to}\`. Once merged, reinstall the plugin and apply team standards on the Team page.` })
    return { branch, pr, path: to }
  } finally {
    busy = false
  }
}
