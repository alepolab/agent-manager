import { requireUser } from '../../utils/session'
import { stashCheckout, workspaceRoot } from '../../utils/workspace'

/** Park a checkout's uncommitted work under a named stash, as the signed-in developer. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ path?: string }>(event)
  const path = body?.path ?? ''
  if (!path.startsWith(workspaceRoot() + '/') || path.includes('..')) throw createError({ statusCode: 400, message: 'path must be a checkout under the workspace root' })
  try {
    return await stashCheckout(path, user.login)
  } catch (err) {
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
