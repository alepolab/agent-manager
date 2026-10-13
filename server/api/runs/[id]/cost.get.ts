import { getRun } from '../../../utils/workflowRunStore.ts'
import { summarizeRunCost } from '../../../utils/costReport.ts'
import { requireRunAccess } from '../../../utils/runAccess'

/** One run's cost, per step and totalled. Read-only - see costReport.ts for
 *  how an unmeasured step or an unpriced model is handled (excluded, never
 *  guessed) and what `totals.complete` means. */
export default defineEventHandler(async (event) => {
  // Yours, your team's, or - unplaced - anyone's: see runAccess.ts.
  await requireRunAccess(event)
  const run = await getRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return summarizeRunCost(run)
})
