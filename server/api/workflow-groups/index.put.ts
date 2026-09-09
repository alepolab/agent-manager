import { replaceGroups } from '../../utils/workflowGroups.ts'
import type { WorkflowGroup } from '../../../shared/types/workflowGroup.ts'

/**
 * Replaces the whole group registry.
 *
 * A PUT of the entire array rather than per-id create/update/delete, because
 * that is how it is edited: a short table an operator fills in and saves once.
 * Per-id routes would also invent a question nothing needs to answer — what
 * happens to the runs of a group being deleted — where a whole-array save just
 * leaves those runs pointing at an id the registry no longer names, which
 * `capFor` already answers with the default cap rather than with "uncapped".
 *
 * Validation lives in replaceGroups so the file can never hold a row that
 * would silently stop a group from ever running again; a bad row is refused
 * before anything is written, so the table is never half-saved.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ groups?: WorkflowGroup[] }>(event)
  if (!Array.isArray(body?.groups)) {
    throw createError({ statusCode: 400, message: 'groups must be an array' })
  }
  try {
    return await replaceGroups(body.groups)
  } catch (err) {
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
