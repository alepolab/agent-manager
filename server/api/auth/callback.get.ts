import { authSession } from '../../utils/session'
import { saveProfile } from '../../utils/users'
import { membershipFailureDetail } from '../../utils/orgMembership'

const ORG = () => process.env.GITHUB_ORG || 'alepolab'

/**
 * Exchange the code, require membership of the org, and sign the developer
 * in. Their token is kept encrypted in their profile so runs they start can
 * push and open PRs as them after the browser closes.
 */
export default defineEventHandler(async (event) => {
  const { code, state, error, error_description } = getQuery(event) as Record<string, string | undefined>
  if (error) throw createError({ statusCode: 400, message: `GitHub refused sign-in: ${error_description || error}` })
  const session = await authSession(event)
  if (!code || !state || state !== (session.data as any).oauthState) {
    throw createError({ statusCode: 400, message: 'Sign-in state mismatch; start again from the login page' })
  }
  const clientId = process.env.GITHUB_CLIENT_ID, clientSecret = process.env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret) throw createError({ statusCode: 500, message: 'GitHub OAuth is not configured' })

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, state }),
  })
  const token = (await tokenRes.json()) as { access_token?: string, error_description?: string }
  if (!token.access_token) return sendRedirect(event, '/login?error=' + encodeURIComponent(`GitHub token exchange failed: ${token.error_description || 'no token returned'}`))

  const gh = (path: string) => fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-manager' } })
  const me = (await (await gh('/user')).json()) as { login?: string, name?: string, avatar_url?: string }
  if (!me.login) return sendRedirect(event, '/login?error=' + encodeURIComponent('GitHub did not return a user'))
  // Membership is checked, but the FAILURE has to name itself: this endpoint
  // returns a non-2xx for three unrelated reasons, and collapsing them into
  // "you are not a member" once sent a real, active org admin looking for an
  // invitation they already had. See server/utils/orgMembership.ts.
  const membership = await gh(`/user/memberships/orgs/${ORG()}`)
  let state_: string | undefined
  if (membership.ok) {
    state_ = ((await membership.json()) as { state?: string }).state
  }
  else {
    // Body, not token: this response carries GitHub's own explanation and no
    // credential. Truncated because it is a log line, not a document.
    const body = await membership.text().catch(() => '')
    console.warn(`[auth] membership check for @${me.login} on ${ORG()} returned ${membership.status}: ${body.slice(0, 200)}`)
  }
  if (state_ !== 'active') {
    const detail = membershipFailureDetail({ status: membership.status, state: state_, org: ORG(), login: me.login })
    return sendRedirect(event, '/login?error=' + encodeURIComponent(`Could not confirm @${me.login} as an active member of the ${ORG()} GitHub organisation. ${detail}`))
  }

  await saveProfile(me.login, { name: me.name ?? undefined, avatar: me.avatar_url, githubTokenPlain: token.access_token })
  await session.update({ user: { login: me.login, name: me.name ?? undefined, avatar: me.avatar_url } } as any)
  return sendRedirect(event, '/')
})
