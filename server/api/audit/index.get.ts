import { currentRole } from '../../utils/session.ts'
import { queryAudit } from '../../utils/auditLog.ts'

/**
 * The instance audit chain, newest first, filtered by `?ticket=`, `?actor=`,
 * `?kind=`, `?from=`, `?to=` and capped by `?limit=` (default 200).
 *
 * Operator or manager: reading what everyone did across every run is the
 * manager's whole job and the operator's backstop. A developer or QA sees their
 * own actions on a run's own page, and does not need the instance-wide view.
 */
export default defineEventHandler(async (event) => {
  const role = await currentRole(event)
  if (role !== 'operator' && role !== 'manager') {
    throw createError({ statusCode: 403, message: `Your role (${role}) cannot read the audit log. Ask an operator or a manager.` })
  }
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const records = await queryAudit({
    ticket: str(q.ticket), actor: str(q.actor), kind: str(q.kind),
    from: str(q.from), to: str(q.to), limit: Number(q.limit) || undefined,
  })
  return { records }
})
