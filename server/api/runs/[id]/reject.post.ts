import { stopRun } from '../../../utils/workflowRunner'
import { getRun, saveRun } from '../../../utils/workflowRunStore'
import { requireCapability, currentUser } from '../../../utils/session'

/**
 * Refuse at a gate.
 *
 * A reviewer could approve and nothing else. `stop`, `restart` and `note` are
 * all `runEngine`, which developer and QA do not hold, so the only way to say
 * no was to ask an operator to press Stop. A gate whose sole affordance is yes
 * is not a gate.
 *
 * So this is the counterpart of `continue`, on the same `answerGate`
 * capability: the roles that own the decision can now make it either way.
 *
 * It stops the run and records WHY, attributed. It deliberately does NOT send
 * the work back to a particular step: that needs a rework target declared per
 * gate, and guessing it is worse than not doing it — `Push + PR` has three
 * predecessors, so "the step before" is not a question the run can answer.
 * Until that exists, a rejection ends the run with its reason on the record and
 * an operator restarts from wherever the note says.
 *
 * The note is required. A refusal without a reason tells the next reader
 * nothing, and the whole value of a human gate is the judgement behind it.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'answerGate')
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ note?: string }>(event).catch(() => ({} as { note?: string }))
  const note = body?.note?.trim()
  if (!note) {
    throw createError({ statusCode: 400, message: 'Say why you are sending this back; the reason is the point of the gate.' })
  }

  const before = await getRun(id)
  if (!before) throw createError({ statusCode: 404, message: 'Run not found' })
  if (before.status !== 'paused' || !before.question) {
    throw createError({ statusCode: 409, message: `This run is ${before.status}, not waiting on a decision; there is nothing to reject.` })
  }

  const user = await currentUser(event)
  const step = before.steps.find(s => s.stepId === before.question!.stepId)
  const run = await stopRun(id)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })

  // stopRun records no reason, so a rejected run would read exactly like a
  // crashed one on the run page and in the record. Attribute it instead.
  run.error = `Rejected at "${step?.label ?? before.question.stepId}" by ${user?.login ?? 'a reviewer'}: ${note}`
  await saveRun(run)
  return run
})
