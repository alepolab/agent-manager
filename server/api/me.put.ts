import { requireUser } from '../utils/session'
import { saveProfile, toPublic } from '../utils/users'

/** Jira email and token for the signed-in developer, and their own preferences.
 *  An empty token clears it. `requireUser`, not a capability: every role edits
 *  their own profile, whatever else they may not touch. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ jiraEmail?: string, jiraToken?: string, labs?: boolean }>(event)
  const patch: Parameters<typeof saveProfile>[1] = {}
  if (typeof body?.jiraEmail === 'string') patch.jiraEmail = body.jiraEmail.trim()
  if (typeof body?.jiraToken === 'string') patch.jiraTokenPlain = body.jiraToken.trim()
  if (typeof body?.labs === 'boolean') patch.labs = body.labs
  return toPublic(await saveProfile(user.login, patch))
})
