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
import { join, relative } from 'node:path'

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
 * The lock identity for a run: the clone it will write, not the path string it
 * was handed.
 *
 * Two SBN-4091 runs overlapped by 43 minutes on the same repository and the
 * guard never fired, because the second run's `projectDir` was the FIRST run's
 * worktree - two different strings, one clone. The proof is still on disk:
 * `pc@fix-SBN-4091-543dbc88@fix-SBN-4091-644a961b`, a worktree inside a
 * worktree, with a lane cut inside that.
 *
 * `--git-common-dir` is the answer git itself gives: every worktree of one
 * clone resolves to the same `.git` directory, so nesting cannot hide it.
 * Falls back to the path when the directory is not a checkout at all, which is
 * the ordinary case for a run whose product was never cloned here.
 */
export async function runLockKey(run: { projectDir?: string, startedBy?: string }): Promise<string> {
  const dir = runWorkspace(run)
  if (!existsSync(dir)) return dir
  try {
    // Async on purpose: this is called once per live run on every start and
    // restart request, and a synchronous git call measured 2.35 ms each — on an
    // instance with twenty live runs that is a 50 ms event-loop stall per
    // request, growing with the number of runs.
    return (await gitRaw(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() || dir
  } catch {
    return dir
  }
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
  /**
   * Stashes on this checkout, newest first.
   *
   * Parking work told you how to get it back in a `confirm()` that closed on
   * the click and a toast that faded — so the only record of a long
   * `git -C … stash pop` was gone seconds after the act, and the row went back
   * to reading "clean" with no sign that anything had been set aside. Read
   * from git rather than remembered in the client, so it survives a reload and
   * is true even when someone else did the parking.
   */
  stashes: { ref: string, subject: string }[]
}

export async function checkoutState(path: string): Promise<CheckoutState> {
  const name = path.split('/').pop() || path
  if (!existsSync(path)) return { path, name, exists: false, git: false, dirty: 0, dirtyFiles: [], stashes: [] }
  if (!existsSync(join(path, '.git'))) return { path, name, exists: true, git: false, dirty: 0, dirtyFiles: [], stashes: [] }
  try {
    const [branch, head, status, stashList] = await Promise.all([
      git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'no commits yet'),
      git(path, ['rev-parse', '--short', 'HEAD']).catch(() => ''),
      // Untrimmed: a leading space is the status column of the first line, not padding.
      gitRaw(path, ['status', '--porcelain', '-uall']),
      // Cheap: reads refs/stash. Empty on a checkout that never stashed.
      gitRaw(path, ['stash', 'list', '--format=%gd%x00%gs']).catch(() => ''),
    ])
    const stashes = stashList.split('\n').filter(Boolean).map((l) => {
      const [ref = '', subject = ''] = l.split('\0')
      return { ref, subject }
    })
    const remote = await git(path, ['remote', 'get-url', 'origin']).catch(() => undefined)
    // A nested repository shows up as one untracked directory in its parent; it is its own checkout, not a change here.
    const files = status.split('\n').filter(Boolean).map(l => l.slice(3)).filter(f => !(f.endsWith('/') && existsSync(join(path, f, '.git'))))
    return { path, name, exists: true, git: true, branch, head, remote, dirty: files.length, dirtyFiles: files.slice(0, 20), stashes }
  } catch {
    return { path, name, exists: true, git: true, dirty: 0, dirtyFiles: [], stashes: [] }
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
    // A run's worktree (`<repo>@<branch>`) sits beside the clone and is never the clone.
    const withGit = readdirSync(ws, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.includes('@') && existsSync(join(ws, e.name, '.git'))).map(e => e.name)
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

/** Where a run works: a worktree beside the clone, named after it and the run branch. */
export const worktreeDirFor = (checkout: string, branch: string) => `${checkout}@${branch.replace(/[^A-Za-z0-9_.-]+/g, '-')}`

/**
 * A run works on its own branch in its own git worktree, made beside the
 * clone: `<clone>@<branch>`. Creating it is the runner's job, not an agent's.
 * A worktree rather than `checkout -B` in the clone itself, because the clone
 * is the developer's: switching it under them was how a run's branch ended up
 * in their editor, and why two runs on one product could not coexist. A
 * super-repo whose modules are their own repositories (ASE keeps each module
 * under modules/<name> with its own origin) gets a worktree for every one of
 * them too, at the same relative path inside the run's worktree: the commit and
 * the pull request happen in the module, and a module left on main would be
 * pushed as main.
 *
 * Returns the worktree paths, the run's own first. A worktree that already
 * exists on the branch (a restart after the runner made it but before the run
 * recorded it) is reused, never rebuilt over work.
 */
export async function ensureRunBranch(path: string, branch: string, base?: string): Promise<string[]> {
  // Serialised with every other worktree mutation on this clone: git locks the
  // repository for add/remove/prune, so a settled run handing its worktree
  // back while this one cuts its own made one of them fail — from a run that
  // did nothing wrong.
  return onClone(path, () => ensureRunBranchNow(path, branch, base))
}

async function ensureRunBranchNow(path: string, branch: string, base?: string): Promise<string[]> {
  const root = worktreeDirFor(path, branch)
  const out: string[] = []
  for (const r of [path, ...nestedRepos(path)]) {
    const wt = join(root, relative(path, r))
    // From the base branch on the remote when it has one: a fresh clone sits on
    // the default branch and a developer's checkout on whatever they were doing,
    // and neither is where a hotfix or a task is supposed to start. A repository
    // without that branch (a module repository with its own naming) starts from
    // its HEAD, which is the old behaviour.
    let start: string | undefined
    if (base) {
      try { await git(r, ['fetch', '--quiet', 'origin', base]) } catch { /* no remote, or no such branch: decided below */ }
      try { await git(r, ['rev-parse', '--verify', '--quiet', `origin/${base}`]); start = `origin/${base}` } catch { start = undefined }
    }
    // A worktree directory deleted by hand leaves a stale registration that blocks the branch; prune first.
    await git(r, ['worktree', 'prune'])
    // A `.git` entry, not the directory: a superproject's worktree materialises
    // every submodule as an EMPTY directory, and git commands inside it answer
    // for the parent, so the empty placeholder would have read as "already on
    // the branch" and the module's own worktree would never have been made.
    if (existsSync(join(wt, '.git'))) {
      const current = await git(wt, ['branch', '--show-current']).catch(() => '')
      if (current !== branch) throw new Error(`${wt} exists and is on ${current || 'no branch'}, not ${branch}`)
    } else {
      await git(r, ['worktree', 'add', '--quiet', '-B', branch, wt, ...(start ? [start] : [])])
    }
    await excludeFromGit(wt, '.agent/evidence-run/')
    // Everything under the scratch directory EXCEPT the plan, which the plan
    // gate requires a run to commit. `.agent/source-edited` and
    // `.agent/test-unlock.json` littered six worktrees and one run added its own
    // .gitignore rule for them; the pattern pair is that policy, once, for every
    // run. `.agent/*` rather than `.agent/`, because a negation cannot re-include
    // a file inside an excluded DIRECTORY.
    await excludeFromGit(wt, '.agent/*')
    await excludeFromGit(wt, '!.agent/plan.md')
    await installRunTrailer(wt, branch)
    out.push(wt)
  }
  return out
}

/**
 * One branch of a parallel wave, and the branch it commits on.
 *
 * Every step of a run used to work in the run's single worktree, which is safe
 * for steps that read and races for steps that write: two agents committing at
 * once contend for one index, and whichever loses reports a `index.lock` error
 * or sweeps the other's half-written files into its own commit. The workflow
 * page said as much in a tooltip and left it at that.
 *
 * A lane is therefore a worktree per concurrent step, on its own branch cut
 * from the run branch's tip, merged back into the run branch the moment the
 * wave settles (`mergeLane`) and then removed (`removeLane`). Lanes never
 * outlive their wave, so the run branch stays the one place the work lives and
 * every later step - and the pull request - sees all of it.
 *
 * Only the run's own repository gets a lane. A super-repo whose modules are
 * their own repositories (nestedRepos) keeps sharing its module worktrees, so
 * two agents writing the SAME module in one wave still race; the workflows
 * this ships put at most one writer per wave for that reason.
 */
export const laneBranchFor = (branch: string, label: string) =>
  `${branch}--lane-${(label.toLowerCase().match(/[a-z0-9]+/g) ?? ['step']).join('-').slice(0, 40)}`

/** Where a lane works: beside the run's worktree, named after the lane's branch. */
export const laneDirFor = (runWorktree: string, laneBranch: string) =>
  `${runWorktree}__${laneBranch.split('--lane-').pop()!.replace(/[^A-Za-z0-9_.-]+/g, '-')}`

/**
 * Cut one lane. Reused when it already exists on the right branch, which is
 * what a restart into the middle of a wave finds.
 *
 * `git worktree add` is run from the run's worktree: a linked worktree answers
 * for the whole clone, so the lane is registered against the same repository
 * without needing to know where the clone is.
 */
export async function ensureLane(runWorktree: string, laneBranch: string): Promise<string> {
  const dir = laneDirFor(runWorktree, laneBranch)
  if (existsSync(join(dir, '.git'))) {
    const current = await git(dir, ['branch', '--show-current']).catch(() => '')
    if (current === laneBranch) return dir
    throw new Error(`${dir} exists and is on ${current || 'no branch'}, not ${laneBranch}`)
  }
  // A lane directory deleted by hand leaves a registration that blocks the branch.
  await git(runWorktree, ['worktree', 'prune'])
  // From HEAD, not from a remote: the lane continues the run's own work, which
  // only exists locally on the run branch.
  await git(runWorktree, ['worktree', 'add', '--quiet', '-B', laneBranch, dir, 'HEAD'])
  return dir
}

/**
 * Merge a settled lane back into the run branch, in the run's worktree.
 *
 * Returns what happened, as a sentence for the run log. A lane that committed
 * nothing merges to nothing and says so. A conflict throws: two agents that
 * edited the same lines is exactly the case a person must see, and a silent
 * `-X ours` here would delete one agent's work while reporting success.
 */
export async function mergeLane(runWorktree: string, laneBranch: string): Promise<string> {
  const ahead = await git(runWorktree, ['rev-list', '--count', `HEAD..${laneBranch}`]).catch(() => '0')
  if (ahead === '0') return `${laneBranch}: no commits to merge.`
  try {
    await git(runWorktree, ['merge', '--no-edit', '--no-ff', laneBranch])
    return `${laneBranch}: merged ${ahead} commit(s) into the run branch.`
  } catch (err) {
    await git(runWorktree, ['merge', '--abort']).catch(() => {})
    throw new Error(`${laneBranch} conflicts with the run branch and was left unmerged (${err instanceof Error ? err.message : String(err)}). Its commits are still on that branch: merge it by hand, then restart the step that needs them.`)
  }
}

/** Remove a lane's worktree and its branch. Best effort: a lane left behind is noise, not damage. */
export async function removeLane(runWorktree: string, laneBranch: string): Promise<void> {
  const dir = laneDirFor(runWorktree, laneBranch)
  await git(runWorktree, ['worktree', 'remove', '--force', dir]).catch(() => {})
  await git(runWorktree, ['worktree', 'prune']).catch(() => {})
  await git(runWorktree, ['branch', '-D', laneBranch]).catch(() => {})
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
/**
 * A commit made in a run worktree says which run made it.
 *
 * Every agent commit across thirteen runs is authored by the operator, and
 * `git log` cannot answer "was this agent-written?" or "where is the evidence
 * for this line?" — grepping every run commit for a run id returns nothing. The
 * `Co-Authored-By` trailer that was supposed to mark them is missing from four
 * commits outright and carries a stray personal address on a fifth.
 *
 * A `prepare-commit-msg` hook rather than a runner-side amend: the agents commit
 * themselves, through whatever git invocation they choose, and a hook is the one
 * place every one of those passes through. Written into the worktree's own hooks
 * directory, so it exists for this run and nothing else on the machine.
 */
export async function installRunTrailer(worktree: string, branch: string): Promise<void> {
  const runId = branch.split('-').pop() ?? ''
  if (!/^[0-9a-f]{6,}$/i.test(runId)) return // not a run branch: nothing to stamp
  try {
    const gitDir = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim()
    const hooks = join(gitDir, 'hooks')
    await mkdir(hooks, { recursive: true })
    const hook = join(hooks, 'prepare-commit-msg')
    // Idempotent and additive: a message that already carries the trailer (an
    // amend, a rebase) is left alone.
    const body = [
      '#!/bin/sh',
      '# Installed by Agent Manager for this run worktree. Stamps the run id on',
      '# every commit made here, so `git log --grep` can find the evidence.',
      `RUN_TRAILER="Run-Id: ${runId}"`,
      'grep -qF "$RUN_TRAILER" "$1" 2>/dev/null && exit 0',
      'printf "\n%s\n" "$RUN_TRAILER" >> "$1"',
      '',
    ].join('\n')
    await writeFile(hook, body, { mode: 0o755 })
  } catch {
    // A missing hook is a missing trailer, never a failed run.
  }
}

export async function excludeFromGit(path: string, pattern: string): Promise<void> {
  // In a linked worktree `.git` is a file: info/exclude lives in the common dir, shared by every worktree of the clone.
  const gitDir = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => join(path, '.git'))
  const file = join(gitDir, 'info', 'exclude')
  const current = existsSync(file) ? await readFile(file, 'utf8') : ''
  if (current.split('\n').some(l => l.trim() === pattern)) return
  await mkdir(join(gitDir, 'info'), { recursive: true })
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

/**
 * Worktree mutations on one clone, serialised.
 *
 * git takes a lock per repository for `worktree add`, `remove` and `prune`, so
 * two of them at once means one fails — and with groups running in parallel
 * and a settled run handing its worktree back, that is now the ordinary case
 * rather than a rarity. The failure is the worst kind: "could not create the
 * run worktree", from a run that did nothing wrong.
 *
 * Per clone, not global: two repositories have nothing to contend over, and
 * serialising them would make every parallel group wait on every other.
 */
const worktreeLocks = new Map<string, Promise<unknown>>()

function onClone<T>(clone: string, work: () => Promise<T>): Promise<T> {
  const prev = worktreeLocks.get(clone) ?? Promise.resolve()
  const next = prev.then(work, work)
  // Keep the chain alive but never let a rejection poison the next caller.
  worktreeLocks.set(clone, next.then(() => {}, () => {}))
  return next
}

export interface WorktreeCleanup { removed: boolean, reason: string }

/**
 * Remove a settled run's worktree, unless doing so would lose work.
 *
 * Nothing ever did this. `ensureRunBranch` cut a worktree per run and
 * `removeLane` cleaned up lanes, but the run's own worktree stayed for ever —
 * so an instance accumulated one directory per run it had ever executed, the
 * checkout list grew without bound, and a directory someone deleted by hand
 * left a STALE REGISTRATION that then refused the next run on that branch
 * ("<path> exists and is on <branch>"). Both failure modes were live on this
 * instance: five leftover worktrees on disk, and two repositories registering
 * worktrees whose directories were already gone.
 *
 * The safety rule is the whole point, because a worktree is where a run's work
 * lives until it is pushed:
 *
 *  - uncommitted changes    -> KEEP. That work exists nowhere else.
 *  - commits not on a remote -> KEEP. The branch is local; removing the
 *                              worktree leaves it unreachable in practice.
 *  - otherwise               -> remove, and prune the registration.
 *
 * Never throws: cleanup is housekeeping, and a run that finished correctly
 * must not be reported as failed because a directory would not delete.
 */
export async function cleanupRunWorktree(worktree: string | undefined): Promise<WorktreeCleanup> {
  if (!worktree || !worktree.includes('@')) return { removed: false, reason: 'not a run worktree' }
  const clone = worktree.split('@')[0]!
  if (!existsSync(clone)) return { removed: false, reason: 'its clone is gone' }
  return onClone(clone, () => cleanupNow(clone, worktree))
}

async function cleanupNow(clone: string, worktree: string): Promise<WorktreeCleanup> {

  // Prune first: a registration whose directory has already been removed is
  // the thing that blocks the next run, and it costs nothing to clear.
  await git(clone, ['worktree', 'prune']).catch(() => '')
  if (!existsSync(worktree)) return { removed: true, reason: 'already gone; stale registration pruned' }

  try {
    const dirty = (await gitRaw(worktree, ['status', '--porcelain', '-uall'])).split('\n').filter(Boolean)
    if (dirty.length) return { removed: false, reason: `${dirty.length} uncommitted change(s) live only here` }

    const branch = await git(worktree, ['branch', '--show-current']).catch(() => '')
    if (branch) {
      // `@{u}` fails when there is no upstream, which is itself the answer:
      // nothing has been pushed, so every commit on this branch is local.
      const unpushed = await git(worktree, ['rev-list', '--count', `@{u}..HEAD`]).catch(() => null)
      if (unpushed === null) {
        const local = await git(worktree, ['rev-list', '--count', `HEAD`]).catch(() => '0')
        const base = await git(clone, ['rev-list', '--count', 'HEAD']).catch(() => '0')
        if (Number(local) > Number(base)) return { removed: false, reason: `${Number(local) - Number(base)} commit(s) are not on any remote` }
      } else if (Number(unpushed) > 0) {
        return { removed: false, reason: `${unpushed} commit(s) are not pushed` }
      }
    }

    await git(clone, ['worktree', 'remove', '--force', worktree])
    await git(clone, ['worktree', 'prune']).catch(() => '')
    return { removed: true, reason: 'clean and fully pushed' }
  } catch (err) {
    return { removed: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Clear registrations whose directories are gone, across every checkout. The
 *  cheap half of the fix: a stale one refuses the next run on that branch. */
export async function pruneAllWorktrees(): Promise<number> {
  let pruned = 0
  for (const c of await listCheckouts()) {
    if (!c.git || c.name.includes('@')) continue
    const before = (await git(c.path, ['worktree', 'list']).catch(() => '')).split('\n').length
    await git(c.path, ['worktree', 'prune']).catch(() => '')
    const after = (await git(c.path, ['worktree', 'list']).catch(() => '')).split('\n').length
    pruned += Math.max(0, before - after)
  }
  return pruned
}
