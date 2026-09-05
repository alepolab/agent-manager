import { requireUser } from '../../utils/session'
import { envForUser } from '../../utils/users'
import { jiraAuthHeader } from '../../utils/jiraCredentials'

/** Calls Jira's `myself` with the developer's stored credentials and reports the outcome. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const env = await envForUser(user.login)
  if (!env.JIRA_API_TOKEN || !env.JIRA_EMAIL) return { ok: false, message: 'No Jira token stored yet' }
  try {
    const res = await fetch(`${env.JIRA_BASE_URL}/rest/api/3/myself`, {
      headers: { Authorization: jiraAuthHeader({ baseUrl: env.JIRA_BASE_URL!, email: env.JIRA_EMAIL, apiToken: env.JIRA_API_TOKEN }), Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return { ok: false, message: `Jira answered ${res.status}` }
    const me = await res.json() as { displayName?: string, emailAddress?: string }
    return { ok: true, message: `Signed in as ${me.displayName ?? me.emailAddress ?? env.JIRA_EMAIL}` }
  } catch (err: any) {
    return { ok: false, message: (err?.message || 'Jira request failed').toString().slice(0, 300) }
  }
})
