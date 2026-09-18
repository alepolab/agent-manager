import { requireUser, currentRole } from '../../utils/session'
import { listTeamMembers, assignableRoles } from '../../utils/team'

/**
 * Who is on this team, what role each holds, and which roles may be assigned.
 *
 * Readable by anyone signed in: knowing that a gate belongs to QA is useless
 * without knowing who QA is. Whether the caller may CHANGE anything is a
 * separate question, answered by `canAssign` so the UI does not have to guess
 * at the rule - and enforced again server-side in the assign route, because a
 * control the browser declines to draw is still reachable by curl.
 */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  const role = await currentRole(event)
  return {
    members: await listTeamMembers(),
    assignable: assignableRoles(),
    canAssign: role === 'operator',
  }
})
