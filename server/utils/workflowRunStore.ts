import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import { summarizeRunCost } from './costReport.ts'
import type { WorkflowRun, NewRunInput, RunBudget } from '~~/shared/types/run'

export function defaultBudget(): RunBudget {
  return {
    maxMinutes: Number(process.env.AGENT_RUN_MAX_MINUTES) || 180,
    maxTokens: Number(process.env.AGENT_RUN_MAX_TOKENS) || 8_000_000,
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
  const run: WorkflowRun = {
    id: randomUUID(),
    workflowSlug: input.workflowSlug,
    workflowName: input.workflowName,
    status: 'running',
    autoRun: input.autoRun,
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
    startedAt: Date.now(),
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
  const tmp = `${path}.${process.pid}.tmp`
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
