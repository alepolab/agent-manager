import { getRun } from '../../../utils/workflowRunStore'
import { continueRun } from '../../../utils/workflowRunner'
import { applyReviewDecisions, ReviewError } from '../../../utils/runReview'
import { currentUser } from '../../../utils/session'
import type { ReviewDecision } from '../../../../shared/types/runReview'

/**
 * Records what an operator decided about the entries a run is gated on, then
 * resumes it.
 *
 * The status check inside applyReviewDecisions is also the double-submit guard:
 * the resume below moves the run off awaiting_review before anything else can
 * land, so a second submission cannot file the same tickets twice or re-filter
 * an already-filtered artifact.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ decisions?: ReviewDecision[], note?: string }>(event)
  const run = await getRun(id)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })

  const user = await currentUser(event)
  let result
  try {
    result = await applyReviewDecisions(run, body?.decisions ?? [], user?.login)
  } catch (err) {
    if (err instanceof ReviewError) throw createError({ statusCode: err.statusCode, message: err.message })
    throw err
  }

  // Approving nothing must not grant the step's approval. l.approved waives the
  // step's runWhen condition, so granting it here would run the step over the
  // artifact just emptied — the approval would override the very decision it is
  // supposed to carry out. Withheld, the condition is re-tested and the step
  // (with everything downstream reading the same file) is skipped by the
  // ordinary path, with the ordinary sentence naming the file.
  const resumed = await continueRun(id, body?.note, { grantApproval: result.approved > 0 })
  return { ...result, run: resumed }
})
