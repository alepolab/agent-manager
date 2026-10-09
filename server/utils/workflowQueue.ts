/**
 * A workflow's run queue: a list of runs to make one after another, each
 * started when the one before it settles. The robot migration uses it to port
 * folder after folder unattended; a person still answers every gate that
 * stops for them, and the queue simply waits until that run ends.
 *
 * Stored as `workflow-queues/<slug>.json` in the config directory, beside
 * (not inside) `workflows/`, which is read as workflow definitions.
 *
 * Only a run that ends `completed` moves the queue on. One that is stopped,
 * rejected or failed marks its item `stopped` and pauses the queue, since the
 * next folder may depend on the one that did not land, and a person decides.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveClaudePath, safeSegment } from './claudeDir.ts'
import { loadWorkflowSteps, toWorkflowLike } from './workflowRunStore.ts'
import { startOrQueue } from './workflowRunner.ts'
import { resolveParameters, RESERVED_PARAM_PROJECT_DIR } from '../../shared/utils/workflowParameters.ts'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '~~/shared/types/run'

const log = createLogger('runner')

export type QueueItemStatus = 'pending' | 'running' | 'done' | 'stopped'

export interface QueueItem {
  /** The run's initial prompt, e.g. "Port Sanity_Testcases (03__Discount_Policy.robot only)". */
  prompt: string
  /** Laid over the queue's default parameters. */
  parameters?: Record<string, string>
  status: QueueItemStatus
  runId?: string
  startedAt?: number
  endedAt?: number
  /** Why it stopped, or how the run ended. */
  note?: string
}

export interface WorkflowQueue {
  /** Off: nothing new starts. A run already going finishes and is recorded. */
  enabled: boolean
  /** Why the queue turned itself off, shown until someone turns it on again. */
  pausedReason?: string
  defaults: { parameters?: Record<string, string>, autoRun?: boolean, startedBy?: string }
  items: QueueItem[]
}

export function queuePath(slug: string): string {
  return resolveClaudePath('workflow-queues', `${safeSegment(slug)}.json`)
}

export async function readQueue(slug: string): Promise<WorkflowQueue | null> {
  const file = queuePath(slug)
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, 'utf8')) as WorkflowQueue
}

export async function writeQueue(slug: string, queue: WorkflowQueue): Promise<void> {
  const file = queuePath(slug)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(queue, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

// One change to a queue at a time: a run settling and a person pressing start
// would otherwise both see no running item and start two runs.
const chains = new Map<string, Promise<unknown>>()
function serial<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(slug) ?? Promise.resolve()).catch(() => {}).then(fn)
  chains.set(slug, next)
  return next
}

/** Start the first pending item, unless the queue is off or an item is running. */
async function startNextLocked(slug: string): Promise<QueueItem | null> {
  const queue = await readQueue(slug)
  if (!queue?.enabled || queue.items.some(i => i.status === 'running')) return null
  const item = queue.items.find(i => i.status === 'pending')
  if (!item) {
    log.info('workflow queue finished', { workflow: slug })
    return null
  }
  const pause = async (why: string) => {
    item.status = 'stopped'
    item.note = why
    queue.enabled = false
    queue.pausedReason = why
    await writeQueue(slug, queue)
    log.warn('workflow queue paused', { workflow: slug, prompt: item.prompt, why })
    return null
  }
  const workflow = await loadWorkflowSteps(slug)
  if (!workflow?.steps.length) return pause(`workflow "${slug}" is missing or has no steps`)
  const supplied = { ...(queue.defaults.parameters ?? {}), ...(item.parameters ?? {}) }
  const { values, missing } = resolveParameters(workflow.parameters, supplied)
  if (missing.length) return pause(`no value for ${missing.join(', ')}`)
  try {
    const { run } = await startOrQueue({
      workflow: toWorkflowLike(workflow),
      initialPrompt: item.prompt,
      parameters: values,
      projectDir: values[RESERVED_PARAM_PROJECT_DIR],
      autoRun: queue.defaults.autoRun ?? true,
      startedBy: queue.defaults.startedBy,
      watch: `queue:${slug}`,
    })
    item.status = 'running'
    item.runId = run.id
    item.startedAt = Date.now()
    delete item.note
    queue.pausedReason = undefined
    await writeQueue(slug, queue)
    log.info('workflow queue started a run', { workflow: slug, runId: run.id, prompt: item.prompt })
    return item
  } catch (err) {
    return pause(`could not start: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function startNextInQueue(slug: string): Promise<QueueItem | null> {
  return serial(slug, () => startNextLocked(slug))
}

/** Turn the queue on and start its next item if nothing is running. */
export function resumeQueue(slug: string): Promise<QueueItem | null> {
  return serial(slug, async () => {
    const queue = await readQueue(slug)
    if (!queue) return null
    queue.enabled = true
    queue.pausedReason = undefined
    await writeQueue(slug, queue)
    return startNextLocked(slug)
  })
}

/**
 * Called on every publish of a settled run. Records how the queue's run
 * ended, then starts the next item when it ended completed.
 */
export function advanceQueue(run: WorkflowRun): Promise<void> {
  if (!run.workflowSlug || run.watch !== `queue:${run.workflowSlug}`) return Promise.resolve()
  const slug = run.workflowSlug
  return serial(slug, async () => {
    const queue = await readQueue(slug)
    const item = queue?.items.find(i => i.runId === run.id && i.status === 'running')
    if (!queue || !item) return
    item.endedAt = Date.now()
    if (run.status === 'completed') {
      item.status = 'done'
      item.note = undefined
    } else {
      item.status = 'stopped'
      item.note = `run ended ${run.status}`
      queue.enabled = false
      queue.pausedReason = `${item.prompt}: run ${run.id.slice(0, 8)} ended ${run.status}. Turn the queue on again to go on with the next item.`
    }
    await writeQueue(slug, queue)
    log.info('workflow queue item settled', { workflow: slug, runId: run.id, status: item.status })
    if (queue.enabled) await startNextLocked(slug)
  })
}
