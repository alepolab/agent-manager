import type { H3Event } from 'h3'
import { useSession } from 'h3'

/**
 * The signed-in developer, held in an h3 sealed cookie. AUTH_DISABLED=1 (local
 * development, or the pilot until the OAuth app exists) makes every request
 * the configured DEV_USER, default "local", so nothing else needs a branch.
 */
export interface SessionUser {
  login: string
  name?: string
  avatar?: string
}

export const authDisabled = () => process.env.AUTH_DISABLED === '1'

function password(): string {
  const secret = process.env.AGENT_MANAGER_SECRET
  if (secret && secret.length >= 32) return secret
  if (authDisabled()) return 'auth-disabled-development-only-password-0000'
  throw new Error('AGENT_MANAGER_SECRET must be set (32+ characters) when authentication is enabled')
}

export async function getSession(event: H3Event) {
  return useSession<{ user?: SessionUser }>(event, {
    password: password(),
    name: 'am',
    maxAge: 60 * 60 * 24 * 14,
    cookie: { sameSite: 'lax', httpOnly: true, secure: false, path: '/' },
  })
}

export async function currentUser(event: H3Event): Promise<SessionUser | null> {
  if (authDisabled()) return { login: process.env.DEV_USER || 'local', name: 'Local developer' }
  try {
    const session = await getSession(event)
    return session.data.user ?? null
  } catch {
    // An unreadable or tampered cookie is a signed-out visitor, never a 500.
    return null
  }
}

export async function requireUser(event: H3Event): Promise<SessionUser> {
  const user = await currentUser(event)
  if (!user) throw createError({ statusCode: 401, message: 'Sign in required' })
  return user
}

/** Paths that must work without a session: health, the auth dance itself. */
export function isPublicApiPath(path: string): boolean {
  return path === '/api/health' || path.startsWith('/api/auth/') || path === '/api/config'
}
