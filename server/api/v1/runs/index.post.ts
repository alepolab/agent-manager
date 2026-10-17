import { requireCapability, currentUser } from '../../../utils/session.ts'
import { startVerificationRun, VerificationStartRefused } from '../../../utils/verificationRunStarter.ts'
import { fetchTicketForPrompt } from '../../../utils/jiraTicketSource.ts'
import { envForUser } from '../../../utils/users.ts'
import { WorkspaceBusyError } from '../../../utils/workflowRunner.ts'

/**
 * `POST /api/v1/runs { issueKey, stage: 'verify', pr?, revision?, branch?, productKey? }`
 *
 * Starts Runbook V for a ticket whose change has merged. The entry point for
 * a GitHub `pull_request: closed (merged)` webhook relay, a release script, or
 * a person with a bearer token; the CI poller reaches the same starter on its
 * own when it sees a run's PR merge (server/utils/ciPoller.ts). `stage` is the
 * only stage this route starts today - it exists so the next one (`deploy`,
 * say) is a value rather than a route.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'startRun')
  const body = await readBody<{ issueKey?: string, stage?: string, pr?: string, revision?: string, branch?: string, productKey?: string, autoRun?: boolean }>(event).catch(() => ({} as Record<string, never>))
  if (!body?.issueKey?.trim()) throw createError({ statusCode: 400, message: 'issueKey is required' })
  if (body.stage !== 'verify') throw createError({ statusCode: 400, message: `stage must be "verify" (got ${JSON.stringify(body.stage ?? null)})` })
  const user = await currentUser(event)
  // Under the starter's identity, before any agent runs: agents have no Jira access.
  const ticket = await fetchTicketForPrompt(body.issueKey.trim(), await envForUser(user?.login))
  try {
    const { run, queued } = await startVerificationRun({
      issueKey: body.issueKey.trim(),
      pr: body.pr?.trim() || undefined,
      revision: body.revision?.trim() || undefined,
      branch: body.branch?.trim() || undefined,
      productKey: body.productKey?.trim() || undefined,
      ticketText: ticket.text,
      watch: 'direct-invocation',
      startedBy: user?.login,
      autoRun: body.autoRun !== false,
    })
    setResponseStatus(event, queued ? 202 : 201)
    return { runId: run.id, status: run.status, workflowSlug: run.workflowSlug, queued }
  } catch (err) {
    if (err instanceof VerificationStartRefused) throw createError({ statusCode: err.statusCode, message: err.message, data: err.runId ? { runId: err.runId } : undefined })
    if (err instanceof WorkspaceBusyError) throw createError({ statusCode: 409, message: `A run is already starting in ${err.workspace}.` })
    throw err
  }
})
