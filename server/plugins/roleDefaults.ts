/**
 * Says at boot when the instance's defaults could leave it with no admin.
 *
 * With AGENT_MANAGER_DEFAULT_ROLE set to anything but operator, a newcomer is
 * not an operator - and if roles.json names nobody as one either, nobody can
 * assign roles, configure the pipeline or fix this from the app. Said loudly,
 * with the fix, rather than found by the first person who needs a setting.
 */
import { defaultRole, listRoles } from '../utils/roles.ts'
import { defaultLevel } from '../utils/hierarchy.ts'

export default defineNitroPlugin(async () => {
  const role = defaultRole()
  const level = defaultLevel()
  if (role === 'operator' && level === null) return
  console.log(`[roles] newcomers start as ${role}${level !== null ? `, level L${level}` : ''}`)
  if (role !== 'operator' && !Object.values(await listRoles()).includes('operator')) {
    console.error(`[roles] no one is an operator: AGENT_MANAGER_DEFAULT_ROLE=${role} and roles.json lists no operator, so nobody can assign roles or change settings. Add one: sudo -u <server user> tee <claude dir>/roles.json <<< '{ "<login>": "operator" }'`)
  }
})
