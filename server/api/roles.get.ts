import { requireUser } from '../utils/session'
import { listRoles } from '../utils/roles'
import { DEFAULT_ROLE, ROLE_LABEL, ROLES } from '../../shared/types/role'

/** Who holds which role, and what the roles mean. Readable by anyone signed in:
 *  knowing that Ashwani answers the verification gate is how a team works. */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  return { roles: await listRoles(), default: DEFAULT_ROLE, available: ROLES, labels: ROLE_LABEL }
})
