import { respondToRun } from '../../../utils/workflowRunner'
import { getRun } from '../../../utils/workflowRunStore'
import { appendRunAudit } from '../../../utils/runArtifacts'
import { currentUser } from '../../../utils/session'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ reply: string }>(event)
  if (!body?.reply?.trim()) throw createError({ statusCode: 400, message: 'reply is required' })
  const before = await getRun(id)
  const run = await respondToRun(id, body.reply)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  if (before && before.status !== run.status) {
    await appendRunAudit(id, { type: 'answer', actor: (await currentUser(event))?.login, stepId: before.currentStepIds[0], text: body.reply })
  }
  return run
})
