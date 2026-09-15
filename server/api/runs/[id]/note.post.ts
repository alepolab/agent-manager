import { noteRun } from '../../../utils/workflowRunner'
import { appendRunAudit } from '../../../utils/runArtifacts'
import { currentUser } from '../../../utils/session'

/** Send a note to whichever step starts next in a running run. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ text?: string }>(event)
  if (!body?.text?.trim()) throw createError({ statusCode: 400, message: 'text is required' })
  const r = await noteRun(id, body.text)
  if (!r) throw createError({ statusCode: 409, message: 'This run is not in flight on this instance; restart a step with a note instead' })
  await appendRunAudit(id, { type: 'note', actor: (await currentUser(event))?.login, text: body.text.trim() })
  return r
})
