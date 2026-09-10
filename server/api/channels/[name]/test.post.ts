import { getChannel } from '../../../utils/channels.ts'
import { sendToChannel, baseUrl } from '../../../utils/notify.ts'
import { currentUser } from '../../../utils/session.ts'

/**
 * Sends a fixed line to a STORED channel, so an operator can prove a webhook
 * works before the escalation branch of a scan depends on it at 2am.
 *
 * It takes a channel name and nothing else. If it ever accepted a URL in the
 * body it would become a server-side request forgery primitive on a host that
 * has a Docker socket — the request would be shaped by the caller and made by
 * the server. Post to what is stored; never to what is posted.
 */
export default defineEventHandler(async (event) => {
  const name = decodeURIComponent(getRouterParam(event, 'name')!)
  const channel = await getChannel(name)
  if (!channel) throw createError({ statusCode: 404, message: `No channel named "${name}"` })
  const user = await currentUser(event)
  const who = user?.login ? ` by ${user.login}` : ''
  try {
    await sendToChannel(channel, `Agent Manager test message for "${name}"${who}.\n${baseUrl()}/settings`)
    return { ok: true, message: `Posted to "${name}". Check the channel.` }
  } catch (err) {
    return { ok: false, message: `Could not post to "${name}": ${err instanceof Error ? err.message : String(err)}` }
  }
})
