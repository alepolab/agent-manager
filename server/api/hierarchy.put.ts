import { requireCapability } from '../utils/session'
import { setPlacement } from '../utils/hierarchy'
import { isLevel, type Placement } from '../../shared/types/hierarchy'

/**
 * Place one login in the hierarchy - a level and, below the top, a lead - or
 * take them out of it with `level: null`. Configuring who supervises whom is
 * configuring the instance, so it is the operator's, like roles.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const body = await readBody<{ login?: string, level?: number | null | 'default', lead?: string | null }>(event)
  const login = body?.login?.trim()
  if (!login) throw createError({ statusCode: 400, message: 'login is required' })
  // null = out of the hierarchy on purpose; 'default' = back to the default level.
  let next: Placement | null | 'default' = body.level === 'default' ? 'default' : null
  if (body.level !== null && body.level !== undefined && body.level !== 'default') {
    if (!isLevel(body.level)) throw createError({ statusCode: 400, message: 'level must be 1, 2 or 3, null to take them out, or \"default\"' })
    next = { level: body.level, ...(body.lead?.trim() ? { lead: body.lead.trim() } : {}) }
  }
  try {
    return { placements: await setPlacement(login, next) }
  } catch (err) {
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
