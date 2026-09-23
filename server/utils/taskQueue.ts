import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import { listRuns, getRun, findRunInWorkspace } from './workflowRunStore.ts'
import { capacityFor } from './runCapacity.ts'
import { runWorkspace } from './workspace.ts'
import type { QueueTask, TaskQueue, DispatchResult } from '../../shared/types/queue.ts'

/**
 * The project's work, and the rules for turning the next piece of it into a run.
 *
 * Deliberately NOT a second runner. It owns no execution: it decides which task
 * is next and asks the existing `startRun` for one run, then reads that run's
 * status back. A queue that tracked progress of its own would drift from the
 * runs it claimed to describe, and the run store is already the truth.
 */

const queuePath = () => resolveClaudePath('task-queue.json')

const EMPTY: TaskQueue = { project: '', tasks: [], createdAt: 0, updatedAt: 0 }

export async function readQueue(): Promise<TaskQueue> {
  const p = queuePath()
  if (!existsSync(p)) return { ...EMPTY }
  try {
    const q = JSON.parse(await readFile(p, 'utf-8')) as TaskQueue
    return q && Array.isArray(q.tasks) ? q : { ...EMPTY }
  } catch {
    // A corrupt queue reads as empty rather than throwing: it must not be able
    // to take the instance's pages down with it.
    return { ...EMPTY }
  }
}

async function writeQueue(q: TaskQueue): Promise<void> {
  const p = queuePath()
  await mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ ...q, updatedAt: Date.now() }, null, 2))
  await rename(tmp, p)
}

/** Replace the whole queue. Refuses while anything is running, so a live run is never orphaned. */
export async function setQueue(project: string, tasks: Omit<QueueTask, 'status' | 'queuedAt'>[], owner?: string): Promise<TaskQueue> {
  const current = await readQueue()
  const live = current.tasks.filter(t => t.status === 'running')
  if (live.length) {
    throw new Error(`${live.length} task(s) are running (${live.map(t => t.id).join(', ')}). Let them settle or stop their runs before replacing the queue.`)
  }
  const now = Date.now()
  const next: TaskQueue = {
    project,
    ...(owner ? { owner } : current.owner ? { owner: current.owner } : {}),
    createdAt: current.createdAt || now,
    updatedAt: now,
    tasks: tasks.map(t => ({
      ...t,
      // A task with nothing to dispatch is `skipped` from birth, with the
      // reason it carries. Listing it as `pending` would promise a run that is
      // never coming.
      status: t.projectDir && t.detail ? 'pending' : 'skipped',
      ...(t.projectDir && t.detail ? {} : { note: t.note || 'not a repository change — human or environment work' }),
      queuedAt: now,
    } as QueueTask)),
  }
  await writeQueue(next)
  return next
}

/**
 * Bring task status into line with the runs that own it.
 *
 * A task is `running` only for as long as its run is. Nothing else moves a
 * task out of `running`, so a run that failed while nobody was looking does
 * not leave the queue claiming to be busy for ever — which would also hold the
 * capacity slot shut against every task behind it.
 */
export async function reconcile(): Promise<TaskQueue> {
  const q = await readQueue()
  let changed = false
  for (const t of q.tasks) {
    if (t.status !== 'running' || !t.runId) continue
    const run = await getRun(t.runId)
    if (!run) {
      t.status = 'failed'
      t.note = 'its run record is gone'
      t.endedAt = Date.now()
      changed = true
      continue
    }
    if (run.status === 'running' || run.status === 'paused') continue
    t.status = run.status === 'completed' ? 'done' : 'failed'
    t.note = run.status === 'completed' ? undefined : `run ${run.status}${run.error ? `: ${run.error.slice(0, 200)}` : ''}`
    t.endedAt = run.endedAt ?? Date.now()
    changed = true
  }
  if (changed) await writeQueue(q)
  return q
}

/** The group a task belongs to. Its own id when it names none. */
export const groupOf = (t: QueueTask): string => t.group || t.module || t.id

/** The next tasks that could start, in pull order. */
export function eligible(q: TaskQueue): QueueTask[] {
  const doneIds = new Set(q.tasks.filter(t => t.status === 'done').map(t => t.id))
  return q.tasks
    .filter(t => t.status === 'pending' && t.deps.every(d => doneIds.has(d)))
    .sort((a, b) => a.order - b.order)
}

export type StartRunFn = (tasks: QueueTask[]) => Promise<{ id: string }>

/**
 * Start as many eligible tasks as the instance will carry, in order.
 *
 * Every refusal is recorded against the task rather than thrown: a queue that
 * stopped at the first task it could not start would hide the nine behind it
 * that were ready, and "why is nothing running" is the question this whole
 * feature exists to answer.
 */
export async function dispatch(startRun: StartRunFn): Promise<DispatchResult> {
  const q = await reconcile()
  const result: DispatchResult = { started: [], held: {} }

  for (const task of eligible(q)) {
    const runs = await listRuns()
    const cap = capacityFor(runs)
    if (!cap.ok) {
      // Everything still pending is held by the same ceiling; say so once per
      // task so the page can explain each row without guessing.
      for (const rest of eligible(q)) if (!result.started.includes(rest.id)) result.held[rest.id] = cap.reason!
      break
    }

    // The workspace lock, checked here so a task that cannot start yields to
    // the next one instead of consuming the dispatch attempt. Twelve tasks
    // against one repository serialise; they do not deadlock the ten against
    // other repositories.
    const workspace = runWorkspace({ projectDir: task.projectDir })
    // Through the store, not by comparing paths: a live run's projectDir is
    // its WORKTREE (`<repo>@<branch>`), never the checkout it was started
    // against, so a string compare never matched and two tasks on one
    // repository both started. findRunInWorkspace resolves both sides to the
    // clone's git common directory, which is the identity that matters.
    const busy = await findRunInWorkspace(workspace)
    if (busy) {
      result.held[task.id] = `${task.module ?? workspace} is busy with run ${busy.id.slice(0, 8)}`
      continue
    }

    // Everything eligible in the same group goes in one run. They share a
    // checkout by construction, so they could never have run concurrently
    // anyway — one run doing all of them is the difference between the
    // group's total time and the sum of its parts.
    const group = eligible(q).filter(t => groupOf(t) === groupOf(task))
    try {
      const run = await startRun(group)
      for (const member of group) {
        member.status = 'running'
        member.runId = run.id
        member.startedAt = Date.now()
        member.note = undefined
        result.started.push(member.id)
      }
      await writeQueue(q)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.held[task.id] = message
      // A task that cannot start is left pending on purpose: the cause is
      // usually transient (a busy checkout, a capacity ceiling) and marking it
      // failed would take it out of the queue for good.
    }
  }
  return result
}

/**
 * Take a task out of the queue for good.
 *
 * `skipped` was the only way to shelve one, and it is the wrong shape for a
 * task that should never have been queued: a skipped task still counts as
 * settled, so anything waiting on it is released and runs against a dependency
 * nobody ever satisfied. Removal takes it out of the graph entirely, and the
 * tasks that depended on it hold instead - which is the honest state.
 *
 * A running task is refused: its run is live, and deleting the row would leave
 * that run with nothing to report back to.
 */
export async function removeTask(id: string): Promise<{ removed: QueueTask, orphaned: string[] } | null> {
  const q = await readQueue()
  const task = q.tasks.find(t => t.id === id)
  if (!task) return null
  if (task.status === 'running') {
    throw new Error(`${id} is running as ${task.runId?.slice(0, 8) ?? 'a run'}. Stop that run first, then remove it.`)
  }
  q.tasks = q.tasks.filter(t => t.id !== id)
  // Named, not repaired. Rewriting other tasks' deps to route around a removed
  // one is a guess about intent; saying which tasks now wait on something that
  // is gone lets the person make that call.
  const orphaned = q.tasks.filter(t => t.deps?.includes(id)).map(t => t.id)
  await writeQueue(q)
  return { removed: task, orphaned }
}

/** Move a single task out of the way, or back into the queue. */
export async function setTaskStatus(id: string, status: QueueTask['status'], note?: string): Promise<QueueTask | null> {
  const q = await readQueue()
  const task = q.tasks.find(t => t.id === id)
  if (!task) return null
  task.status = status
  task.note = note
  if (status === 'pending') { task.runId = undefined; task.startedAt = undefined; task.endedAt = undefined }
  await writeQueue(q)
  return task
}
