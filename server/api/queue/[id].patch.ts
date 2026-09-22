import { requireCapability } from '../../utils/session'
import { setTaskStatus } from '../../utils/taskQueue'
import type { QueueTask } from '../../../shared/types/queue'

const ALLOWED: QueueTask['status'][] = ['pending', 'skipped']

/** Retry a task, or take it out of the queue. Only the two a person decides. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'startRun')
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ status?: QueueTask['status'], note?: string }>(event)
  if (!body?.status || !ALLOWED.includes(body.status)) {
    throw createError({ statusCode: 400, message: `status must be one of ${ALLOWED.join(', ')} — the rest are set by the run` })
  }
  const task = await setTaskStatus(id, body.status, body.note)
  if (!task) throw createError({ statusCode: 404, message: `no task ${id} in the queue` })
  return task
})
