import { requireCapability } from '../../utils/session'
import { setTaskStatus, readQueue } from '../../utils/taskQueue'
import type { QueueTask } from '../../../shared/types/queue'

const ALLOWED: QueueTask['status'][] = ['pending', 'skipped', 'done']

/** Retry a task, or take it out of the queue. Only the two a person decides. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'startRun')
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ status?: QueueTask['status'], note?: string }>(event)
  if (!body?.status || !ALLOWED.includes(body.status)) {
    throw createError({ statusCode: 400, message: `status must be one of ${ALLOWED.join(', ')} — the rest are set by the run` })
  }
  // `done` is for work a person did: the four data audits, a decision, a UAT
  // walkthrough. Tasks like those are `skipped` from birth because no agent can
  // run them, and the tasks that depend on them would otherwise wait for ever
  // on a dependency nothing could ever satisfy. A task with a run of its own is
  // graded by that run, never by hand.
  if (body.status === 'done') {
    const q = await readQueue()
    const existing = q.tasks.find(t => t.id === id)
    if (existing?.runId) {
      throw createError({ statusCode: 409, message: `${id} has a run; its outcome comes from run ${existing.runId.slice(0, 8)}, not from this call.` })
    }
  }
  const task = await setTaskStatus(id, body.status, body.note)
  if (!task) throw createError({ statusCode: 404, message: `no task ${id} in the queue` })
  return task
})
