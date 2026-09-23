import { getRun } from '../../../utils/workflowRunStore'
import { continueRun } from '../../../utils/workflowRunner'
import { applyReviewDecisions, ReviewError } from '../../../utils/runReview'
import { currentUser, requireCapability } from '../../../utils/session'
import { appendRunAudit } from '../../../utils/runArtifacts'
import type { ReviewDecision } from '../../../../shared/types/runReview'

/** Runs whose decisions are being applied right now. See the handler. */
const applying = new Set<string>()

/**
 * Records what an operator decided about the entries a run is gated on, then
 * resumes it.
 *
 * `applying` is the double-submit guard, and it has to be one: the status
 * check inside applyReviewDecisions reads the run object fetched here, and
 * what actually clears `awaiting_review` is the resume at the BOTTOM of this
 * handler — after the Jira round-trips have already filed every approved
 * entry. Two submissions overlapping that window both passed the check and
 * both filed, which is the duplicate-ticket pair this gate exists to prevent.
 * jiraCreate's `already` guard does not close it either: that keys on the
 * jira_key written back to the artifact at the end, which neither caller has
 * written yet. It closes the sequential race, not the concurrent one.
 *
 * The panel disables its own button, so what reaches here is two tabs, or a
 * request the client retried after a timeout.
 */
export default defineEventHandler(async (event) => {
  // Deciding which entries to act on IS answering the gate.
  await requireCapability(event, 'answerGate')
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ decisions?: ReviewDecision[], note?: string }>(event)
  const run = await getRun(id)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })

  // Claimed synchronously, before the first await below, the same way
  // workflowRunner's `starting` set claims a workspace. Process-local, like
  // every other claim here: pid, bootId and the run lock all already assume
  // one server process per config directory.
  if (applying.has(id)) {
    throw createError({ statusCode: 409, message: 'A decision for this run is already being applied' })
  }
  applying.add(id)

  try {
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
    // The per-entry decisions are in review-decisions.json; this line puts the
    // review in order with everything else a person did to the run.
    await appendRunAudit(id, {
      type: 'review',
      actor: user?.login,
      stepId: run.question?.stepId,
      text: [`${result.approved} approved, ${result.skipped} skipped`, body?.note?.trim()].filter(Boolean).join(' - '),
    })
    return { ...result, run: resumed }
  } finally {
    applying.delete(id)
  }
})
