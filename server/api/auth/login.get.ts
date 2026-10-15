import { randomBytes } from 'node:crypto'
import { authSession, authDisabled } from '../../utils/session'
import { signInScopes } from '../../utils/githubSignIn'

/** Start the GitHub OAuth dance. With AUTH_DISABLED there is nothing to do. */
export default defineEventHandler(async (event) => {
  if (authDisabled()) return sendRedirect(event, '/')
  const clientId = process.env.GITHUB_CLIENT_ID
  if (!clientId) throw createError({ statusCode: 500, message: 'GITHUB_CLIENT_ID is not configured' })
  const state = randomBytes(16).toString('hex')
  const session = await authSession(event)
  await session.update({ ...session.data, oauthState: state } as any)
  const base = (process.env.AGENT_MANAGER_URL || `http://${getRequestHost(event)}`).replace(/\/$/, '')
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', `${base}/api/auth/callback`)
  // Repository access too, unless this instance signs people in for identity
  // only (GITHUB_SIGNIN_SCOPE=identity); see githubSignIn.ts.
  url.searchParams.set('scope', signInScopes())
  url.searchParams.set('state', state)
  return sendRedirect(event, url.toString())
})
