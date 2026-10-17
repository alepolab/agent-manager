import { currentRole } from '../../utils/session.ts'
import { verifyAuditChain } from '../../utils/auditLog.ts'

/** Walk the audit chain: `{ ok, count, brokenAt?, reason? }`. Same readers as GET /api/audit. */
export default defineEventHandler(async (event) => {
  const role = await currentRole(event)
  if (role !== 'operator' && role !== 'manager') {
    throw createError({ statusCode: 403, message: `Your role (${role}) cannot verify the audit log. Ask an operator or a manager.` })
  }
  return verifyAuditChain()
})
