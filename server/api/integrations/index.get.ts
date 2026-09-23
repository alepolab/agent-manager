import { requireUser } from '../../utils/session'
import { publicIntegrations } from '../../utils/integrations'

/** Whether each integration is configured — never the credential itself. */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  return publicIntegrations()
})
