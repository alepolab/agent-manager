import { currentUser, isPublicApiPath, authDisabled } from '../utils/session'

/**
 * Every API call needs a signed-in developer, except health, the auth dance
 * and the config probe. Pages are left to the client guard, which redirects to
 * the login page; a bare 401 on an HTML request would be a dead end.
 */
export default defineEventHandler(async (event) => {
  if (authDisabled()) return
  const path = event.path.split('?')[0]
  if (!path.startsWith('/api/')) return
  if (isPublicApiPath(path)) return
  const user = await currentUser(event)
  if (!user) throw createError({ statusCode: 401, message: 'Sign in required' })
  event.context.user = user
})
