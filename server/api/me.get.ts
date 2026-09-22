import { currentUser, authDisabled, currentRole } from '../utils/session'
import { getProfile, toPublic } from '../utils/users'
import { roleFor } from '../utils/roles'
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
  return {
    ...user,
    role,
    realRole,
    can: capabilitiesFor(role),
    authDisabled: authDisabled(),
    profile: profile ? toPublic(profile) : { login: user.login, hasJiraToken: false, hasGithubToken: false, updatedAt: 0 },
  }
})
