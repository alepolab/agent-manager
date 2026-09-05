import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requireUser } from '../../utils/session'
import { envForUser } from '../../utils/users'

const execFileP = promisify(execFile)

/** Runs `jira me` with the developer's stored credentials and reports the outcome. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const env = await envForUser(user.login)
  if (!env.JIRA_API_TOKEN) return { ok: false, message: 'No Jira token stored yet' }
  try {
    const { stdout } = await execFileP('jira', ['me'], { env: { ...process.env, ...env }, timeout: 30_000 })
    return { ok: true, message: stdout.trim().slice(0, 200) }
  } catch (err: any) {
    return { ok: false, message: (err.stderr || err.message || 'jira me failed').toString().slice(0, 300) }
  }
})
