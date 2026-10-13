import { can } from '../../../shared/types/role'
import { isTestRun } from '../../../shared/types/run.ts'
import { buildNotifications } from '../../../shared/utils/notifications'
import { listPendingPermissions } from '../../utils/providers/claudeProvider'
import { detectSdkSession } from '../../utils/sdkSessionStorage'
import { currentRole } from '../../utils/session'
import { listRuns } from '../../utils/workflowRunStore'
import { scanOriginIndex } from '../../utils/scanOrigins'

/**
 * Every decision waiting on the caller, for /notifications and the sidebar's
 * one "needs you" badge: the gates runs are stopped on, and the /cli
 * tool-permission prompts still open.
 *
 * Prompts are listed only to a role holding `configure` — the capability that
 * opens /cli and answers them at /api/v2/permissions/respond. Showing one to
 * anyone else would offer a decision the answering route refuses.
 */
export default defineEventHandler(async (event) => {
  const role = await currentRole(event)
  const permissions = await Promise.all((can(role, 'configure') ? listPendingPermissions() : []).map(async p => ({
    ...p,
    projectName: (await detectSdkSession(p.sessionId).catch(() => null)) ?? undefined,
  })))
  const runs = (await listRuns()).filter(r => !isTestRun(r))
  // One stat per scan run, a read only when its tickets-created.json changed.
  return { items: buildNotifications(runs, permissions, role, await scanOriginIndex(runs)) }
})
