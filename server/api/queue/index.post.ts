import { requireCapability } from '../../utils/session'
import { setQueue } from '../../utils/taskQueue'
import type { QueueTask } from '../../../shared/types/queue'

/** Replace the queue with a whole project's work. Operator-only: it schedules spend. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const body = await readBody<{ project?: string, tasks?: Omit<QueueTask, 'status' | 'queuedAt'>[] }>(event)
  if (!Array.isArray(body?.tasks) || !body.tasks.length) {
    throw createError({ statusCode: 400, message: 'tasks must be a non-empty array' })
  }
  const seen = new Set<string>()
  for (const t of body.tasks) {
    if (!t?.id?.trim() || !t?.title?.trim()) throw createError({ statusCode: 400, message: 'every task needs an id and a title' })
    if (seen.has(t.id)) throw createError({ statusCode: 400, message: `duplicate task id ${t.id}` })
    seen.add(t.id)
  }
  // A dependency on a task that is not in the queue can never be satisfied, so
  // the task behind it would wait for ever with nothing on screen to say why.
  for (const t of body.tasks) {
    for (const d of t.deps ?? []) {
      if (!seen.has(d)) throw createError({ statusCode: 400, message: `${t.id} depends on ${d}, which is not in this queue` })
    }
  }
  try {
    return await setQueue(body.project?.trim() || 'Project', body.tasks)
  } catch (err) {
    throw createError({ statusCode: 409, message: err instanceof Error ? err.message : String(err) })
  }
})
