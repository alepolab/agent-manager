import { authSession, authDisabled } from '../../utils/session.ts'
import { checkPasswordLogin, passwordLoginConfigured } from '../../utils/passwordLogin.ts'

/** Sign in with the instance's username and password (see passwordLogin.ts). */
export default defineEventHandler(async (event) => {
  if (authDisabled()) return { ok: true }
  if (!passwordLoginConfigured()) throw createError({ statusCode: 404, message: 'Password sign-in is not configured' })
  const body = await readBody<{ username?: unknown, password?: unknown }>(event).catch(() => null)
  const username = typeof body?.username === 'string' ? body.username : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!username || !password) throw createError({ statusCode: 400, message: 'Enter a username and password' })

  const result = await checkPasswordLogin(username, password, getRequestIP(event) ?? 'unknown')
  if (!result.ok) {
    if (result.retryAfter) {
      setResponseHeader(event, 'Retry-After', result.retryAfter)
      throw createError({ statusCode: 429, message: `Too many failed attempts. Try again in ${Math.ceil(result.retryAfter / 60)} minute(s).` })
    }
    throw createError({ statusCode: 401, message: 'Wrong username or password' })
  }
  const session = await authSession(event)
  await session.update({ user: { login: result.login, name: result.login } })
  return { ok: true, login: result.login }
})
