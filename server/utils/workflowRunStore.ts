import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import type { WorkflowRun, NewRunInput } from '~~/shared/types/run'

export const RUNS_DIR_NAME = 'workflow-runs'

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

/**
 * A run whose owning process is gone cannot still be running. This is computed
 * on read rather than written, because the writer is the thing that died.
 */
function applyInterrupted(run: WorkflowRun): WorkflowRun {
  const live = run.status === 'running' || run.status === 'paused'
  if (live && !processAlive(run.pid)) return { ...run, status: 'interrupted' }
  return run
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
    projectDir: input.projectDir,
    baseCommit: input.baseCommit,
    steps: input.steps.map(s => ({
      stepId: s.stepId, label: s.label, agentSlug: s.agentSlug,
      status: 'pending', input: '', output: '', visits: 0,
    })),
    currentStepIds: [],
    nextStepIds: [],
    startedAt: Date.now(),
    pid: process.pid,
  }
  await saveRun(run)
  return run
}

export async function saveRun(run: WorkflowRun): Promise<void> {
  await ensureDir()
  await writeFile(runPath(run.id), JSON.stringify(run, null, 2), 'utf-8')
}

export async function getRun(id: string): Promise<WorkflowRun | null> {
  const path = runPath(id)
  if (!existsSync(path)) return null
  try {
    return applyInterrupted(JSON.parse(await readFile(path, 'utf-8')) as WorkflowRun)
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
