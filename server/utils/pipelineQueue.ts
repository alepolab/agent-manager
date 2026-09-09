/**
 * How many child runs a `triggerWorkflow` step may have in flight at once, and
 * where the rest wait for a slot.
 *
 * A scan that finds twenty things would otherwise dispatch twenty pipelines at
 * once: twenty clones, twenty agent budgets, one machine. The cap is the whole
 * reason this file exists.
 *
 * What is in flight is COUNTED FROM THE RUNS THEMSELVES, never tracked in this
 * file. The agent this step replaces kept its own `active` array and needed a
 * 24-hour "stale" rule to cope with the array drifting from reality - entries
 * for runs that had long finished, holding slots nobody was using. Runs are
 * already persisted and already have a status; deriving the count from them
 * cannot drift, so there is nothing to expire. Only the WAITING items live
 * here, and an item leaves the moment it starts.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { agentRunsRoot } from './runArtifacts.ts'
import { listRuns } from './workflowRunStore.ts'
import { createLogger } from './log.ts'

// The runner's own namespace: this is work the runner does, not a subsystem of
// its own, and Namespace is a closed union in log.ts.
const log = createLogger('runner')

/** Runs one `triggerWorkflow` step asked for, whether or not they have started yet. */
export interface QueuedDispatch {
  /** The entry this came from - a ticket key, or its position. Names the child's workspace. */
  key: string
  /** The workflow the child run starts. */
  slug: string
  /** The child's opening prompt, built by the step from the entry. */
  initialPrompt: string
  /** The child's own checkout, distinct per child: see the runner's dispatch branch. */
  projectDir: string
  startedBy?: string
  parentRunId: string
  ticketKey?: string
  /** The child's own declared inputs, already resolved against the parent's
   *  values by the dispatch step. Absent on an item queued before this field
   *  existed, which readQueue tolerates the way it tolerates any other
   *  older entry. */
  parameters?: Record<string, string>
  queuedAt: number
}

/** Starts one child run. Passed in rather than imported, so this module never
 *  depends on the runner that calls it. */
export type ChildStarter = (item: QueuedDispatch) => Promise<{ id: string }>

export interface DispatchOutcome {
  item: QueuedDispatch
  /** The child run, when it started now. */
  runId?: string
  /** 1-based place in the queue, when it did not. */
  position?: number
  /** Why it neither started nor queued. */
  error?: string
}

/** Concurrent child pipelines allowed. Two is what the dispatcher agent this
 *  replaces claimed to enforce, and a sane default for one machine. */
export function maxConcurrentPipelines(): number {
  const configured = Number(process.env.AGENT_MAX_CONCURRENT_PIPELINES)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 2
}

const queueFile = () => join(agentRunsRoot(), 'pipeline-queue.json')

/** Serialises this process's reads and writes of the queue file, the way
 *  publish() serialises a run's. Two steps dispatching at once would otherwise
 *  each read the same queue and write back over the other's additions. */
let chain: Promise<unknown> = Promise.resolve()
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.catch(() => {}).then(fn)
  chain = next.catch(() => {})
  return next
}

async function readQueue(): Promise<QueuedDispatch[]> {
  const file = queueFile()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // A corrupt queue must not wedge every future dispatch. Losing the waiting
    // items is bad; refusing to dispatch anything ever again is worse, and the
    // warning says which happened.
    log.warn('pipeline queue is unreadable; continuing with an empty queue', { file })
    return []
  }
}

async function writeQueue(items: QueuedDispatch[]): Promise<void> {
  const file = queueFile()
  await mkdir(dirname(file), { recursive: true })
  // Written aside and renamed: a half-written queue read by the next drain
  // would lose every item after the truncation point.
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(items, null, 2))
  await rename(tmp, file)
}

/** Child pipelines currently occupying a slot: live runs something dispatched. */
async function inFlight(): Promise<number> {
  const runs = await listRuns()
  return runs.filter(r => r.parentRunId && (r.status === 'running' || r.status === 'paused')).length
}

/**
 * Starts what fits under the cap now and queues the rest, in the order given.
 *
 * A start that throws is reported against its own item and does not stop the
 * others: one unstartable ticket must not strand the rest of the batch.
 */
export function dispatchOrQueue(items: QueuedDispatch[], start: ChildStarter): Promise<DispatchOutcome[]> {
  return serialised(async () => {
    const queue = await readQueue()
    const outcomes: DispatchOutcome[] = []
    let slots = Math.max(0, maxConcurrentPipelines() - await inFlight())

    for (const item of items) {
      // Anything already waiting goes first: a queue that lets later arrivals
      // overtake is not a queue.
      if (slots > 0 && !queue.length) {
        try {
          const { id } = await start(item)
          slots--
          outcomes.push({ item, runId: id })
          continue
        } catch (err) {
          outcomes.push({ item, error: err instanceof Error ? err.message : String(err) })
          continue
        }
      }
      queue.push(item)
      outcomes.push({ item, position: queue.length })
    }

    await writeQueue(queue)
    return outcomes
  })
}

/**
 * Starts whatever now fits, oldest first. Called whenever a run settles, so a
 * finished pipeline hands its slot to the next ticket.
 *
 * Returns how many it started, which is 0 on the overwhelmingly common path
 * (a settling run with nothing waiting behind it).
 */
export function drainPipelineQueue(start: ChildStarter): Promise<number> {
  return serialised(async () => {
    const queue = await readQueue()
    if (!queue.length) return 0

    let slots = Math.max(0, maxConcurrentPipelines() - await inFlight())
    let started = 0
    while (slots > 0 && queue.length) {
      const item = queue[0]!
      try {
        const { id } = await start(item)
        log.info('queued pipeline started', { key: item.key, slug: item.slug, runId: id, parentRunId: item.parentRunId })
        started++
        slots--
      } catch (err) {
        // Dropped, not retried forever: a ticket whose workflow no longer
        // exists would otherwise be retried on every settling run for the life
        // of the instance. The warning names it so a person can start it.
        log.warn('queued pipeline could not be started; dropping it', {
          key: item.key, slug: item.slug, error: err instanceof Error ? err.message : String(err),
        })
      }
      queue.shift()
    }

    await writeQueue(queue)
    return started
  })
}

/** What is waiting, for the run page and for tests. */
export function peekPipelineQueue(): Promise<QueuedDispatch[]> {
  return serialised(readQueue)
}
