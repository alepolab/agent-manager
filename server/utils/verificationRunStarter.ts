/**
 * Starts Runbook V ("Verify after merge") for a ticket whose change has merged.
 *
 * Two callers, one function: the CI poller, when it sees a run's pull request
 * reach `MERGED`; and `POST /api/v1/runs` with `stage: 'verify'`, for a webhook
 * or a person. Both arrive here with a ticket key and whatever they know about
 * the merge, and both are refused the same two ways - no Runbook V on this
 * instance, or a verification run already live for the ticket - so a PR that
 * merges while a developer has already pressed the button does not start a
 * second one.
 *
 * The run works on a worktree of the merged branch's tip, through the same
 * `branch` parameter the scans use (ensureBranchWorktree): the product's
 * registry names the development branch when the caller does not.
 */
import { findLiveRunForTicket } from './manualStart.ts'
import { loadWorkflowSteps, toWorkflowLike } from './workflowRunStore.ts'
import { startOrQueue } from './workflowRunner.ts'
import { resolveParameters } from '../../shared/utils/workflowParameters.ts'
import { RUNBOOK_FILES } from '../../app/utils/workflowTemplates.ts'
import { ticketKeyFrom } from './jiraTicketSource.ts'
import type { WorkflowRun } from '../../shared/types/run.ts'

export const VERIFY_WORKFLOW_SLUG = RUNBOOK_FILES['runbook-v-verify-after-merge']!

export class VerificationStartRefused extends Error {
  statusCode: number
  runId?: string
  constructor(statusCode: number, message: string, runId?: string) {
    super(message)
    this.name = 'VerificationStartRefused'
    this.statusCode = statusCode
    this.runId = runId
  }
}

export interface VerifyStart {
  issueKey: string
  /** The merged pull request's URL, when known. */
  pr?: string
  /** The merge commit, when known. */
  revision?: string
  /** The branch the PR merged into; the registry's development branch when absent. */
  branch?: string
  /** The ticket's text, when the caller has it; otherwise the key alone opens the run. */
  ticketText?: string | null
  /** `ci-poller:<runId>` for the poller, `direct-invocation` for the route. */
  watch: string
  startedBy?: string
  productKey?: string
  autoRun?: boolean
}

export function verifyPrompt(s: Pick<VerifyStart, 'issueKey' | 'pr' | 'revision' | 'ticketText'>): string {
  const head = `${s.issueKey}: verify the merged change in staging`
  const facts = [
    s.pr ? `Merged pull request: ${s.pr}` : undefined,
    s.revision ? `Merge commit: ${s.revision}` : undefined,
  ].filter(Boolean)
  return [head, ...(facts.length ? ['', ...facts] : []), ...(s.ticketText?.trim() ? ['', s.ticketText.trim()] : [])].join('\n')
}

/** Already verifying this ticket: the live Runbook V run for it, if any. */
export async function liveVerificationFor(issueKey: string): Promise<WorkflowRun | null> {
  const live = await findLiveRunForTicket(issueKey)
  return live && live.workflowSlug === VERIFY_WORKFLOW_SLUG ? live : null
}

export async function startVerificationRun(s: VerifyStart): Promise<{ run: WorkflowRun, queued: boolean }> {
  const issueKey = ticketKeyFrom(s.issueKey) ?? s.issueKey.trim()
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)) throw new VerificationStartRefused(400, `"${s.issueKey}" is not a Jira issue key`)
  const workflow = await loadWorkflowSteps(VERIFY_WORKFLOW_SLUG)
  if (!workflow) throw new VerificationStartRefused(404, `Runbook V (${VERIFY_WORKFLOW_SLUG}) is not seeded on this instance; apply team standards on /team first`)
  if (!workflow.steps.length) throw new VerificationStartRefused(400, 'Runbook V has no steps')
  const already = await liveVerificationFor(issueKey)
  if (already) throw new VerificationStartRefused(409, `${issueKey} already has a verification run (${already.status.replace('_', ' ')})`, already.id)
  const { values: parameters, missing } = resolveParameters(workflow.parameters, {
    ...(s.branch ? { branch: s.branch } : {}),
    ...(s.pr ? { pr: s.pr } : {}),
    ...(s.revision ? { revision: s.revision } : {}),
  })
  if (missing.length) throw new VerificationStartRefused(400, `Runbook V needs ${missing.join(', ')}`)
  return startOrQueue({
    workflow: toWorkflowLike(workflow),
    initialPrompt: verifyPrompt({ ...s, issueKey }),
    watch: s.watch,
    ticketKey: issueKey,
    autoRun: s.autoRun ?? true,
    parameters,
    startedBy: s.startedBy,
    ...(s.productKey ? { productKey: s.productKey } : {}),
  })
}
