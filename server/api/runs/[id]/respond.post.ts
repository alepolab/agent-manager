import { respondToRun } from '../../../utils/workflowRunner'
import '../../../utils/agentCaller'
export default defineEventHandler(async (event) => {
  const body = await readBody<{ reply: string }>(event)
  if (!body?.reply?.trim()) throw createError({ statusCode: 400, message: 'reply is required' })
  const run = await respondToRun(getRouterParam(event, 'id')!, body.reply)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
