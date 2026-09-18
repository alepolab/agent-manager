import { requireUser, requireCapability, currentRole } from '../../utils/session'
import { assignRole, RoleAssignmentError } from '../../utils/team'
import type { Role } from '../../../shared/types/role'

/**
 * Assign one person's role, or clear it with `{ role: null }`.
 *
 * The authority check lives in `assignRole` rather than here, so curl and the
 * UI cannot diverge: this route's job is to resolve WHO is asking from the
 * session and translate a typed refusal into an HTTP status.
 *
 * `currentRole` is the EFFECTIVE role, so an operator inspecting the app as a
 * developer cannot assign either. That is deliberate and it is the whole point
 * of VIEW-AS: the answer to "what does a developer see here" has to include the
 * controls they do not get. Clearing the lens restores the ability.
 */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  // `configure` is the operator-only capability in the role model, and deciding
  // who holds which role is the same class of act as configuring the pipeline.
  // Asked here as well as inside `assignRole` on purpose: this is the boundary
  // check every mutating route in this app owes (scripts/test-routes-are-guarded
  // enforces it), and the one in the module is what keeps curl and the UI from
  // diverging.
  await requireCapability(event, 'configure')
  const actorRole = await currentRole(event)
  const body = await readBody<{ login?: string, role?: Role | null }>(event)
  if (!body?.login) throw createError({ statusCode: 400, message: 'login is required' })
  try {
    return await assignRole(body.login, body.role ?? null, { actorRole })
  } catch (err) {
    if (err instanceof RoleAssignmentError) throw createError({ statusCode: err.statusCode, message: err.message })
    throw createError({ statusCode: 500, message: err instanceof Error ? err.message : String(err) })
  }
})
