import { requireCapability } from '../../../utils/session.ts'
import { getMachine, checkMachine } from '../../../utils/machines.ts'

/**
 * Connects to the machine and asks it the questions a run would: is claude
 * there, is git, is rsync, can the workspace root be written. The verdict is
 * recorded on the machine so the list shows it without connecting again.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const m = await getMachine(getRouterParam(event, 'id')!)
  if (!m) throw createError({ statusCode: 404, message: 'No such machine' })
  return await checkMachine(m)
})
