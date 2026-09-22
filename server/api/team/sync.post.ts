import { requireCapability } from '../../utils/session'
import { requireUser } from '../../utils/session'
import { teamSync } from '../../utils/teamSync'

/** Apply team standards, as the signed-in developer; `only` limits it to the named items. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const user = await requireUser(event)
  const body = await readBody<{ only?: unknown }>(event).catch(() => null)
  const only = Array.isArray(body?.only) ? body.only.map(String) : undefined
  try {
    return await teamSync(user.login, only)
  } catch (err: any) {
    throw createError({ statusCode: err?.statusCode ?? 500, message: err?.message ?? String(err) })
  }
})
