import { getRun, saveRun } from '../../../utils/workflowRunStore'
import { isLiveStatus } from '../../../../shared/types/run.ts'
import { appendRunAudit } from '../../../utils/runArtifacts'
import { currentUser, requireCapability } from '../../../utils/session'

/**
 * Clear a settled run from the attention queue. It stays in history; nothing is deleted.
 *
 * `answerGate`: the queue belongs to the people who act on it, and clearing an
 * item is acting on it. This route carried no check at all, so a manager — who
 * holds `answerGate: false` precisely because they change nothing — could mutate
 * a run record from the dashboard.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await requireCapability(event, 'answerGate')
  const run = await getRun(id)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  if (isLiveStatus(run.status)) throw createError({ statusCode: 409, message: 'A live run cannot be dismissed; stop it first' })
  run.dismissed = true
  await saveRun(run)
  await appendRunAudit(id, { type: 'dismiss', actor: (await currentUser(event))?.login })
  return run
})
