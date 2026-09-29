import { startTestRun, TestRunError } from '../../../utils/workflowRunner'
import { currentUser, requireCapability } from '../../../utils/session'

/**
 * Run one step of a finished run again, on its own branch, with no side
 * effects: the Test tab of the builder's step drawer. `stepOverride` is the
 * drawer's current, possibly unsaved, config for that step.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'runEngine')
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ stepId?: unknown, stepOverride?: unknown }>(event)
  if (typeof body?.stepId !== 'string' || !body.stepId) throw createError({ statusCode: 400, message: 'Say which step to test.' })
  const override = body.stepOverride
  if (override !== undefined && (typeof override !== 'object' || override === null || Array.isArray(override))) {
    throw createError({ statusCode: 400, message: 'stepOverride must be an object of step fields.' })
  }
  const user = await currentUser(event)
  try {
    return await startTestRun(id, body.stepId, { stepOverride: override as Record<string, unknown> | undefined, startedBy: user?.login })
  } catch (err) {
    if (err instanceof TestRunError) throw createError({ statusCode: err.status, message: err.message })
    throw err
  }
})
