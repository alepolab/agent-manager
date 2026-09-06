import { requireUser } from '../../utils/session'
import { promoteToTeam, PromoteError, type PromoteKind } from '../../utils/promote'

/** Open a PR that moves one agent, skill or command into the alepo-engineering plugin. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ kind?: PromoteKind, slug?: string }>(event)
  if (!body?.kind || !body?.slug) throw createError({ statusCode: 400, message: 'kind and slug are required' })
  try {
    return await promoteToTeam(body.kind, body.slug, user.login)
  } catch (err) {
    if (err instanceof PromoteError) throw createError({ statusCode: err.statusCode, message: err.message })
    throw createError({ statusCode: 500, message: err instanceof Error ? err.message : String(err) })
  }
})
