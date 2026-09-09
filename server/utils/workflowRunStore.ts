import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import { agentManagerSettings } from './appSettings.ts'
import { runWorkspace } from './workspace.ts'
import { summarizeRunCost } from './costReport.ts'
import { runArtifactsDir } from './runArtifacts.ts'
// Relative, not the ~~ alias: this is a VALUE import, so it survives to
// runtime, and the plain-node test scripts that import this module directly
// resolve no aliases. The type-only imports below may keep the alias because
// they are erased.
import { isLiveStatus, isWorkingStatus } from '../../shared/types/run.ts'
import type { WorkflowRun, NewRunInput, RunBudget } from '~~/shared/types/run'
import type { WorkflowParameter } from '~~/shared/utils/workflowParameters'

/** Per-run caps: an env var on the instance wins, then the Settings page's values, then the defaults. */
export function defaultBudget(): RunBudget {
  const s = agentManagerSettings().runBudget ?? {}
  return {
    maxMinutes: Number(process.env.AGENT_RUN_MAX_MINUTES) || Number(s.maxMinutes) || 180,
    maxTokens: Number(process.env.AGENT_RUN_MAX_TOKENS) || Number(s.maxTokens) || 8_000_000,
  }
}

export const RUNS_DIR_NAME = 'workflow-runs'

/** This process's identity for run ownership; see WorkflowRun.bootId. */
export const BOOT_ID = randomUUID()

const runsDir = () => resolveClaudePath(RUNS_DIR_NAME)
const runPath = (id: string) => join(runsDir(), `${id}.json`)

async function ensureDir() {
  const dir = runsDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

/** Is that process still alive? Signal 0 tests existence without signalling. */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** A step that will never change again. `skipped` counts: the scheduler passed
 *  it over, or the agent declared it not applicable, and either way it is done.
 *  There is no 'stopped' here - that is a RUN status, not a step one. */
const STEP_SETTLED = new Set<string>(['completed', 'failed', 'skipped'])

/**
 * A run whose owning process is gone cannot still be running. Computed on read
 * rather than written, because the writer is the thing that died.
 *
 * The subtlety is what "gone" means for a run that actually FINISHED. A run
 * record has two halves that are written separately: the per-step results, and
 * the run-level `status`/`endedAt`. A real run (011edeb8) reached all seven
 * steps - six completed, one skipped - and its final publish never landed, so
 * the record kept `status: 'running'`, `endedAt: null`, and a `currentStepIds`
 * still naming the step that had just finished. The record was written at
 * .881; the last step's own `completedAt` was .886, five milliseconds later.
 *
 * Reporting that as `interrupted` is wrong twice over: the work was not
 * interrupted, and a reader is told the run died when it succeeded. So when
 * every step has settled, derive the outcome from the steps - which ARE
 * durable - instead of from a status field that demonstrably may not be. Any
 * failed or stopped step makes the run `failed`; otherwise it `completed`.
 *
 * `interrupted` is still the honest answer for a run with work genuinely left
 * hanging: steps still `running` or `pending` and nobody alive to advance them.
 */
function applyInterrupted(run: WorkflowRun): WorkflowRun {
  // Deliberately NOT isLiveStatus: a `queued` run has no owner to lose. Its
  // pid and bootId name the process that queued it, which is routinely gone by
  // the time a slot frees, and calling that "interrupted" would delete the
  // queue on every restart.
  const live = isWorkingStatus(run.status)
  // Either signal means the owner is gone: a boot id from another process, or
  // a pid nothing answers on. Inside a container every server is pid 1, which
  // is why the boot id exists at all.
  const replaced = (!!run.bootId && run.bootId !== BOOT_ID) || !processAlive(run.pid)
  if (!live || !replaced) return run

  const steps = run.steps ?? []
  const allSettled = steps.length > 0 && steps.every(s => STEP_SETTLED.has(s.status))
  if (allSettled) {
    const failed = steps.some(s => s.status === 'failed')
    return {
      ...run,
      status: failed ? 'failed' : 'completed',
      // Best available answer, not a fabrication: the last moment any step
      // finished IS when the run finished. Left untouched if already recorded.
      endedAt: run.endedAt ?? (Math.max(...steps.map(s => s.completedAt ?? 0)) || undefined),
      currentStepIds: [],
      nextStepIds: [],
    }
  }

  return { ...run, status: 'interrupted' }
}

/** Runs persisted before budgets existed get the defaults on read. */
function applyDefaults(run: WorkflowRun): WorkflowRun {
  const out = run.budget ? run : { ...run, budget: defaultBudget() }
  if (out.usage) return out
  // Runs recorded before run.usage existed still have per-step usage; the
  // cost report is the one place that prices it, so the lists agree with it.
  const t = summarizeRunCost(out).totals
  return { ...out, usage: { input_tokens: t.input_tokens, output_tokens: t.output_tokens, usd: Math.round(t.cost_usd * 10000) / 10000 } }
}

export async function createRun(input: NewRunInput): Promise<WorkflowRun> {
  await ensureDir()
  const now = Date.now()
  const status = input.status ?? 'running'
  const run: WorkflowRun = {
    id: randomUUID(),
    workflowSlug: input.workflowSlug,
    workflowName: input.workflowName,
    status,
    group: input.group,
    // Only a queued run has one, so its presence is also the honest record of
    // "this run waited". A run that started immediately never did.
    ...(status === 'queued' ? { queuedAt: Date.now() } : {}),
    autoRun: input.autoRun,
    initialPrompt: input.initialPrompt,
    watch: input.watch,
    ticketKey: input.ticketKey,
    projectDir: input.projectDir,
    parameters: input.parameters,
    product: input.product,
    startedBy: input.startedBy,
    parentRunId: input.parentRunId,
    baseCommit: input.baseCommit,
    steps: input.steps.map(s => ({
      stepId: s.stepId, label: s.label, agentSlug: s.agentSlug,
      status: 'pending', input: '', output: '', visits: 0,
    })),
    currentStepIds: [],
    nextStepIds: [],
    startedAt: now,
    // The run clock starts with the run; publish() takes it from here. Both
    // fields are set explicitly rather than left absent, because absent is how
    // the clock recognises a record written before it existed.
    activeMs: 0,
    // Only a run that is actually running has an open stretch. A queued run
    // has not started, and startRunClock is idempotent - a runningSince set
    // here would survive the queued -> running transition and bill the whole
    // queue wait as execution time.
    ...(status === 'queued' ? {} : { runningSince: now }),
    pid: process.pid,
    bootId: BOOT_ID,
    budget: defaultBudget(),
  }
  await saveRun(run)
  return run
}

export async function saveRun(run: WorkflowRun): Promise<void> {
  await ensureDir()
  // Write-then-rename so a reader never sees a half-written record: getRun
  // treats unparseable JSON as a missing run, which turned a concurrent read
  // during publish into a spurious 404.
  const path = runPath(run.id)
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`  // unique per call: two concurrent saves of one run shared a name, and the second rename found nothing
  await writeFile(tmp, JSON.stringify(run, null, 2), 'utf-8')

  // Retried, because on Windows renaming ONTO a file somebody else has open
  // fails with EPERM. Every listRuns() opens every record - the /runs page
  // polls it, the run queue's drain sweeps it - so a save landing while any of
  // those is mid-read loses the write. Observed as runs reaching 'failed' with
  // `EPERM: operation not permitted, rename ...` as their error: the record was
  // fine, the reader was just holding it. The read side cannot fix this (a
  // reader has no lock to release), and the write side must not give up on a
  // condition that clears in microseconds.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw err
      await new Promise(r => setTimeout(r, 5 * (attempt + 1)))
    }
  }
}

export async function getRun(id: string): Promise<WorkflowRun | null> {
  const path = runPath(id)
  if (!existsSync(path)) return null
  try {
    return applyInterrupted(applyDefaults(JSON.parse(await readFile(path, 'utf-8')) as WorkflowRun))
  } catch {
    // A half-written or corrupt record is a missing record, never a crash.
    return null
  }
}

/**
 * Removes a settled run entirely: its live entry, its record and its evidence
 * directory. Returns 'not-found', 'live' (refused — stop it first), or 'ok'.
 * The record is unlinked before the artifacts, so a half-finished delete never
 * leaves a record pointing at a gone bundle.
 */
export async function deleteRun(id: string): Promise<'ok' | 'not-found' | 'live'> {
  const run = await getRun(id)
  if (!run) return 'not-found'
  if (isLiveStatus(run.status)) return 'live'
  await rm(runPath(id), { force: true })
  await rm(join(runArtifactsDir(id), '..'), { recursive: true, force: true })
  return 'ok'
}

export async function listRuns(workflowSlug?: string): Promise<WorkflowRun[]> {
  const dir = runsDir()
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const runs: WorkflowRun[] = []
  for (const file of files) {
    const run = await getRun(file.replace(/\.json$/, ''))
    if (run && (!workflowSlug || run.workflowSlug === workflowSlug)) runs.push(run)
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt)
}

/** This workflow's run that can still change, if any. Counts a `queued` run:
 *  a watch that could not see one would dispatch a second ticket into the same
 *  queue on its next cycle, which is the dedupe this function exists for. */
export async function findActiveRun(workflowSlug: string): Promise<WorkflowRun | null> {
  const runs = await listRuns(workflowSlug)
  return runs.find(r => isLiveStatus(r.status)) ?? null
}

/**
 * A run that would write the same directory as `workspace`, across EVERY
 * workflow — because the hazard is a shared checkout, not a shared workflow
 * definition. See server/utils/workspace.ts for why the per-workflow lock this
 * replaces was both too strict and too loose.
 *
 * `includeQueued` picks which of two different questions is being asked, and
 * getting it wrong is silent both ways:
 *
 *  - **false (the default) — "is anything WORKING here right now?"** This is
 *    the lock. A queued run holds no checkout, so counting it would refuse a
 *    start for a directory nothing is touching. This is what a launch and a
 *    restart ask.
 *  - **true — "is anything already AIMED here?"** This is admission. A cron
 *    schedule whose group is full queues; if the next fire cannot see that
 *    queued run it queues a second, and a third, and by morning eight runs
 *    are pointed at one `projectDir` for the queue to launch into each other.
 *    Two parents dispatching the same ticket key produce the same collision,
 *    since a child's directory is derived from that key.
 */
export async function findRunInWorkspace(
  workspace: string,
  excludeRunId?: string,
  opts: { includeQueued?: boolean } = {},
): Promise<WorkflowRun | null> {
  const runs = await listRuns()
  return runs.find(r =>
    (opts.includeQueued ? isLiveStatus(r.status) : isWorkingStatus(r.status))
    && r.id !== excludeRunId
    && runWorkspace(r) === workspace,
  ) ?? null
}

/** The workflow definition a run was started from, read from disk. The runner
 *  needs it to rebuild scheduling state for a run it has never seen in memory,
 *  the dispatch step needs a target's `parameters` to work out which of the
 *  parent's values that child actually declares, and every automated starter
 *  needs its `group` to know which cap the run counts against. This is the only
 *  workflow reader on those paths, so returning `group` here is what keeps
 *  slot accounting from re-reading a workflow file per live run. */
export async function loadWorkflowSteps(slug: string): Promise<{ slug: string, name: string, group?: string, steps: any[], parameters?: WorkflowParameter[] } | null> {
  const path = resolveClaudePath('workflows', `${slug}.json`)
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(await readFile(path, 'utf-8'))
    return { slug, name: data.name ?? slug, group: data.group || undefined, steps: data.steps ?? [], parameters: data.parameters ?? [] }
  } catch {
    return null
  }
}
