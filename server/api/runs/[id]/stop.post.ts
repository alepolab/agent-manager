import { stopRun } from '../../../utils/workflowRunner'
import { requireCapability } from '../../../utils/session'
export default defineEventHandler(async (event) => {
  // Ending a run is driving the pipeline, not reviewing it: a reviewer who
  // disagrees at a gate sends the work back, and only an operator stops it.
  await requireCapability(event, 'runEngine')
  const run = await stopRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
