import { requireCapability } from '../../utils/session'
import { removeTask } from '../../utils/taskQueue'

/** Take a task out of the queue. Refused while it is running. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'startRun')
  const id = getRouterParam(event, 'id')!
  let result: Awaited<ReturnType<typeof removeTask>>
  try {
    result = await removeTask(id)
  } catch (err) {
    throw createError({ statusCode: 409, message: err instanceof Error ? err.message : String(err) })
  }
  if (!result) throw createError({ statusCode: 404, message: `no task ${id} in the queue` })
  return result
})
