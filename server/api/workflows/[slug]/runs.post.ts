import { startRun } from '../../../utils/workflowRunner'
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

  const workflow = await $fetch<{ slug: string, name: string, steps: any[] }>(`/api/workflows/${slug}`)
  if (!workflow?.steps?.length) {
    throw createError({ statusCode: 400, message: 'This workflow has no steps' })
  }

  // Deliberately not awaited to completion: the HTTP response returns as soon
  // as the run exists, and the run continues server-side. That is the feature.
  // A bare ticket key becomes the ticket itself when the jira CLI can serve
  // it; otherwise the key is passed through and the intake step works from it.
  const user = await currentUser(event)
  const initialPrompt = (await expandTicketKey(body.initialPrompt, await envForUser(user?.login))) ?? body.initialPrompt

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
