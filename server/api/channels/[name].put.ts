import { saveChannel } from '../../utils/channels.ts'
import { currentUser } from '../../utils/session.ts'

/**
 * Creates or replaces one channel.
 *
 * Per-name rather than a whole-array PUT, unlike workflow groups, because a row
 * here holds a secret the form cannot echo back: a whole-array save would have
 * to represent "this row's URL is unchanged" for every row at once, and getting
 * that wrong wipes a webhook. One row, one save, and an absent `url` means
 * unchanged.
 */
export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')!
  const body = await readBody<{ kind?: unknown, url?: unknown, to?: unknown }>(event)
  const user = await currentUser(event)
  try {
    return await saveChannel(decodeURIComponent(name), { kind: body?.kind, url: body?.url, to: body?.to }, user?.login)
  } catch (err) {
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
