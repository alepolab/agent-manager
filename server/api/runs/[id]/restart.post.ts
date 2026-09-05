import { restartRun, RestartError } from '../../../utils/workflowRunner'
import { currentUser } from '../../../utils/session'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ stepId?: string, note?: string }>(event)
  if (!body?.stepId) throw createError({ statusCode: 400, message: 'stepId is required' })
  try {
    const user = await currentUser(event)
    return await restartRun(id, body.stepId, typeof body.note === 'string' ? body.note : undefined, user?.login)
  } catch (err) {
    if (err instanceof RestartError) throw createError({ statusCode: err.statusCode, message: err.message, data: err.data })
    throw err
  }
})
