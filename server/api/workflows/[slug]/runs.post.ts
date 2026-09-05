import { startRun } from '../../../utils/workflowRunner'
import { readWorkflow } from '../../../utils/workflows'
import { findActiveRun } from '../../../utils/workflowRunStore'
import { expandTicketKey } from '../../../utils/jiraTicketSource'
import { currentUser } from '../../../utils/session'
import { envForUser } from '../../../utils/users'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')!
  const body = await readBody<{ initialPrompt: string, autoRun?: boolean, projectDir?: string }>(event)
  if (!body?.initialPrompt?.trim()) {
    throw createError({ statusCode: 400, message: 'initialPrompt is required' })
  }

  // One run per workflow: two concurrent runs against the same projectDir would
  // have their agents editing the same files.
  const active = await findActiveRun(slug)
  if (active) {
    throw createError({
      statusCode: 409,
      message: `This workflow already has a run in progress`,
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
  // A bare ticket key becomes the ticket itself when the jira CLI can serve
  // it; otherwise the key is passed through and the intake step works from it.
  const user = await currentUser(event)
  const expanded = await expandTicketKey(body.initialPrompt, await envForUser(user?.login))
  const bareKey = /^[A-Z][A-Z0-9]+-\d+$/.test(body.initialPrompt.trim())
  const initialPrompt = expanded ?? (bareKey
    ? `${body.initialPrompt.trim()}\n\nThe ticket text could not be fetched from Jira for this run. Work from the key and whatever the repository holds, and say so in the context packet. The developer can add a Jira token on the Profile page, or paste the ticket text, and restart.`
    : body.initialPrompt)

  const run = await startRun({
    workflow: { slug: workflow.slug, name: workflow.name, steps: workflow.steps },
    initialPrompt,
    // This route is the manual/API start path, never a watch dispatch — the
    // reserved literal is the honest answer to "what triggered this?".
    watch: 'direct-invocation',
    autoRun: body.autoRun === true,
    projectDir: body.projectDir,
    startedBy: user?.login,
  })
  return run
})
