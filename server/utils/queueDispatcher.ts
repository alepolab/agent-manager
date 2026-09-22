import type { H3Event } from 'h3'
import { dispatch, readQueue } from './taskQueue.ts'
import { startRun } from './workflowRunner.ts'
import { readWorkflow } from './workflows.ts'
import { currentUser } from './session.ts'
import { envForUser } from './users.ts'
import { fetchTicketForPrompt } from './jiraTicketSource.ts'
import type { DispatchResult } from '../../shared/types/queue.ts'

/**
 * Turns the next queue task into a real run.
 *
 * Separate from taskQueue.ts so the queue's rules — order, dependencies,
 * capacity, the workspace lock — can be tested without a runner, a workflow on
 * disk or a Jira round trip. This file is the only part that needs all three.
 */

/** Guards re-entry: a settle can fire while a dispatch is still mid-flight, and
 *  two dispatchers racing would start the same task twice. */
let inFlight: Promise<DispatchResult> | null = null

export async function dispatchQueue(event?: H3Event): Promise<DispatchResult> {
  if (inFlight) return inFlight
  inFlight = run(event).finally(() => { inFlight = null })
  return inFlight
}

async function run(event?: H3Event): Promise<DispatchResult> {
  // The signed-in developer when a person pressed the button; the queue's
  // recorded owner when the boot driver or the tick fired it. Without the
  // second, a dispatched run has no identity and therefore no Jira token, no
  // git credential and no name on its commits.
  const signedIn = event ? await currentUser(event) : null
  const login = signedIn?.login ?? (await readQueue()).owner
  const env = await envForUser(login)

  return dispatch(async (task) => {
    const workflow = await readWorkflow(task.workflowSlug)
    if (!workflow?.steps?.length) throw new Error(`workflow ${task.workflowSlug} is missing or has no steps`)

    // The ticket is fetched here, exactly as the manual start path does it, so
    // a queued run carries the same enriched prompt a hand-started one gets —
    // including the implementation brief from planBrief.ts.
    const typed = task.detail ?? task.title
    const ticket = await fetchTicketForPrompt(typed, env)
    const initialPrompt = ticket.text ? `${ticket.text}\n\n---\n${typed}` : typed

    return startRun({
      workflow: { slug: workflow.slug, name: workflow.name, steps: workflow.steps },
      initialPrompt,
      watch: 'direct-invocation',
      ticketKey: task.ticketKey,
      ...(task.productKey ? { productKey: task.productKey } : {}),
      // Never autoRun from a queue: the whole point is one at a time under a
      // person's eye, and a queue that also ran every gate unattended would be
      // the opposite of the control it was asked for.
      autoRun: false,
      projectDir: task.projectDir,
      startedBy: login,
    })
  })
}

/**
 * Called when a run settles, so the next task starts without anyone pressing
 * anything. Never throws and never blocks the caller: a queue that could fail
 * a run's own completion path would be worse than a queue that stalls.
 */
export function onRunSettled(): void {
  void dispatchQueue().catch((err) => {
    console.error('[queue] dispatch after settle failed:', err instanceof Error ? err.message : err)
  })
}
