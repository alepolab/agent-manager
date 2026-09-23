import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import { agentManagerSettings } from './appSettings.ts'
import { runWorkspace, runLockKey } from './workspace.ts'
import { summarizeRunCost } from './costReport.ts'
import { createLogger } from './log.ts'
import { runArtifactsDir } from './runArtifacts.ts'
import type { WorkflowRun, NewRunInput, RunBudget } from '~~/shared/types/run'

/** Per-run caps: an env var on the instance wins, then the Settings page's values, then the defaults. */
export function defaultBudget(): RunBudget {
  const s = agentManagerSettings().runBudget ?? {}
  return {
    maxMinutes: Number(process.env.AGENT_RUN_MAX_MINUTES) || Number(s.maxMinutes) || 180,
    maxTokens: Number(process.env.AGENT_RUN_MAX_TOKENS) || Number(s.maxTokens) || 8_000_000,
    // Money, because tokens are not money. Every measured run spent $44-$56
    // while using 15-25% of the 8M token cap - that cap is worth roughly $200
    // at observed rates, so it has never once been the thing that stopped a
    // run. A dollar figure is what an operator actually budgets in.
    maxUsd: Number(process.env.AGENT_RUN_MAX_USD) || Number(s.maxUsd) || 60,
  }
}

/**
 * The most a single run may EVER spend, however many times its gate is
 * continued. `extendBudget` raises the cap in place when a person clicks
 * continue, and four real runs show caps ratcheted to 9.9M tokens / 304 min
 * that way - a ceiling nobody has to remember is the only kind that holds.
 */
export function absoluteUsdCeiling(): number {
  return Number(process.env.AGENT_RUN_MAX_USD_CEILING) || 250
}

const log = createLogger('runner')

export const RUNS_DIR_NAME = 'workflow-runs'

/** This process's identity for run ownership; see WorkflowRun.bootId. */
export const BOOT_ID = randomUUID()

const runsDir = () => resolveClaudePath(RUNS_DIR_NAME)
const runPath = (id: string) => join(runsDir(), `${id}.json`)

async function ensureDir() {
  const dir = runsDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await sweepStaleWrites(dir)
}

/**
 * Remove the half-written records a killed process leaves behind.
 *
 * A real one is still on disk: `a3cb9d37-….json.1.c2604368.tmp`, 131 KB,
 * holding that run as `running` under a boot id that died — beside the final
 * record written by a different boot. Nothing ever cleans these up, they are
 * counted by anything that reads the directory, and they are the only surviving
 * evidence that a restart happened at all (see WorkflowRun.restarts, which now
 * records it properly). Swept once per process, not per call: this runs on the
 * hot path.
 */
let sweptStaleWrites = false
async function sweepStaleWrites(dir: string): Promise<void> {
  if (sweptStaleWrites) return
  sweptStaleWrites = true
  try {
    const stale = (await readdir(dir)).filter(f => /\.json\.\d+\.[0-9a-f]+\.tmp$/.test(f))
    for (const f of stale) await rm(join(dir, f), { force: true })
    if (stale.length) log.warn('removed half-written run records left by a killed process', { count: stale.length })
  } catch { /* the directory is the caller's problem, not this sweep's */ }
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
  // A run paused on a person was never executing, so there is nothing to have
  // interrupted: the process that owned it died while a gate sat unanswered,
  // and answering it starts the work in whichever process is alive then.
  // resumeInterruptedRuns already refuses to touch these for exactly this
  // reason ("not an interruption, a question nobody answered"); relabelling
  // them here contradicted it, and the contradiction was visible — a restart
  // turned a developer's pending approval into an `interrupted` run, which
  // only an operator may resume. The decision must survive a deploy.
  if (run.status === 'paused' && run.question) return run
  const live = run.status === 'running' || run.status === 'paused'
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
  const run: WorkflowRun = {
    id: randomUUID(),
    workflowSlug: input.workflowSlug,
    workflowName: input.workflowName,
    status: 'running',
    autoRun: input.autoRun,
    ...(input.expectsPr ? { expectsPr: true } : {}),
    ...(input.rerunReason ? { rerunReason: input.rerunReason } : {}),
    ...(input.workflowSnapshot ? { workflowSnapshot: input.workflowSnapshot } : {}),
    initialPrompt: input.initialPrompt,
    watch: input.watch,
    ticketKey: input.ticketKey,
    projectDir: input.projectDir,
    product: input.product,
    startedBy: input.startedBy,
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
    runningSince: now,
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
  await rename(tmp, path)
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
  if (run.status === 'running' || run.status === 'paused') return 'live'
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

export async function findActiveRun(workflowSlug: string): Promise<WorkflowRun | null> {
  const runs = await listRuns(workflowSlug)
  return runs.find(r => r.status === 'running' || r.status === 'paused') ?? null
}

/**
 * A live run that would write the same directory as `workspace`, across EVERY
 * workflow — because the hazard is a shared checkout, not a shared workflow
 * definition. See server/utils/workspace.ts for why the per-workflow lock this
 * replaces was both too strict and too loose.
 */
export async function findRunInWorkspace(workspace: string, excludeRunId?: string): Promise<WorkflowRun | null> {
  const runs = await listRuns()
  // Compared by CLONE, not by path: see runLockKey. `workspace` is still
  // accepted as a path so every existing caller is unchanged, and is resolved
  // to the same identity the stored runs are.
  const live = runs.filter(r => (r.status === 'running' || r.status === 'paused') && r.id !== excludeRunId)
  if (!live.length) return null
  const byPath = live.find(r => runWorkspace(r) === workspace)
  if (byPath) return byPath
  const key = await runLockKey({ projectDir: workspace })
  const keys = await Promise.all(live.map(r => runLockKey(r)))
  const i = keys.findIndex(k => k === key)
  return i === -1 ? null : live[i]!
}

/**
 * A settled run that already did this ticket.
 *
 * CSUP-7514 was solved twice, six days apart, in two different codebases, for
 * about $110 - a selfcare middleware in one run and a CRM pipeline rule in the
 * other, each asserting root cause, neither mentioning the other. Two
 * independent address gates now exist because nothing looked.
 *
 * Returns the most recent completed or failed run for the ticket. A running or
 * paused one is already caught by the workspace lock; this is about work that
 * has FINISHED and been forgotten.
 */
export async function findRunForTicket(ticketKey: string, excludeRunId?: string): Promise<WorkflowRun | null> {
  if (!ticketKey) return null
  const runs = await listRuns()
  return runs.find(r =>
    r.id !== excludeRunId
    && r.ticketKey === ticketKey
    && (r.status === 'completed' || r.status === 'failed'),
  ) ?? null
}

/** The workflow definition a run was started from, read from disk. The runner
 *  needs it to rebuild scheduling state for a run it has never seen in memory. */
export async function loadWorkflowSteps(slug: string): Promise<{ slug: string, name: string, steps: any[] } | null> {
  const path = resolveClaudePath('workflows', `${slug}.json`)
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(await readFile(path, 'utf-8'))
    return { slug, name: data.name ?? slug, steps: data.steps ?? [] }
  } catch {
    return null
  }
}
