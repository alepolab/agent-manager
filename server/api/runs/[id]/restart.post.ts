import { restartRun, RestartError } from '../../../utils/workflowRunner'
import { appendRunAudit } from '../../../utils/runArtifacts'
import { currentUser, requireCapability } from '../../../utils/session'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'runEngine')
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ stepId?: string, note?: string }>(event)
  if (!body?.stepId) throw createError({ statusCode: 400, message: 'stepId is required' })
  try {
    const user = await currentUser(event)
    const note = typeof body.note === 'string' ? body.note : undefined
    const run = await restartRun(id, body.stepId, note, user?.login)
    await appendRunAudit(id, { type: 'restart', actor: user?.login, stepId: body.stepId, text: note?.trim() || undefined })
    return run
  } catch (err) {
    if (err instanceof RestartError) throw createError({ statusCode: err.statusCode, message: err.message, data: err.data })
    throw err
  }
})
