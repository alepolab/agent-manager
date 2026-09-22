import { deleteRun } from '../../utils/workflowRunStore'
import { _dropLive } from '../../utils/workflowRunner'
import { requireCapability } from '../../utils/session'

/**
 * Permanently removes a settled run: its record and its evidence directory.
 * A live run (running or paused) is refused — stop it first — so a delete can
 * never race the runner writing the same files. Irreversible; the evidence
 * bundle goes with it.
 *
 * `runEngine`, the same capability as stop and restart. This route used to call
 * `currentUser` alone, on the reasoning that the auth middleware had already
 * gated it — but that gates AUTHENTICATION, not authorisation, so every signed-in
 * role reached it. A manager, whose role is defined as "Reads progress across
 * runs. Changes nothing", could permanently destroy a run and the evidence
 * bundle behind it, and the button was rendered for them. Of everything the
 * role model governs this is the only irreversible act, so it was the worst one
 * to leave open.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await requireCapability(event, 'runEngine')
  _dropLive(id) // drop any stale live entry before the files go
  const result = await deleteRun(id)
  if (result === 'not-found') throw createError({ statusCode: 404, message: 'Run not found' })
  if (result === 'live') throw createError({ statusCode: 409, message: 'A live run cannot be deleted; stop it first' })
  return { ok: true, id }
})
