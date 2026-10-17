import { requireCapability } from '../../utils/session.ts'
import { deleteMachine } from '../../utils/machines.ts'

/** Removes a machine and its key file. Runs that already name it keep the name they snapshotted. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const id = getRouterParam(event, 'id')!
  if (!(await deleteMachine(id))) throw createError({ statusCode: 404, message: 'No such machine' })
  return { ok: true }
})
