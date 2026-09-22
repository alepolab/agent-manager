import { requireCapability } from '../../utils/session'
import { slackWebhookUrl } from '../../utils/integrations'

/**
 * Post a real message to the configured webhook.
 *
 * The whole failure this integration had was being configured-looking and
 * silent, so "it is set" is not the claim worth making — "Slack accepted a
 * message" is, and only a real post can say that.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const url = await slackWebhookUrl()
  if (!url) return { ok: false, message: 'No Slack webhook is configured.' }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Agent Manager: test message. Run notifications will arrive here.' }),
      signal: AbortSignal.timeout(15_000),
    })
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    return res.ok
      ? { ok: true, message: 'Slack accepted the message; check the channel.' }
      : { ok: false, message: `Slack answered ${res.status}${detail ? `: ${detail}` : ''}` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
})
