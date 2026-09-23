import { skipStep, SkipNeedsReason } from '../../../utils/workflowRunner'
import { getRun } from '../../../utils/workflowRunStore'
import { requireCapability, currentUser } from '../../../utils/session'
import { recordDecision } from '../../../../shared/utils/runDecisions'
import { saveRun } from '../../../utils/workflowRunStore'
import { requireGateRole } from '../../../utils/gateRole'

/**
 * Skip the step a paused run is waiting on.
 *
 * A reviewer could approve, reject, rework or stop. Someone who wanted none of
 * those — a Jira transition on a ticket that must not move — had only "stop a
 * healthy run" left. Same gate role as approving, because deciding a step will
 * not happen is as much a decision as deciding it may.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'answerGate')
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ reason?: string }>(event).catch(() => ({} as { reason?: string }))
  const before = await getRun(id)
  if (!before) throw createError({ statusCode: 404, message: 'Run not found' })
  await requireGateRole(event, before)
  const user = await currentUser(event)

  let run
  try {
    run = await skipStep(id, body?.reason ?? '')
  } catch (err) {
    if (err instanceof SkipNeedsReason) throw createError({ statusCode: 400, message: err.message })
    throw err
  }
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })

  // On the record, with its reason: a step that silently did not happen is the
  // thing every gate here exists to prevent.
  const label = before.steps.find(s => s.stepId === before.question?.stepId)?.label ?? before.question?.stepId ?? 'a step'
  const decision = recordDecision(before, 'skipped', user?.login ?? 'an operator', `Skipped ${label}: ${body!.reason!.trim()}`)
  if (decision) await saveRun({ ...run, decisions: [...(run.decisions ?? []), decision] })
  return run
})
