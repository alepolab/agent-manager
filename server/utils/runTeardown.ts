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

/** Steps that can leave a compose stack running. A run with none of them has
 *  no stack to look for, which keeps docker out of every other run's ending. */
const STACK_AGENTS = /^sdlc-(stack-|verifier$|qa-|trace-capture$|scanner-ui$)/

export async function teardownRun(
  run: Pick<WorkflowRun, 'id' | 'branch' | 'projectDir' | 'steps'>,
  exec: Exec = realExec,
): Promise<TeardownReport> {
  const report: TeardownReport = { stacks: [] }
  if (process.env.RUN_TEARDOWN_DISABLED === '1') return report

  // ── stacks ──
  const mine = new Set(runProjectNames(run.id))
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
  for (const project of projects) {
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
