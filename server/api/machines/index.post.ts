import { requireCapability, currentUser } from '../../utils/session.ts'
import { saveMachine, toPublicMachine } from '../../utils/machines.ts'

/** Registers a machine. The pasted key is sealed before it touches disk. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const body = await readBody(event)
  if (!body || typeof body !== 'object') throw createError({ statusCode: 400, message: 'Request body must be a JSON object' })
  const user = await currentUser(event)
  try {
    return toPublicMachine(await saveMachine({ ...body, id: undefined }, user?.login))
  } catch (err) {
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
