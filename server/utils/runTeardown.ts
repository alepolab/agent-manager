/**
 * Gives back what a run took once it has an outcome: the compose stacks it
 * stood up and the git worktree it worked in.
 *
 * Nothing did this before. The provisioner's brief said "tear down what you
 * bring up", but its stack has to outlive it - the update and QA steps use it -
 * and no later step owned taking it down. A failed or stopped run never got
 * that far at all. Stacks held ports, container names and a subnet the next
 * run collided with, and worktrees piled up beside every clone.
 *
 * What it removes, and only that:
 * - compose projects named `sdlc-<run id>` (full or first eight characters),
 *   which is the name every step that stands something up is told to use. A
 *   shared stack (SSO, a product's own database) never carries that name, so
 *   it is never touched. No volume is removed: `down` without `-v`.
 * - the run's own worktree (`<clone>@<branch>`), and only if git agrees it is
 *   clean - an uncommitted change is kept and reported, never discarded. A
 *   fix branch is kept, since a pull request may be built on it; a scan's
 *   branch holds nothing and goes with its worktree.
 *
 * Best effort and never thrown: a teardown that fails must not change how the
 * run ended. RUN_TEARDOWN_DISABLED=1 turns it off, to inspect a run's stack.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '../../shared/types/run'

/** A run in one of these no longer uses anything. Same list as the runner's. */
const TERMINAL_STATUSES: WorkflowRun['status'][] = ['completed', 'failed', 'stopped']

const log = createLogger('runner')
const execFileP = promisify(execFile)

export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>
const realExec: Exec = async (cmd, args, opts) =>
  (await execFileP(cmd, args, { cwd: opts?.cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout

export interface TeardownReport {
  stacks: { project: string, removed: boolean, error?: string }[]
  worktree?: { path: string, removed: boolean, reason?: string }
}

/** The compose project names that belong to this run and nothing else. */
export function runProjectNames(runId: string): string[] {
  const id = runId.toLowerCase()
  return [...new Set([`sdlc-${id}`, `sdlc-${id.slice(0, 8)}`])]
}

/** The compose project a run's stack steps use: the one it claimed, else its own. */
export const stackProjectOf = (run: Pick<WorkflowRun, 'id' | 'stackProject'>): string => run.stackProject ?? `sdlc-${run.id.toLowerCase()}`

type StackRun = Pick<WorkflowRun, 'id' | 'status' | 'stackProject' | 'product'>

/** The live runs that use `project`: the run it was stood up for, and every run that claimed it. */
export function stackUsers(project: string, runs: StackRun[], except?: string): StackRun[] {
  return runs.filter(r => r.id !== except && !TERMINAL_STATUSES.includes(r.status)
    && (stackProjectOf(r) === project || runProjectNames(r.id).includes(project)))
}

/**
 * An up stack of this run's product that it can take over rather than stand
 * up its own: one whose runs are all stopped on a person, or finished. Each
 * Runbook A run kept ~1 GiB of stack up at its gates, and a new run on the
 * same product stood up another beside them.
 *
 * Never one a run is working in right now: two runs deploying different
 * builds into one stack at the same time would each test the other's code.
 */
export async function claimableStack(run: Pick<WorkflowRun, 'id' | 'product'>, runs: StackRun[], exec: Exec = realExec): Promise<{ project: string, from: string } | null> {
  const product = run.product?.name
  if (!product) return null
  let listed: { Name?: string, Status?: string }[] = []
  try { listed = JSON.parse(await exec('docker', ['compose', 'ls', '--format', 'json']) || '[]') } catch { return null }
  for (const { Name: name, Status: status } of listed) {
    if (!name || !/^sdlc-[0-9a-f-]+$/.test(name) || name.endsWith('-verify') || !/running/i.test(status ?? '')) continue
    const owner = runs.find(r => runProjectNames(r.id).includes(name))
    if (!owner || owner.id === run.id || owner.product?.name !== product) continue
    if (stackUsers(name, runs, run.id).some(u => u.status === 'running')) continue
    return { project: name, from: owner.id }
  }
  return null
}

/** Whether a compose project has anything running. False when docker cannot be asked. */
export async function stackIsUp(project: string, exec: Exec = realExec): Promise<boolean> {
  try {
    const listed = JSON.parse(await exec('docker', ['compose', 'ls', '--format', 'json']) || '[]') as { Name?: string, Status?: string }[]
    return listed.some(p => p.Name === project && /running/i.test(p.Status ?? ''))
  } catch { return false }
}

/** Steps that work in the run's stack after the provisioner stood it up. */
export const STACK_USING_AGENTS = /^sdlc-(stack-update|qa-|trace-capture$)/

/** Steps that can leave a compose stack running. A run with none of them has
 *  no stack to look for, which keeps docker out of every other run's ending. */
const STACK_AGENTS = /^sdlc-(stack-|verifier$|qa-|trace-capture$|scanner-ui$)/

export async function teardownRun(
  run: Pick<WorkflowRun, 'id' | 'branch' | 'projectDir' | 'steps' | 'stackProject'>,
  exec: Exec = realExec,
  /** Every run, to see who else uses a stack. Read from the store when not given. */
  runs?: StackRun[],
): Promise<TeardownReport> {
  const report: TeardownReport = { stacks: [] }
  if (process.env.RUN_TEARDOWN_DISABLED === '1') return report

  // ── stacks ──
  const mine = new Set([...runProjectNames(run.id), ...(run.stackProject ? [run.stackProject] : [])])
  let projects: string[] = []
  if (run.steps.some(s => STACK_AGENTS.test(s.agentSlug))) try {
    const listed = JSON.parse(await exec('docker', ['compose', 'ls', '-a', '--format', 'json']) || '[]') as { Name?: string }[]
    // Exact, or a suffix after the FULL id (`-verify`). Never a suffix after
    // the short form: `sdlc-<first 8>-` is the start of every full-id name,
    // including another run's that merely shares those eight characters.
    const full = `sdlc-${run.id.toLowerCase()}-`
    projects = listed.map(p => p.Name ?? '').filter(n => mine.has(n) || n.startsWith(full))
  } catch {
    // No docker, or no daemon: nothing this run can have stood up either.
  }
  // A stack another live run uses - the one that claimed it, or the run it was
  // claimed from - stays up: this run only lets go of it. The last user down
  // takes it down.
  const everyone: StackRun[] = projects.length ? (runs ?? await import('./workflowRunStore.ts').then(m => m.listRuns())) ?? [] : []
  for (const project of projects) {
    const users = stackUsers(project, everyone, run.id)
    if (users.length) {
      report.stacks.push({ project, removed: false, error: `kept: in use by run ${users.map(u => u.id.slice(0, 8)).join(', ')}` })
      continue
    }
    try {
      await exec('docker', ['compose', '-p', project, 'down', '--remove-orphans'])
      report.stacks.push({ project, removed: true })
    } catch (err) {
      report.stacks.push({ project, removed: false, error: String(err instanceof Error ? err.message : err).slice(0, 300) })
    }
  }

  // ── the run's own worktree ──
  const dir = run.projectDir
  if (run.branch && dir && /@[^/]+$/.test(dir) && existsSync(dir)) {
    const clone = dir.replace(/@[^/]+$/, '')
    try {
      const dirty = (await exec('git', ['status', '--porcelain'], { cwd: dir })).trim()
      if (dirty) {
        report.worktree = { path: dir, removed: false, reason: `kept: ${dirty.split('\n').length} uncommitted change(s)` }
      } else {
        await exec('git', ['worktree', 'remove', dir], { cwd: clone })
        if (run.branch.startsWith('scan/')) await exec('git', ['branch', '-D', run.branch], { cwd: clone }).catch(() => '')
        report.worktree = { path: dir, removed: true }
      }
    } catch (err) {
      report.worktree = { path: dir, removed: false, reason: String(err instanceof Error ? err.message : err).slice(0, 300) }
    }
  }

  if (report.stacks.length || report.worktree) log.info('run torn down', { runId: run.id, ...report })
  return report
}
