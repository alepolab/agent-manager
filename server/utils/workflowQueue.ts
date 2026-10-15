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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveClaudePath, safeSegment } from './claudeDir.ts'
import { getRun, loadWorkflowSteps, toWorkflowLike } from './workflowRunStore.ts'
import { startOrQueue } from './workflowRunner.ts'
import { resolveParameters, RESERVED_PARAM_PROJECT_DIR } from '../../shared/utils/workflowParameters.ts'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '~~/shared/types/run'

const log = createLogger('runner')
const exec = promisify(execFile)

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
  /** The lane it ran in, when the queue has lanes. */
  lane?: string
}

/**
 * A lane runs one item at a time with its own parameters laid over the
 * defaults (and under the item's), e.g. its own CRM stack and checkout. A
 * queue with lanes runs one item per lane at once; without, one item at a time.
 */
export interface QueueLane { name: string, parameters?: Record<string, string> }

/**
 * A command run before each item starts, in the item's projectDir, with every
 * resolved parameter in the environment as `PARAM_<name>`. It answers "what of
 * this item is still left to do": empty output marks the item done without a
 * run (nothing left), any other output becomes the value of `parameter` for the
 * run (e.g. the files still to port). A non-zero exit pauses the queue.
 */
export interface QueuePrecheck { command: string, parameter: string }

export interface WorkflowQueue {
  /** Off: nothing new starts. A run already going finishes and is recorded. */
  enabled: boolean
  /** Why the queue turned itself off, shown until someone turns it on again. */
  pausedReason?: string
  defaults: {
    parameters?: Record<string, string>
    autoRun?: boolean
    startedBy?: string
    precheck?: QueuePrecheck
    /** With lanes: a parameter whose first path segment two lanes never run at once (e.g. robotFolder,
     *  so sibling folders that share data or build on each other stay one after another). */
    laneKey?: string
  }
  lanes?: QueueLane[]
  items: QueueItem[]
}

const ONE_LANE: QueueLane[] = [{ name: 'main' }]

function laneOf(queue: WorkflowQueue, item: QueueItem): string {
  return item.lane ?? queue.lanes?.[0]?.name ?? ONE_LANE[0]!.name
}

function laneArea(queue: WorkflowQueue, item: QueueItem): string | undefined {
  const key = queue.defaults.laneKey
  return key ? (item.parameters?.[key] ?? queue.defaults.parameters?.[key])?.split('/')[0] : undefined
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

/**
 * Fill every free lane with its next pending item, unless the queue is off.
 * A lane is free when none of its items is running. With `laneKey`, a lane
 * skips items whose area another lane is running. Returns the first item
 * started, if any.
 */
async function startNextLocked(slug: string): Promise<QueueItem | null> {
  const queue = await readQueue(slug)
  if (!queue?.enabled) return null
  const lanes = queue.lanes?.length ? queue.lanes : ONE_LANE
  let first: QueueItem | null = null
  for (const lane of lanes) {
    if (queue.items.some(i => i.status === 'running' && laneOf(queue, i) === lane.name)) continue
    for (;;) {
      if (!queue.enabled) return first
      const busy = new Set(queue.items.filter(i => i.status === 'running').map(i => laneArea(queue, i)).filter(Boolean))
      const item = queue.items.find(i => i.status === 'pending' && !busy.has(laneArea(queue, i)))
      if (!item) {
        if (!queue.items.some(i => i.status === 'pending' || i.status === 'running')) log.info('workflow queue finished', { workflow: slug })
        break
      }
      const started = await startItem(slug, queue, item, queue.lanes?.length ? lane : undefined)
      if (started === 'skipped') continue
      first ??= started
      break
    }
  }
  return first
}

async function runPrecheck(check: QueuePrecheck, values: Record<string, string>): Promise<string> {
  const env = { ...process.env }
  for (const [k, v] of Object.entries(values)) env[`PARAM_${k}`] = v
  const { stdout } = await exec('bash', ['-c', check.command], { cwd: values[RESERVED_PARAM_PROJECT_DIR], env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

async function startItem(slug: string, queue: WorkflowQueue, item: QueueItem, lane?: QueueLane): Promise<QueueItem | null | 'skipped'> {
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
  const supplied = { ...(queue.defaults.parameters ?? {}), ...(lane?.parameters ?? {}), ...(item.parameters ?? {}) }
  const { values, missing } = resolveParameters(workflow.parameters, supplied)
  if (missing.length) return pause(`no value for ${missing.join(', ')}`)
  const check = queue.defaults.precheck
  if (check?.command) {
    let left: string
    try {
      left = await runPrecheck(check, values)
    } catch (err) {
      return pause(`the check of what is left failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 600))
    }
    if (!left) {
      item.status = 'done'
      item.note = 'nothing left to do: the check found it already done, no run made'
      item.endedAt = Date.now()
      await writeQueue(slug, queue)
      log.info('workflow queue item already done', { workflow: slug, prompt: item.prompt })
      return 'skipped'
    }
    if (left !== values[check.parameter]) item.note = `${check.parameter} set by the check to: ${left}`.slice(0, 2000)
    values[check.parameter] = left
  }
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
    if (lane) item.lane = lane.name
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
    // A run that was stopped (its item marked stopped) and then restarted from its step can still
    // complete; its item is then done, though the queue stays as a person left it.
    const item = queue?.items.find(i => i.runId === run.id
      && (i.status === 'running' || (i.status === 'stopped' && run.status === 'completed')))
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

const SETTLED = ['completed', 'failed', 'stopped']

/**
 * After a restart: the publish that should have moved a queue on may never
 * have happened (the process died between the run settling and the queue
 * write), and an enabled queue with nothing running has no event left to wake
 * it. Settles every `running` item whose run has ended or vanished, then starts
 * the next item of every enabled queue. A run still interrupted or waiting on
 * a person is left alone: its own ending moves the queue.
 */
export async function reconcileQueues(): Promise<string[]> {
  const dir = resolveClaudePath('workflow-queues')
  if (!existsSync(dir)) return []
  const lines: string[] = []
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.json'))) {
    const slug = file.slice(0, -'.json'.length)
    const queue = await readQueue(slug).catch(() => null)
    if (!queue) continue
    for (const item of queue.items.filter(i => i.status === 'running' && i.runId)) {
      const run = await getRun(item.runId!)
      if (!run) {
        await serial(slug, async () => {
          const q = await readQueue(slug)
          const it = q?.items.find(i => i.runId === item.runId && i.status === 'running')
          if (!q || !it) return
          it.status = 'stopped'
          it.note = `run ${item.runId!.slice(0, 8)} no longer exists`
          it.endedAt = Date.now()
          q.enabled = false
          q.pausedReason = `${it.prompt}: its run no longer exists. Turn the queue on again to go on with the next item.`
          await writeQueue(slug, q)
        })
        lines.push(`${slug}: ${item.prompt} lost its run; queue paused`)
      } else if (SETTLED.includes(run.status)) {
        await advanceQueue(run)
        lines.push(`${slug}: ${item.prompt} settled as ${run.status} while the server was down`)
      }
    }
    const started = await startNextInQueue(slug)
    if (started) lines.push(`${slug}: started ${started.prompt}`)
  }
  return lines
}
