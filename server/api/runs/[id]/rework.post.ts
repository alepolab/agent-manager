import { restartRun } from '../../../utils/workflowRunner'
import { getRun, saveRun } from '../../../utils/workflowRunStore'
import { requireCapability, currentUser } from '../../../utils/session'
import { recordDecision } from '../../../../shared/utils/runDecisions'
import { requireGateRole } from '../../../utils/gateRole'

/**
 * Send the work back to an earlier step, with an instruction.
 *
 * This is the reviewer's missing instrument. Until now a person at a gate could
 * approve (`continue`) or end the run (`reject`, which calls `stopRun`) — while
 * the runner has always been able to send work back to a named step and carry an
 * instruction to it, bounded at two attempts (workflowRunner.ts:1163-1186). That
 * path was reachable only by an agent printing `PIPELINE-REWORK`. The human
 * reviewing the agent held a strictly weaker instrument than the agent being
 * reviewed, which is backwards for a console whose stated job is to "correct and
 * reroute agent work".
 *
 * `reject.post.ts` used to justify this absence by saying a rework target could
 * not be guessed — "Push + PR" has three predecessors, so "the step before" is
 * not a question the run can answer. That reasoning was sound and answered the
 * wrong question: the run does not have to guess, because the reviewer chooses.
 * The route takes the target as an argument and validates it.
 *
 * Same capability as the other two gate answers (`answerGate`), so the roles that
 * own the decision own all three of its outcomes. Same bound as the agent path:
 * two send-backs, then a person decides rather than a third lap being started.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'answerGate')
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ stepId?: string, note?: string }>(event).catch(() => ({} as { stepId?: string, note?: string }))
  const stepId = body?.stepId?.trim()
  const note = body?.note?.trim()

  if (!stepId) throw createError({ statusCode: 400, message: 'Name the step this goes back to.' })
  // The instruction is the whole point: a step restarted with no reason repeats
  // what it already did. This mirrors the agent path, which cannot send a run
  // back without one either.
  if (!note) throw createError({ statusCode: 400, message: 'Say what needs to change; the step works from this instruction.' })

  const before = await getRun(id)
  if (!before) throw createError({ statusCode: 404, message: 'Run not found' })
  if (before.status !== 'paused' || !before.question) {
    throw createError({ statusCode: 409, message: `This run is ${before.status}, not waiting on a decision; there is nothing to send back.` })
  }
  // Sending work back is this gate's third answer, so it carries the same owner.
  await requireGateRole(event, before)

  const target = before.steps.find(s => s.stepId === stepId)
  if (!target) {
    throw createError({ statusCode: 400, message: `Unknown step "${stepId}" on this run.` })
  }
  // Forward is `continue`, not a send-back. Allowing the gated step itself here
  // would also mean approving it without saying so.
  if (stepId === before.question.stepId) {
    throw createError({ statusCode: 400, message: 'That is the step waiting on you. Approve it, or send it back to an earlier one.' })
  }

  const reworks = (before.reworks ?? 0) + 1
  if (reworks > 2) {
    // The agent path fails the run here. A person gets told instead, because a
    // reviewer who has sent the same work back twice is making a judgement about
    // the run as a whole, and ending it should be their explicit act (`reject`).
    throw createError({
      statusCode: 409,
      message: `This run has already been sent back ${before.reworks} times, which is the limit. Approve it, or reject it with your reasons.`,
    })
  }

  const user = await currentUser(event)
  const from = before.steps.find(s => s.stepId === before.question!.stepId)?.label ?? 'the gate'

  // Recorded before the restart: restartRun re-reads the run from disk, so both
  // the count and the decision have to be on disk first — and the decision has
  // to be built while `question.askedAt` still exists, since the restart clears
  // the question it supersedes.
  recordDecision(before, 'sent-back', user?.login ?? 'a reviewer', note, stepId)
  before.reworks = reworks
  await saveRun(before)

  // `fromRunner` bypasses the settled-status check, exactly as the runner's own
  // rework does: the run is paused at a gate and is being handed to another
  // step, which is not the same event as an operator restarting a dead run.
  try {
    return await restartRun(
      id,
      stepId,
      `Sent back from "${from}" by ${user?.login ?? 'a reviewer'} (rework ${reworks} of 2): ${note}`,
      before.startedBy,
      { fromRunner: true },
    )
  } catch (err: any) {
    // Roll the count back: a restart that never happened is not a rework, and
    // leaving it incremented would silently spend one of the two attempts.
    const current = await getRun(id)
    if (current) { current.reworks = before.reworks - 1; await saveRun(current) }
    if (typeof err?.status === 'number') throw createError({ statusCode: err.status, message: err.message })
    throw err
  }
})
