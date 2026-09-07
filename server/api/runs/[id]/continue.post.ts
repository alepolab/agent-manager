import { continueRun } from '../../../utils/workflowRunner'

/** Continue a paused run. `note` reaches the step being approved, or whichever step starts next. */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ note?: string }>(event).catch(() => ({} as { note?: string }))
  const run = await continueRun(getRouterParam(event, 'id')!, body?.note)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
