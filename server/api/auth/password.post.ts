import { authSession, authDisabled } from '../../utils/session.ts'
import { checkPasswordLogin, deviceCookie, DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE, passwordFingerprint, passwordLoginConfigured, passwordAccountTakenBy } from '../../utils/passwordLogin.ts'

/** Sign in with the instance's username and password (see passwordLogin.ts). */
export default defineEventHandler(async (event) => {
  if (authDisabled()) return { ok: true }
  if (!passwordLoginConfigured()) throw createError({ statusCode: 404, message: 'Password sign-in is not configured' })
  const body = await readBody<{ username?: unknown, password?: unknown }>(event).catch(() => null)
  const username = typeof body?.username === 'string' ? body.username : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!username || !password) throw createError({ statusCode: 400, message: 'Enter a username and password' })

  const result = await checkPasswordLogin(username, password, getCookie(event, DEVICE_COOKIE))
  if (!result.ok) {
    if (result.busy) {
      setResponseHeader(event, 'Retry-After', result.busy)
      throw createError({ statusCode: 429, message: 'Too many sign-in attempts at once. Try again in a few seconds.' })
    }
    throw createError({ statusCode: 401, message: 'Wrong username or password' })
  }
  // Checked only after the right password, so it tells a stranger nothing.
  if (await passwordAccountTakenBy(result.login)) {
    throw createError({ statusCode: 403, message: `"${result.login}" is a GitHub user on this instance; the password account needs a name of its own. Change AGENT_MANAGER_LOGIN_USER.` })
  }
  const session = await authSession(event)
  await session.update({ user: { login: result.login, name: result.login, pw: passwordFingerprint()! } })
  // This browser is now a known device: its next attempts skip the shared lane
  // a stranger can fill. Sent only to this route, and renewed on each sign-in.
  const device = deviceCookie(result.device)
  if (device) {
    setCookie(event, DEVICE_COOKIE, device, { maxAge: DEVICE_COOKIE_MAX_AGE, httpOnly: true, sameSite: 'lax', secure: false, path: '/api/auth/password' })
  }
  return { ok: true, login: result.login }
})
