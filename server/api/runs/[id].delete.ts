import { deleteRun } from '../../utils/workflowRunStore'
import { _dropLive } from '../../utils/workflowRunner'
import { currentUser } from '../../utils/session'

/**
 * Permanently removes a settled run: its record and its evidence directory.
 * A live run (running or paused) is refused — stop it first — so a delete can
 * never race the runner writing the same files. Irreversible; the evidence
 * bundle goes with it.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await currentUser(event) // auth middleware already gated this; keeps the identity on the event
  _dropLive(id) // drop any stale live entry before the files go
  const result = await deleteRun(id)
  if (result === 'not-found') throw createError({ statusCode: 404, message: 'Run not found' })
  if (result === 'live') throw createError({ statusCode: 409, message: 'A live run cannot be deleted; stop it first' })
  return { ok: true, id }
})
