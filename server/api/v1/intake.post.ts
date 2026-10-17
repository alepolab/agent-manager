import { readRawBody } from 'h3'
import { acceptIntake, INTAKE_SHADOW_HEADER, INTAKE_SIGNATURE_HEADER, intakeSecret, parseIntake, verifyIntakeSignature } from '../../utils/intake.ts'
import { agentManagerSettings, settingString } from '../../utils/appSettings.ts'
import { loadWorkflowSteps, toWorkflowLike } from '../../utils/workflowRunStore.ts'
import { startOrQueue } from '../../utils/workflowRunner.ts'
import { fetchTicketForPrompt } from '../../utils/jiraTicketSource.ts'

/**
 * POST /api/v1/intake - a signed webhook that says a ticket wants a run.
 *
 * Not a session route: the auth middleware lets it through (isPublicApiPath)
 * and this handler authenticates by HMAC-SHA256 over the raw body instead,
 * which is why it carries no role-capability guard and is listed as an
 * exception in scripts/test-routes-are-guarded.mjs. See server/utils/intake.ts.
 *
 * A run starts only when `agentManager.intakeWorkflow` names a workflow; until
 * then every accepted intake is recorded, which is deliberately the same thing
 * `X-Shadow: 1` does.
 */
export default defineEventHandler(async (event) => {
  const secret = intakeSecret()
  if (!secret) throw createError({ statusCode: 503, message: 'The intake is not configured: set agentManager.intakeSecret in settings.json.' })
  const raw = (await readRawBody(event, 'utf8')) ?? ''
  if (!verifyIntakeSignature(raw, getRequestHeader(event, INTAKE_SIGNATURE_HEADER), secret)) {
    throw createError({ statusCode: 401, message: `Bad or missing ${INTAKE_SIGNATURE_HEADER} (HMAC-SHA256 hex over the raw body).` })
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw createError({ statusCode: 400, message: 'The body is not JSON.' }) }
  const checked = parseIntake(parsed)
  if ('error' in checked) throw createError({ statusCode: 400, message: checked.error })

  const shadow = (getRequestHeader(event, INTAKE_SHADOW_HEADER) ?? '').trim() === '1'
  const record = await acceptIntake(checked.payload, {
    shadow,
    start: async (payload) => {
      const slug = settingString(agentManagerSettings().intakeWorkflow)
      if (!slug) return null
      const workflow = await loadWorkflowSteps(slug)
      if (!workflow?.steps?.length) throw createError({ statusCode: 500, message: `intakeWorkflow "${slug}" is not a workflow with steps.` })
      // The ticket text, under the instance's identity: agents cannot reach Jira.
      const ticket = await fetchTicketForPrompt(payload.issueKey).catch(() => ({ key: payload.issueKey, text: null as string | null }))
      const { run } = await startOrQueue({
        workflow: toWorkflowLike(workflow),
        initialPrompt: ticket.text ?? `${payload.issueKey}: work this ticket. Its text could not be fetched from Jira; work from the key and the repository, and say so.`,
        watch: 'intake',
        ticketKey: payload.issueKey,
        autoRun: true,
      })
      return { runId: run.id }
    },
  })
  setResponseStatus(event, record.disposition === 'started' ? 202 : 200)
  return record
})
