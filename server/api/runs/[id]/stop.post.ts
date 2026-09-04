import { stopRun } from '../../../utils/workflowRunner'
export default defineEventHandler(async (event) => {
  const run = await stopRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
