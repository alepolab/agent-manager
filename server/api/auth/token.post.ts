import { authSession, currentUser } from '../../utils/session'

/**
 * Turns the instance API token into a browser session: a request carrying the
 * bearer gets the sealed cookie for the developer the token acts as, so a
 * headless browser (a visual check, a screenshot job) can open the app the
 * way that developer sees it. Anything without the token is a stranger.
 */
export default defineEventHandler(async (event) => {
  const user = await currentUser(event)
  if (!user || user.name !== 'API token') throw createError({ statusCode: 401, message: 'A valid API token is required' })
  const session = await authSession(event)
  await session.update({ user: { login: user.login, name: user.login } })
  return { ok: true, login: user.login }
})
