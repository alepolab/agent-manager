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
  const body = await readBody<{ login?: string, level?: number | null, lead?: string | null }>(event)
  const login = body?.login?.trim()
  if (!login) throw createError({ statusCode: 400, message: 'login is required' })
  let next: Placement | null = null
  if (body.level !== null && body.level !== undefined) {
    if (!isLevel(body.level)) throw createError({ statusCode: 400, message: 'level must be 1, 2 or 3, or null to take them out' })
    next = { level: body.level, ...(body.lead?.trim() ? { lead: body.lead.trim() } : {}) }
  }
  try {
    return { placements: await setPlacement(login, next) }
  } catch (err) {
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
