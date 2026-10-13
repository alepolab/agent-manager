import { currentUser, authDisabled, currentRole } from '../utils/session'
import { getProfile, toPublic } from '../utils/users'
import { roleFor } from '../utils/roles'
import { listPlacements } from '../utils/hierarchy'
import { teamOf } from '../../shared/types/hierarchy'
import { capabilitiesFor } from '../../shared/types/role'

/** The signed-in developer and their profile flags; 401 when signed out. */
export default defineEventHandler(async (event) => {
  const user = await currentUser(event)
  if (!user) throw createError({ statusCode: 401, message: 'Sign in required' })
  const profile = await getProfile(user.login)
  // `role` is what this session acts with and what the UI must shape itself to;
  // `realRole` is what the person actually holds. They differ only while an
  // operator is looking at the app as someone lesser, and the UI needs both to
  // say so out loud — a console that has quietly hidden your controls is
  // indistinguishable from a broken one.
  const realRole = await roleFor(user.login)
  const role = await currentRole(event)
  // Their place in the hierarchy and who is below them: the UI offers a
  // person filter on runs only to someone who has a team to filter.
  const placements = await listPlacements()
  const placement = placements[user.login] ?? null
  return {
    ...user,
    role,
    realRole,
    can: capabilitiesFor(role),
    placement,
    team: placement ? teamOf(user.login, placements) : [],
    authDisabled: authDisabled(),
    profile: profile ? toPublic(profile) : { login: user.login, hasJiraToken: false, hasGithubToken: false, hasAnthropicToken: false, updatedAt: 0 },
  }
})
