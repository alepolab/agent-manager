import { continueRun, RestartError } from '../../../utils/workflowRunner'
import { getRun } from '../../../utils/workflowRunStore'
import { appendRunAudit } from '../../../utils/runArtifacts'
import { currentUser } from '../../../utils/session'

/** Continue a paused run. `note` reaches the step being approved, or whichever step starts next. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ note?: string }>(event).catch(() => ({} as { note?: string }))
  // Read first: continueRun clears the question, and the question is what says
  // whether this click approved a step or answered one.
  const before = await getRun(id)
  // Answering a spent-send-back question restarts a step, so this handler now
  // reaches restartRun's preflight (dirty worktree, missing branch). Without the
  // mapping that restart.post.ts already does, a refusal a person can act on
  // arrives as an opaque 500.
  const run = await continueRun(id, body?.note).catch((err) => {
    if (err instanceof RestartError) throw createError({ statusCode: err.statusCode, message: err.message })
    throw err
  })
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  // Gated on the question having moved, not on the status having moved. A run
  // can stay `paused` across two consecutive approval gates - only
  // question.stepId changes - so approving one gate and landing straight on
  // the next wrote nothing, dropping exactly the "who approved this" record
  // this route exists to keep. A question that was there and is gone is an
  // answer; one that changed step is an answer too.
  if (before && (before.question?.stepId !== run.question?.stepId || before.status !== run.status)) {
    await appendRunAudit(id, {
      type: before.question?.kind === 'question' ? 'answer' : 'approve',
      actor: (await currentUser(event))?.login,
      stepId: before.question?.stepId || before.currentStepIds[0],
      text: body?.note?.trim() || undefined,
    })
  }
  return run
})
