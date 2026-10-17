import { requireCapability, requireUser } from '../../utils/session.ts'
import { revokeEnvLock, type EnvLockView } from '../../utils/envLocks.ts'
import { appendMcpAudit } from '../../utils/mcpAudit.ts'

/**
 * An operator revokes a host's lock: the holder's session has gone away, or
 * the host is needed now. The holder's next call with the old token says the
 * lock is gone; nothing else changes. Recorded in the gateway audit so the
 * revoke sits beside the request it undid.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'runEngine')
  const me = await requireUser(event)
  const host = getRouterParam(event, 'host') ?? ''
  let revoked: EnvLockView | null
  try {
    revoked = await revokeEnvLock(host)
  } catch (err) {
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
  await appendMcpAudit({ actor: me.login, ref: 'env.revoke_lock', payload: { args: { host }, ok: true, ms: 0, revoked: revoked ?? null } })
  if (!revoked) throw createError({ statusCode: 404, message: `no lock on ${host}` })
  return { revoked }
})
