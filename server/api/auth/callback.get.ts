import { getSession } from '../../utils/session'
import { saveProfile } from '../../utils/users'

const ORG = () => process.env.GITHUB_ORG || 'alepolab'

/**
 * Exchange the code, require membership of the org, and sign the developer
 * in. Their token is kept encrypted in their profile so runs they start can
 * push and open PRs as them after the browser closes.
 */
export default defineEventHandler(async (event) => {
  const { code, state, error, error_description } = getQuery(event) as Record<string, string | undefined>
  if (error) throw createError({ statusCode: 400, message: `GitHub refused sign-in: ${error_description || error}` })
  const session = await getSession(event)
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
  if (!token.access_token) throw createError({ statusCode: 502, message: `GitHub token exchange failed: ${token.error_description || 'no token returned'}` })

  const gh = (path: string) => fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-manager' } })
  const me = (await (await gh('/user')).json()) as { login?: string, name?: string, avatar_url?: string }
  if (!me.login) throw createError({ statusCode: 502, message: 'GitHub did not return a user' })
  const membership = await gh(`/user/memberships/orgs/${ORG()}`)
  const state_ = membership.ok ? ((await membership.json()) as { state?: string }).state : undefined
  if (state_ !== 'active') {
    throw createError({ statusCode: 403, message: `@${me.login} is not an active member of the ${ORG()} GitHub organisation. Ask an org owner for an invitation, then sign in again.` })
  }

  await saveProfile(me.login, { name: me.name ?? undefined, avatar: me.avatar_url, githubTokenPlain: token.access_token })
  await session.update({ user: { login: me.login, name: me.name ?? undefined, avatar: me.avatar_url } } as any)
  return sendRedirect(event, '/')
})
