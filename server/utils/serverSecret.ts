import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * AGENT_MANAGER_SECRET seals the session cookie (session.ts) and derives the
 * key stored tokens are encrypted under (users.ts). An instance started
 * without one could sign nobody in with auth on, and could store no Jira token
 * even with auth off - found only when someone first saved their profile.
 *
 * So at boot, an unset secret is generated once and kept in a file, then
 * reused on every later boot. It must be STABLE: a new secret each boot would
 * orphan every token already stored. An explicit AGENT_MANAGER_SECRET always
 * wins and the file is never touched; the team instance still sets one.
 *
 * Synchronous on purpose: it runs from a Nitro plugin, and the env var must be
 * in place before the first request or the first run reads it.
 */
export const serverSecretFile = () =>
  process.env.AGENT_MANAGER_SECRET_FILE || join(homedir(), '.agent-manager', 'secret')

export type SecretSource = 'env' | 'file' | 'generated'

export function ensureServerSecret(): { source: SecretSource, file?: string } {
  if (process.env.AGENT_MANAGER_SECRET) return { source: 'env' }

  const file = serverSecretFile()
  let secret = ''
  try { secret = readFileSync(file, 'utf8').trim() } catch { /* not there yet */ }
  if (secret) {
    process.env.AGENT_MANAGER_SECRET = secret
    return { source: 'file', file }
  }

  secret = randomBytes(32).toString('hex')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // 'wx': two processes booting at once must not each write a different one.
  try {
    writeFileSync(file, secret + '\n', { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    secret = readFileSync(file, 'utf8').trim()
  }
  process.env.AGENT_MANAGER_SECRET = secret
  return { source: 'generated', file }
}
