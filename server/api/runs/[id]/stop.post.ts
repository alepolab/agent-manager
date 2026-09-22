import { stopRun } from '../../../utils/workflowRunner'
import { getRun } from '../../../utils/workflowRunStore'
import { appendRunAudit } from '../../../utils/runArtifacts'
import { currentUser, requireCapability } from '../../../utils/session'

export default defineEventHandler(async (event) => {
  // Ending a run is driving the pipeline, not reviewing it: a reviewer who
  // disagrees at a gate sends the work back, and only an operator stops it.
  await requireCapability(event, 'runEngine')
  const id = getRouterParam(event, 'id')!
  const before = await getRun(id)
  const run = await stopRun(id)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  if (before && before.status !== run.status) {
    await appendRunAudit(id, { type: 'stop', actor: (await currentUser(event))?.login })
  }
  return run
})
