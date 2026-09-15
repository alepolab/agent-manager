import { continueRun } from '../../../utils/workflowRunner'
import { requireCapability } from '../../../utils/session'

/** Continue a paused run. `note` reaches the step being approved, or whichever step starts next. */
export default defineEventHandler(async (event) => {
  // The gate itself: a reviewer's whole job, and a manager's non-job.
  await requireCapability(event, 'answerGate')
  const body = await readBody<{ note?: string }>(event).catch(() => ({} as { note?: string }))
  const run = await continueRun(getRouterParam(event, 'id')!, body?.note)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
