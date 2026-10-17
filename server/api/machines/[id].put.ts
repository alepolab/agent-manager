import { requireCapability, currentUser } from '../../utils/session.ts'
import { saveMachine, toPublicMachine } from '../../utils/machines.ts'

/** Replaces a machine's settings. A key is kept unless `privateKeyPlain` is sent: a value replaces it, '' clears it. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const id = getRouterParam(event, 'id')!
  const body = await readBody(event)
  if (!body || typeof body !== 'object') throw createError({ statusCode: 400, message: 'Request body must be a JSON object' })
  const user = await currentUser(event)
  try {
    return toPublicMachine(await saveMachine({ ...body, id }, user?.login))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw createError({ statusCode: message.startsWith('No machine') ? 404 : 400, message })
  }
})
