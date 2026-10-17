import { requireUser } from '../../../utils/session.ts'
import { appendAudit } from '../../../utils/auditLog.ts'

/**
 * A tool call reported by a Claude Code hook (PostToolUse) running inside an
 * agent's session, appended to the audit chain as kind `tool-use`.
 *
 * Authentication is the instance API token as a bearer (session.ts's
 * tokenUser), which is how every script already reaches this API; there is no
 * per-run token in this app yet, so there is nothing narrower to accept. The
 * hook's own fields are taken as given and recorded under the token's login,
 * so a reader can always tell a self-reported line from one the server wrote.
 *
 * No capability check beyond being signed in: the hook writes a line about
 * itself, it changes nothing on the instance, and a developer's own token must
 * be able to report their own session's calls.
 */
interface ToolUseReport {
  ts?: string
  ticket?: string
  session_id?: string
  tool?: string
  file?: string
  cmd?: string
  input_sha256?: string
}

const str = (v: unknown, max = 2000): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<ToolUseReport>(event).catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, message: 'Request body must be a JSON object' })
  }
  const tool = str(body.tool, 200)
  if (!tool) throw createError({ statusCode: 400, message: 'tool is required' })
  const sha = str(body.input_sha256, 64)
  if (sha && !/^[a-f0-9]{64}$/i.test(sha)) throw createError({ statusCode: 400, message: 'input_sha256 must be 64 hex characters' })
  const ts = str(body.ts, 40)
  if (ts && !Number.isFinite(Date.parse(ts))) throw createError({ statusCode: 400, message: 'ts must be an ISO-8601 time' })

  const ticket = str(body.ticket, 40)
  const record = await appendAudit({
    actor: user.name === 'API token' ? `api-token:${user.login}` : user.login,
    kind: 'tool-use',
    ref: ticket ?? str(body.session_id, 120) ?? 'unknown',
    payload: {
      ...(ts ? { reported_ts: ts } : {}),
      ...(ticket ? { ticket } : {}),
      ...(str(body.session_id, 120) ? { session_id: str(body.session_id, 120) } : {}),
      tool,
      ...(str(body.file) ? { file: str(body.file) } : {}),
      ...(str(body.cmd) ? { cmd: str(body.cmd) } : {}),
      ...(sha ? { input_sha256: sha.toLowerCase() } : {}),
    },
  })
  if (!record) throw createError({ statusCode: 500, message: 'The audit log could not be written' })
  setResponseStatus(event, 201)
  return { seq: record.seq, hash: record.hash }
})
