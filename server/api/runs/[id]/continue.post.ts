import { continueRun } from '../../../utils/workflowRunner'
export default defineEventHandler(async (event) => {
  const run = await continueRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
