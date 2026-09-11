import { authSession, currentUser } from '../utils/session'
import { roleFor } from '../utils/roles'
import { ROLES, type Role } from '../../shared/types/role'

/**
 * Look at the app as a lesser role, or stop.
 *
 * This exists because there is no other honest way to check what a developer
 * sees: the alternative is a second GitHub account, and the alternative to that
 * is guessing. It only ever narrows — the request is refused for anyone who is
 * not really an operator, and `effectiveRole` ignores a stored value that would
 * widen. Clearing is `{ role: null }`.
 */
export default defineEventHandler(async (event) => {
  const user = await currentUser(event)
  if (!user) throw createError({ statusCode: 401, message: 'Sign in required' })
  if (await roleFor(user.login) !== 'operator') {
    throw createError({ statusCode: 403, message: 'Only an operator can view the app as another role.' })
  }
  const body = await readBody<{ role?: Role | null }>(event)
  const role = body?.role ?? null
  if (role !== null && (!(ROLES as string[]).includes(role) || role === 'operator')) {
    throw createError({ statusCode: 400, message: 'role must be developer, qa, manager, or null to stop' })
  }
  const session = await authSession(event)
  await session.update(d => ({ ...d, viewAs: role ?? undefined }))
  return { viewAs: role }
})
