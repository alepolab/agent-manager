import { requireCapability, currentUser } from '../../utils/session.ts'
import { addDelegation, delegationProblem } from '../../utils/smeDirectory.ts'
import type { SmeDelegation } from '../../../shared/types/sme.ts'

/**
 * Record that one person covers for another. Anyone who may answer a gate may
 * delegate - but only their own gates, unless they configure the instance:
 * delegating someone else's queue away is an operator's act.
 */
export default defineEventHandler(async (event) => {
  const role = await requireCapability(event, 'answerGate')
  const body = await readBody<Partial<SmeDelegation>>(event).catch(() => ({} as Partial<SmeDelegation>))
  const problem = delegationProblem(body)
  if (problem) throw createError({ statusCode: 400, message: problem })
  const user = await currentUser(event)
  if (role !== 'operator' && user?.login && body.from !== user.login) {
    throw createError({ statusCode: 403, message: `You can delegate your own gates (from: ${user.login}); delegating ${body.from}'s is an operator's call.` })
  }
  return { delegations: await addDelegation(body as SmeDelegation) }
})
