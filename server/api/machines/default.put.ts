import { requireCapability } from '../../utils/session.ts'
import { setDefaultMachine } from '../../utils/machines.ts'

/** Where every run not saying otherwise executes: a machine's id, or null for this server. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const body = await readBody<{ machineId?: string | null }>(event)
  const id = typeof body?.machineId === 'string' && body.machineId.trim() ? body.machineId.trim() : null
  try {
    await setDefaultMachine(id)
  } catch (err) {
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
  return { defaultMachineId: id }
})
