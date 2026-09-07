/**
 * Which directory a run's agents will work in.
 *
 * The run lock exists because two runs editing the same files corrupt each
 * other. It was written as "one run per workflow", which is neither necessary
 * nor sufficient once more than one developer signs in:
 *
 * - Not necessary: two people working on unrelated products share nothing, yet
 *   the second one got a 409 and no queue. A single global lock on the pipeline
 *   makes the tool single-user in practice.
 * - Not sufficient: `projectDir` is unset on every real run, because the
 *   provisioner clones into AGENT_WORKSPACE_ROOT. That root was ONE shared
 *   directory, so two runs of two DIFFERENT workflows would both clone
 *   alepo-dev-team-infra into the same path and stomp each other — a collision
 *   a per-workflow lock cannot see.
 *
 * So the root is now per developer, and the lock is scoped to the directory a
 * run will actually touch. Two people run concurrently; one person still cannot
 * start a second run over their own checkout.
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

/** Login sanitiser, matching users.ts: a login becomes one safe path segment. */
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_')

export const WORKSPACE_ROOT_VAR = 'AGENT_WORKSPACE_ROOT'

/** The configured root all developer workspaces live under, as an absolute path: a `~` here
 *  was handed to existsSync and to agents' Read and Glob, none of which expand it, so a
 *  checkout that existed read as missing and a restart was refused for an "empty directory". */
export function workspaceRoot(): string {
  return (process.env[WORKSPACE_ROOT_VAR] || '~/alepo-workspace').replace(/\/+$/, '').replace(/^~(?=\/|$)/, osHomedir())
}

/**
 * One developer's own checkout area. Anonymous runs (auth disabled, or a watch
 * dispatch with no starter) share the bare root, which is the old behaviour and
 * correct for them: there is no identity to separate them by.
 */
export function workspaceRootFor(login: string | undefined): string {
  const root = workspaceRoot()
  return login ? `${root}/${safe(login)}` : root
}

/**
 * The directory a run will actually write in, and therefore the thing the lock
 * must be taken on. An explicit projectDir wins — the caller named a checkout,
 * and two runs against it collide however different their workflows are.
 */
export function runWorkspace(run: { projectDir?: string, startedBy?: string }): string {
  return (run.projectDir?.trim()) || workspaceRootFor(run.startedBy)
}

/**
 * Whether a workspace holds a git checkout — the side effect a restart cannot
 * recreate on its own.
 *
 * The directory itself is either the checkout (an explicit projectDir) or the
 * root the provisioner clones repositories into, so both shapes count: a `.git`
 * here, or a `.git` one level down.
 */
export function hasCheckout(workspace: string): boolean {
  if (!existsSync(workspace)) return false
  if (existsSync(join(workspace, '.git'))) return true
  try {
    return readdirSync(workspace, { withFileTypes: true })
      .some(e => e.isDirectory() && existsSync(join(workspace, e.name, '.git')))
  }
  catch { return false }
}

/** What a browser-trace step can actually do here, decided by looking rather
 *  than by asking an agent to notice.
 *
 * The trace step twice produced no trace and no explanation, and the monitor
 * called it - correctly - "silence without explanation". The instruction to
 * declare `TRACE: n/a` was there; what was missing was anything concrete to
 * declare. A step told "there is no playwright config in this checkout and the
 * change touches no UI files" has a fact to quote. A step left to work it out
 * and then remember to say so has a chore it can skip.
 *
 * Deliberately conservative: it reports what is present, never that a trace is
 * impossible. The agent still decides, and every existing check on a CAPTURED
 * trace - populated trace.zip, real pass/fail counts, no fabricated artifact -
 * is untouched. This only closes the silent path.
 */
const PLAYWRIGHT_CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs']
const UI_EXTENSIONS = ['.vue', '.tsx', '.jsx', '.svelte', '.html', '.css', '.scss']

export interface BrowserSurface { playwright: boolean, uiFiles: string[], summary: string }

export function browserSurface(workspace: string): BrowserSurface {
  const roots: string[] = []
  if (existsSync(workspace)) {
    roots.push(workspace)
    try {
      for (const e of readdirSync(workspace, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.')) roots.push(join(workspace, e.name))
      }
    }
    catch { /* an unreadable workspace reports as bare */ }
  }

  const playwright = roots.some(r => PLAYWRIGHT_CONFIGS.some(c => existsSync(join(r, c))))

  // Only the working tree, and only one level of it: this is a hint for the
  // agent, not an inventory. A deep scan of a large checkout would cost more
  // than the step it is informing.
  const uiFiles: string[] = []
  for (const r of roots) {
    try {
      for (const e of readdirSync(r, { withFileTypes: true })) {
        if (e.isFile() && UI_EXTENSIONS.some(x => e.name.endsWith(x))) uiFiles.push(join(r, e.name))
      }
    }
    catch { /* skip */ }
  }

  const summary = playwright
    ? `Playwright config found${uiFiles.length ? '' : ', though no UI files were seen at the top level'} — a trace is expected unless the change has no UI surface.`
    : uiFiles.length
      ? 'No Playwright config found in this checkout, but UI files are present — say which you checked before reporting n/a.'
      : 'No Playwright config and no UI files found in this checkout — `TRACE: n/a` is the expected outcome, and this sentence is the reason to give.'

  return { playwright, uiFiles, summary }
}

// ── Checkout facts and run preparation ──────────────────────────────────────
// The roots above say where a developer's checkouts live; what follows reads
// them, prepares one for a run, and checks the one thing every run needs.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { agentRunsRoot } from './runArtifacts.ts'

const execFileP = promisify(execFile)
const gitRaw = async (cwd: string, args: string[]) =>
  (await execFileP('git', args, { cwd, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout
const git = async (cwd: string, args: string[]) => (await gitRaw(cwd, args)).trim()

/** The roots above keep `~` for display; filesystem work needs it expanded. */
const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir())
/** Where a product repo is expected for this developer: <their workspace>/<repo name>. */
export const checkoutDirFor = (repo: string, login?: string) => join(expand(workspaceRootFor(login)), repo.split('/').pop() || repo)

export interface CheckoutState {
  path: string
  name: string
  exists: boolean
  git: boolean
  branch?: string
  head?: string
  remote?: string
  /** Uncommitted or untracked paths, counted with -uall so a new directory is not one entry. */
  dirty: number
  dirtyFiles: string[]
}

export async function checkoutState(path: string): Promise<CheckoutState> {
  const name = path.split('/').pop() || path
  if (!existsSync(path)) return { path, name, exists: false, git: false, dirty: 0, dirtyFiles: [] }
  if (!existsSync(join(path, '.git'))) return { path, name, exists: true, git: false, dirty: 0, dirtyFiles: [] }
  try {
    const [branch, head, status] = await Promise.all([
      git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'no commits yet'),
      git(path, ['rev-parse', '--short', 'HEAD']).catch(() => ''),
      // Untrimmed: a leading space is the status column of the first line, not padding.
      gitRaw(path, ['status', '--porcelain', '-uall']),
    ])
    const remote = await git(path, ['remote', 'get-url', 'origin']).catch(() => undefined)
    // A nested repository shows up as one untracked directory in its parent; it is its own checkout, not a change here.
    const files = status.split('\n').filter(Boolean).map(l => l.slice(3)).filter(f => !(f.endsWith('/') && existsSync(join(path, f, '.git'))))
    return { path, name, exists: true, git: true, branch, head, remote, dirty: files.length, dirtyFiles: files.slice(0, 20) }
  } catch {
    return { path, name, exists: true, git: true, dirty: 0, dirtyFiles: [] }
  }
}

/** Every checkout on the instance: the shared root's own, and each developer's under it. */
export async function listCheckouts(): Promise<(CheckoutState & { owner?: string })[]> {
  const root = expand(workspaceRoot())
  if (!existsSync(root)) return []
  // Dot-directories are tooling state (.claude, editor caches), never a product checkout.
  const dirs = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort()
  const out: (CheckoutState & { owner?: string })[] = []
  for (const name of dirs) {
    const path = join(root, name)
    if (existsSync(join(path, '.git'))) { out.push(await checkoutState(path)); continue }
    // A developer's workspace: its children are the checkouts.
    const inner = (await readdir(path, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('.') && existsSync(join(path, d.name, '.git'))).map(d => d.name).sort()
    for (const n of inner) out.push({ ...(await checkoutState(join(path, n))), owner: name })
  }
  return out
}

/**
 * The git checkout inside a run's workspace: the workspace itself when an
 * agent cloned into it, else the child named after the repo, else the only
 * child with a .git. Undefined until something has been cloned.
 */
export function findCheckout(workspace: string, repoName?: string): string | undefined {
  const ws = expand(workspace)
  if (!existsSync(ws)) return undefined
  if (existsSync(join(ws, '.git'))) return ws
  if (repoName && existsSync(join(ws, repoName, '.git'))) return join(ws, repoName)
  try {
    const withGit = readdirSync(ws, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(ws, e.name, '.git'))).map(e => e.name)
    return withGit.length === 1 ? join(ws, withGit[0]!) : undefined
  } catch { return undefined }
}

/** Parks uncommitted work under a named stash so a run starts from a clean tree. `git stash pop` brings it back. */
export async function stashCheckout(path: string, login: string): Promise<{ stashed: boolean, message: string }> {
  const s = await checkoutState(path)
  if (!s.git) throw new Error(`${path} is not a git checkout`)
  if (!s.dirty) return { stashed: false, message: 'already clean' }
  const message = `agent-manager: parked by ${login} ${new Date().toISOString()}`
  await git(path, ['stash', 'push', '--include-untracked', '-m', message])
  return { stashed: true, message }
}

/**
 * A run works on its own branch off the checkout's current HEAD. Creating it
 * is the runner's job, not an agent's. A super-repo whose modules are their
 * own repositories (ASE keeps each module under modules/<name> with its own
 * origin) gets the branch in every one of them too: the commit and the pull
 * request happen in the module, and a module left on main would be pushed
 * as main.
 */
export async function ensureRunBranch(path: string, branch: string): Promise<string[]> {
  const repos = [path, ...nestedRepos(path)]
  for (const r of repos) {
    await git(r, ['checkout', '--quiet', '-B', branch])
    await excludeFromGit(r, '.agent/evidence-run/')
  }
  return repos
}

/** Git repositories one level under the checkout or under its modules/ directory. */
export function nestedRepos(path: string): string[] {
  const out: string[] = []
  for (const parent of [path, join(path, 'modules')]) {
    if (!existsSync(parent)) continue
    try {
      for (const e of readdirSync(parent, { withFileTypes: true })) {
        const dir = join(parent, e.name)
        if (e.isDirectory() && !e.name.startsWith('.') && dir !== join(path, 'modules') && existsSync(join(dir, '.git'))) out.push(dir)
      }
    } catch { /* unreadable: nothing nested */ }
  }
  return out
}

/** Evidence copies never reach a commit, whatever an agent stages: the path is excluded in the checkout itself. */
export async function excludeFromGit(path: string, pattern: string): Promise<void> {
  const file = join(path, '.git', 'info', 'exclude')
  const current = existsSync(file) ? await readFile(file, 'utf8') : ''
  if (current.split('\n').some(l => l.trim() === pattern)) return
  await mkdir(join(path, '.git', 'info'), { recursive: true })
  await appendFile(file, `${current.endsWith('\n') || !current ? '' : '\n'}${pattern}\n`)
}

/** Somewhere to write evidence: the one precondition every run has. */
export async function artifactsWritable(): Promise<{ ok: boolean, path: string, error?: string }> {
  const path = agentRunsRoot()
  try {
    await mkdir(path, { recursive: true })
    const probe = join(path, `.probe-${process.pid}-${Date.now()}`)
    await writeFile(probe, '')
    await rm(probe, { force: true })
    return { ok: true, path }
  } catch (err) {
    return { ok: false, path, error: err instanceof Error ? err.message : String(err) }
  }
}
