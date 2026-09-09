import { getRun, saveRun } from '../../utils/workflowRunStore'
import { backfillSessions } from '../../utils/runSessions'
import { isLiveStatus } from '../../../shared/types/run.ts'
export default defineEventHandler(async (event) => {
  const run = await getRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  // Runs recorded before steps carried their session get it from the transcripts
  // on disk, once, so their agents can be asked questions on /cli like any other.
  //
  // isLiveStatus, so a `queued` run is left alone: this is a GET, it can be
  // issued at any moment by anything watching the run, and writing a copy read
  // before the queue launched the run would put a stale record back over the
  // launch.
  if (!isLiveStatus(run.status) && await backfillSessions(run)) await saveRun(run)
  return run
})
