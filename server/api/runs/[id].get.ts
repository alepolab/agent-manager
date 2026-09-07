import { getRun, saveRun } from '../../utils/workflowRunStore'
import { backfillSessions } from '../../utils/runSessions'
export default defineEventHandler(async (event) => {
  const run = await getRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  // Runs recorded before steps carried their session get it from the transcripts
  // on disk, once, so their agents can be asked questions on /cli like any other.
  if (!['running', 'paused'].includes(run.status) && await backfillSessions(run)) await saveRun(run)
  return run
})
