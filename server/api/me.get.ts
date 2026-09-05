import { currentUser, authDisabled } from '../utils/session'
import { getProfile, toPublic } from '../utils/users'

/** The signed-in developer and their profile flags; 401 when signed out. */
export default defineEventHandler(async (event) => {
  const user = await currentUser(event)
  if (!user) throw createError({ statusCode: 401, message: 'Sign in required' })
  const profile = await getProfile(user.login)
  return {
    ...user,
    authDisabled: authDisabled(),
    profile: profile ? toPublic(profile) : { login: user.login, hasJiraToken: false, hasGithubToken: false, updatedAt: 0 },
  }
})
