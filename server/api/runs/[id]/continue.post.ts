import { continueRun, RestartError, ApprovalNeedsReason } from '../../../utils/workflowRunner'
import { getRun, saveRun } from '../../../utils/workflowRunStore'
import { appendRunAudit } from '../../../utils/runArtifacts'
import { requireCapability, currentUser } from '../../../utils/session'
import { recordDecision } from '../../../../shared/utils/runDecisions'
import { requireGateRole } from '../../../utils/gateRole'

/** Continue a paused run. `note` reaches the step being approved, or whichever step starts next. */
export default defineEventHandler(async (event) => {
  // The gate itself: a reviewer's whole job, and a manager's non-job.
  await requireCapability(event, 'answerGate')
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ note?: string }>(event).catch(() => ({} as { note?: string }))
  // Read first: continueRun clears the question, and the question is what says
  // whether this click approved a step or answered one - and it carries the
  // `askedAt` that is the only record of how long this gate waited for a person.
  const before = await getRun(id)
  // `answerGate` says you may answer a gate; this says you may answer THIS one.
  // Both roles that hold the capability would otherwise be interchangeable, and
  // a developer could accept QA's verification of their own change.
  if (before) await requireGateRole(event, before)
  const user = await currentUser(event)
  let run
  try {
    run = await continueRun(id, body?.note)
  } catch (err) {
    // An owner-gated run approved with no reason is a 400 the reviewer can act
    // on, not a 500 that reads as the app breaking.
    if (err instanceof ApprovalNeedsReason) throw createError({ statusCode: 400, message: err.message })
    // Answering a spent-send-back question restarts a step, so this handler also
    // reaches restartRun's preflight (dirty worktree, missing branch). Without the
    // mapping that restart.post.ts already does, a refusal a person can act on
    // arrives as an opaque 500.
    if (err instanceof RestartError) throw createError({ statusCode: err.statusCode, message: err.message })
    throw err
  }
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  // Gated on the question having moved, not on the status having moved. A run
  // can stay `paused` across two consecutive approval gates - only
  // question.stepId changes - so approving one gate and landing straight on
  // the next wrote nothing, dropping exactly the "who approved this" record
  // this route exists to keep.
  if (before && (before.question?.stepId !== run.question?.stepId || before.status !== run.status)) {
    await appendRunAudit(id, {
      type: before.question?.kind === 'question' ? 'answer' : 'approve',
      actor: user?.login,
      stepId: before.question?.stepId || before.currentStepIds[0],
      text: body?.note?.trim() || undefined,
    })
  }

  // Only now, and only for an approval that actually took effect: a refused
  // approval (ApprovalNeedsReason, above) throws before reaching this line and
  // must leave nothing on the record. `before` still holds the question, so the
  // wait is measured from it; the decision is then appended to the run as the
  // runner has just rewritten it, never to this stale copy.
  if (before?.question?.kind === 'approval') {
    const decision = recordDecision(before, 'approved', user?.login ?? 'a reviewer', body?.note?.trim())
    const fresh = await getRun(id)
    if (decision && fresh) {
      fresh.decisions = [...(fresh.decisions ?? []), decision]
      await saveRun(fresh)
      return fresh
    }
  }
  return run
})
