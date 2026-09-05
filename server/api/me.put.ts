import { requireUser } from '../utils/session'
import { saveProfile, toPublic } from '../utils/users'

/** Jira email and token for the signed-in developer. An empty token clears it. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ jiraEmail?: string, jiraToken?: string }>(event)
  const patch: Parameters<typeof saveProfile>[1] = {}
  if (typeof body?.jiraEmail === 'string') patch.jiraEmail = body.jiraEmail.trim()
  if (typeof body?.jiraToken === 'string') patch.jiraTokenPlain = body.jiraToken.trim()
  return toPublic(await saveProfile(user.login, patch))
})
