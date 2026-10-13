import { requireUser } from '../utils/session'
import { listRoles } from '../utils/roles'
import { listProfiles } from '../utils/users'
import { listPlacements } from '../utils/hierarchy'
import { LEVEL_LABEL, LEVELS } from '../../shared/types/hierarchy'
import { DEFAULT_ROLE, ROLE_LABEL, ROLES } from '../../shared/types/role'

/** Who holds which role, and what the roles mean. Readable by anyone signed in:
 *  knowing that Ashwani answers the verification gate is how a team works.
 *
 *  `profiles` is everyone this instance has seen sign in, which is a different
 *  set from `roles`: a person who holds no entry is not missing, they are an
 *  operator by default, and the roster has to be able to say so. Both halves
 *  are one screen, so they are one request. */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  const [roles, profiles, placements] = await Promise.all([listRoles(), listProfiles(), listPlacements()])
  return {
    roles, profiles, default: DEFAULT_ROLE, available: ROLES, labels: ROLE_LABEL,
    // Who leads whom. Absent from this map is outside the hierarchy: sees every run.
    placements, levels: LEVELS, levelLabels: LEVEL_LABEL,
  }
})
