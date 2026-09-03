import { getRun } from '../../utils/workflowRunStore'
export default defineEventHandler(async (event) => {
  const run = await getRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
