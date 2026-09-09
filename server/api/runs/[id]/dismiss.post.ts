import { getRun, saveRun } from '../../../utils/workflowRunStore'
import { isLiveStatus } from '../../../../shared/types/run.ts'

/** Clear a settled run from the attention queue. It stays in history; nothing is deleted. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const run = await getRun(id)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  if (isLiveStatus(run.status)) throw createError({ statusCode: 409, message: 'A live run cannot be dismissed; stop it first' })
  run.dismissed = true
  await saveRun(run)
  return run
})
