import { continueRun, ApprovalNeedsReason } from '../../../utils/workflowRunner'
import { requireCapability } from '../../../utils/session'

/** Continue a paused run. `note` reaches the step being approved, or whichever step starts next. */
export default defineEventHandler(async (event) => {
  // The gate itself: a reviewer's whole job, and a manager's non-job.
  await requireCapability(event, 'answerGate')
  const body = await readBody<{ note?: string }>(event).catch(() => ({} as { note?: string }))
  let run
  try {
    run = await continueRun(getRouterParam(event, 'id')!, body?.note)
  } catch (err) {
    // An owner-gated run approved with no reason is a 400 the reviewer can act
    // on, not a 500 that reads as the app breaking.
    if (err instanceof ApprovalNeedsReason) throw createError({ statusCode: 400, message: err.message })
    throw err
  }
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
