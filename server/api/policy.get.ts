import { requireUser } from '../utils/session.ts'
import { loadRiskPolicy } from '../utils/riskPolicyStore.ts'

/**
 * The risk policy in force. Readable by anyone signed in: knowing that a
 * `money` change needs two reviewers and a sandbox is how a developer plans
 * the work, not a privilege.
 */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  return loadRiskPolicy()
})
