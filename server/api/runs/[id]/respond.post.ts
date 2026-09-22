import { respondToRun } from '../../../utils/workflowRunner'
import { getRun } from '../../../utils/workflowRunStore'
import { appendRunAudit } from '../../../utils/runArtifacts'
import { currentUser, requireCapability } from '../../../utils/session'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'answerGate')
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ reply: string }>(event)
  if (!body?.reply?.trim()) throw createError({ statusCode: 400, message: 'reply is required' })
  const before = await getRun(id)
  const run = await respondToRun(id, body.reply)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  // Same gate as continue.post.ts, and for the same reason: a run can stay
  // `paused` across two consecutive questions, with only question.stepId
  // moving, and the reply would then be lost from the trail entirely.
  //
  // The step id comes from the question first. currentStepIds alone was wrong
  // here: on the gate path the runner sets it to [], so the event recorded no
  // step at all - and this is the handler for ANSWERING a question, where
  // question.stepId is the authoritative one.
  if (before && (before.question?.stepId !== run.question?.stepId || before.status !== run.status)) {
    await appendRunAudit(id, {
      type: 'answer',
      actor: (await currentUser(event))?.login,
      stepId: before.question?.stepId || before.currentStepIds[0],
      text: body.reply,
    })
  }
  return run
})
