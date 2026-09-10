import { saveSmtp } from '../utils/channels.ts'

/**
 * The one SMTP relay every email channel sends through.
 *
 * A singleton rather than a row per channel: the relay is a property of the
 * deployment, not of an audience, and copying credentials into each recipient
 * list would be several places to rotate one password.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event)
  try {
    return await saveSmtp(body ?? {})
  } catch (err) {
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
