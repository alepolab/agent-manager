import { startRun } from '../../../utils/workflowRunner'
import { readWorkflow } from '../../../utils/workflows'
import { findRunInWorkspace } from '../../../utils/workflowRunStore'
import { runWorkspace } from '../../../utils/workspace'
import { fetchTicketForPrompt, ticketKeyFrom } from '../../../utils/jiraTicketSource'
import { currentUser } from '../../../utils/session'
import { envForUser } from '../../../utils/users'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')!
  const body = await readBody<{ initialPrompt: string, autoRun?: boolean, projectDir?: string }>(event)
  if (!body?.initialPrompt?.trim()) {
    throw createError({ statusCode: 400, message: 'initialPrompt is required' })
  }

  // Locked on the DIRECTORY a run will write, not on the workflow. Two runs
  // sharing a checkout corrupt each other; two developers working on unrelated
  // products share nothing, and a per-workflow lock made the second one wait
  // behind the first with no queue — which made the pipeline single-user.
  //
  // The check has to come after the user is known, because an unset projectDir
  // resolves to that developer's own workspace root.
  const user = await currentUser(event)
  const workspace = runWorkspace({ projectDir: body.projectDir, startedBy: user?.login })
  const active = await findRunInWorkspace(workspace)
  if (active) {
    throw createError({
      statusCode: 409,
      message: `${active.startedBy ? `@${active.startedBy} has` : 'There is'} a run in progress in ${workspace}`
        + ` (${active.workflowName ?? active.workflowSlug}). Wait for it, stop it, or start this one against a different project directory.`,
      data: { runId: active.id },
    })
  }

  // Read from disk, never over our own HTTP API: a server-to-self $fetch sends
  // no cookies, so the auth middleware answered this with 401 "Sign in
  // required" and every run start in team mode died on an unhandled
  // FetchError. Standalone mode hid it because AUTH_DISABLED makes the
  // middleware a no-op.
  const workflow = await readWorkflow(slug)
  if (!workflow) {
    throw createError({ statusCode: 404, message: 'Workflow not found' })
  }
  if (!workflow.steps?.length) {
    throw createError({ statusCode: 400, message: 'This workflow has no steps' })
  }

  // Deliberately not awaited to completion: the HTTP response returns as soon
  // as the run exists, and the run continues server-side. That is the feature.
  // The ticket named anywhere in the prompt is fetched here, under the starter's
  // identity, before any agent runs: agents have no shell and no Jira access, so
  // a ticket they are left to fetch is a ticket nobody fetches. When the read
  // fails the prompt says why, and says not to try.
  const typed = body.initialPrompt.trim()
  const ticket = await fetchTicketForPrompt(typed, await envForUser(user?.login))
  const initialPrompt = ticket.text
    ? (typed === ticket.key ? ticket.text : `${ticket.text}\n\n---\nStarted with: ${typed}`)
    : ticket.key
      ? `${typed}\n\nThe ticket text could not be fetched from Jira for this run (${ticket.reason}). Work from the key and whatever the repository holds, say so in the context packet, and do not try to reach Jira yourself: agents have no shell and no Jira access. The developer can add a Jira token on the Profile page, or paste the ticket text, and start again.`
      : body.initialPrompt

  const run = await startRun({
    workflow: { slug: workflow.slug, name: workflow.name, steps: workflow.steps },
    initialPrompt,
    // This route is the manual/API start path, never a watch dispatch — the
    // reserved literal is the honest answer to "what triggered this?".
    watch: 'direct-invocation',
    // Read from the prompt, so a run started by hand reports back to its ticket
    // the way a watch-dispatched one does. Without it notifyTicketOutcome never
    // fires for a manual run - the key was in the prompt and nothing looked.
    ticketKey: ticketKeyFrom(body.initialPrompt),
    autoRun: body.autoRun === true,
    projectDir: body.projectDir,
    startedBy: user?.login,
  })
  return run
})
