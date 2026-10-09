/**
 * Where a run started by hand will work, and whether it may start at all.
 *
 * A start that names a ticket and no directory gets a directory of its own for
 * that ticket - the one a dispatched child gets (see the dispatch step in
 * workflowRunner.ts) - and the run's worktree is made beside the product clone
 * from there. Locked on the developer's workspace root instead, as it used to
 * be, a second ticket was refused while the first ran: ASECRM-581 and 582 were
 * started after 580 and never appeared, though each would have worked in a
 * worktree of its own.
 *
 * What a ticket's own directory cannot see is a run for the SAME ticket, which
 * moves to its worktree once it has a branch. That is asked of the ticket key:
 * two runs on one ticket cut two branches and open two pull requests for one
 * change, so the second is refused and named, waiting on a person included.
 *
 * A stated directory, and a start that names no ticket, keep the directory
 * lock exactly as it was.
 */
import { join } from 'node:path'
import { isLiveStatus, isTestRun, type WorkflowRun } from '../../shared/types/run.ts'
import { safeSegment } from './claudeDir.ts'
import { ticketKeyFrom } from './jiraTicketSource.ts'
import { findRunInWorkspace, listRuns } from './workflowRunStore.ts'
import { runWorkspace, workspaceRootFor } from './workspace.ts'

export class ManualStartRefused extends Error {
  readonly runId: string
  constructor(message: string, runId: string) {
    super(message)
    this.name = 'ManualStartRefused'
    this.runId = runId
  }
}

/** A run on `ticketKey` that has not reached an outcome, test runs aside. */
export async function findLiveRunForTicket(ticketKey: string): Promise<WorkflowRun | null> {
  return (await listRuns()).find(r => r.ticketKey === ticketKey && isLiveStatus(r.status) && !isTestRun(r)) ?? null
}

/**
 * The directory a manual start works in, or a refusal naming the run in its
 * way. `stated` is the canonical directory the person typed, if any.
 */
export async function claimManualStart(opts: { initialPrompt: string, stated?: string, login?: string }):
  Promise<{ projectDir?: string, workspace: string, ticketKey?: string }> {
  const ticketKey = ticketKeyFrom(opts.initialPrompt)
  let projectDir = opts.stated

  if (!projectDir && ticketKey) {
    const same = await findLiveRunForTicket(ticketKey)
    if (same) {
      const who = same.startedBy ? ` by @${same.startedBy}` : ''
      throw new ManualStartRefused(
        `${ticketKey} already has a run${who} (${same.workflowName ?? same.workflowSlug}, ${same.status.replace('_', ' ')}).`
        + ' Open it, or stop it before starting another.',
        same.id,
      )
    }
    projectDir = join(workspaceRootFor(opts.login), safeSegment(ticketKey))
  }

  const workspace = runWorkspace({ projectDir, startedBy: opts.login })
  const active = await findRunInWorkspace(workspace)
  if (active) {
    throw new ManualStartRefused(
      `${active.startedBy ? `@${active.startedBy} has` : 'There is'} a run in progress in ${workspace}`
      + ` (${active.workflowName ?? active.workflowSlug}). Wait for it, stop it, or start this one against a different project directory.`,
      active.id,
    )
  }
  return { projectDir, workspace, ticketKey }
}
