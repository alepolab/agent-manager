import { requireCapability } from '../../utils/session'
import { canStoreSecrets, setSlackWebhook, publicIntegrations } from '../../utils/integrations'

/** Set the instance's Slack webhook, or clear it with an empty string. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const body = await readBody<{ webhook?: string }>(event)
  if (typeof body?.webhook !== 'string') {
    throw createError({ statusCode: 400, message: 'webhook must be a string; send "" to clear it' })
  }
  const blocked = canStoreSecrets()
  if (blocked && body.webhook.trim()) throw createError({ statusCode: 409, message: blocked })
  try {
    await setSlackWebhook(body.webhook)
  } catch (err) {
    // A bad URL is the caller's mistake, not a server fault: 400 with the
    // reason, so the page can say which part is wrong.
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
  return publicIntegrations()
})
