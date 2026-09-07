import { getRun, saveRun } from '../../../utils/workflowRunStore'

/** Clear a settled run from the attention queue. It stays in history; nothing is deleted. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const run = await getRun(id)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  if (run.status === 'running' || run.status === 'paused') throw createError({ statusCode: 409, message: 'A live run cannot be dismissed; stop it first' })
  run.dismissed = true
  await saveRun(run)
  return run
})
