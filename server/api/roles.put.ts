import { requireCapability, currentUser } from '../utils/session'
import { listRoles, setRole } from '../utils/roles'
import { ROLES, type Role } from '../../shared/types/role'

/**
 * Give one login a role, or clear it back to the default.
 *
 * An operator cannot demote themselves: the last thing a shared instance needs
 * is nobody able to configure it, and "I was testing what a developer sees" is
 * what view-as is for.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const body = await readBody<{ login?: string, role?: Role | null }>(event)
  const login = body?.login?.trim()
  if (!login) throw createError({ statusCode: 400, message: 'login is required' })
  if (body.role !== null && !(ROLES as string[]).includes(String(body.role))) {
    throw createError({ statusCode: 400, message: `role must be one of ${ROLES.join(', ')}, or null to clear it` })
  }
  const me = await currentUser(event)
  if (me?.login === login && body.role !== 'operator' && body.role !== null) {
    throw createError({ statusCode: 400, message: 'You cannot take your own operator role away. Use "View as" to see what another role sees.' })
  }
  await setRole(login, (body.role ?? null) as Role | null)
  return { roles: await listRoles() }
})
