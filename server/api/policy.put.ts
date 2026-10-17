import { requireCapability, currentUser } from '../utils/session.ts'
import { saveRiskPolicy } from '../utils/riskPolicyStore.ts'
import { appendAudit } from '../utils/auditLog.ts'
import { validateRiskPolicy } from '../../shared/utils/riskPolicy.ts'

/**
 * Replace the risk policy. `configure` only, which is the operator's: this is
 * the table that decides whether a money change stops for a person, and it is
 * the one setting a developer must not be able to loosen for their own run.
 *
 * The whole policy is replaced, not patched, so the file on disk is always
 * exactly what the last operator saw and saved. The change is appended to the
 * audit chain before the response, with the policy as written, so "what did
 * the gates demand on the 14th" has an answer.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const body = await readBody(event).catch(() => null)
  const errors = validateRiskPolicy(body)
  if (errors.length) {
    throw createError({ statusCode: 400, message: `Not a valid risk policy: ${errors.join('; ')}` })
  }
  const saved = await saveRiskPolicy(body)
  const me = await currentUser(event)
  await appendAudit({ actor: me?.login ?? 'unknown', kind: 'policy', ref: 'risk-policy', payload: { policy: saved } })
  return saved
})
