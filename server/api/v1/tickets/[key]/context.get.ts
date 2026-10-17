import { requireUser } from '../../../../utils/session.ts'
import { latestRunForTicket, renderTicketContext } from '../../../../utils/ticketContext.ts'
import { baseUrl } from '../../../../utils/notify.ts'

/**
 * What a Claude Code session starting on a ticket needs to know, as plain
 * text for a SessionStart hook to paste into the conversation: the latest run
 * for that ticket, its classification and where it stands, and what the risk
 * policy demands of that classification.
 *
 * Plain text rather than JSON because the consumer is a prompt, not a program.
 * Bearer API token, like every other script path into this API (session.ts);
 * the middleware already refuses an anonymous call, and requireUser is the
 * same check stated where a reader looks for it.
 *
 * The text is built in server/utils/ticketContext.ts, which the test drives.
 */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  const key = (getRouterParam(event, 'key') ?? '').trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
    throw createError({ statusCode: 400, message: 'key must be a ticket key such as SA-1406' })
  }
  const run = await latestRunForTicket(key)
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  if (!run) {
    setResponseStatus(event, 404)
    return `No run recorded for ${key}.\n`
  }
  return renderTicketContext(key, run, baseUrl())
})
