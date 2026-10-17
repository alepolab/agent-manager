/**
 * The ticket context a SessionStart hook pastes into a Claude Code session:
 * the latest run for the ticket and what the risk policy demands of it. See
 * server/api/v1/tickets/[key]/context.get.ts for the route; the text lives
 * here so a test can build a run and read the lines without an HTTP server.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { listRuns } from './workflowRunStore.ts'
import { runArtifactsDir } from './runArtifacts.ts'
import { loadRiskPolicy } from './riskPolicyStore.ts'
import { tierFor } from '../../shared/utils/riskPolicy.ts'
import { oversightFor } from '../../shared/utils/oversight.ts'
import { isTestRun, type WorkflowRun } from '../../shared/types/run.ts'

/**
 * The latest run by start time, test runs excluded: a test re-runs one step of
 * another run and would otherwise shadow the real one. Null when the ticket
 * has never had a run.
 */
export async function latestRunForTicket(key: string): Promise<WorkflowRun | null> {
  return (await listRuns()).find(r => r.ticketKey === key && !isTestRun(r)) ?? null
}

/** The text itself, separated so the test can call it on a run it built. */
export function renderTicketContext(key: string, run: WorkflowRun, base: string): string {
  const policy = loadRiskPolicy()
  const tier = tierFor(policy, run.blastRadius)
  const lines: string[] = [
    `Ticket ${key}: latest run ${run.id} (${run.workflowName}, started by ${run.startedBy ?? 'unknown'}, via ${run.watch}).`,
    `Status: ${run.status}.`,
    `Blast radius: ${run.blastRadius ?? 'unclassified'} (oversight: ${oversightFor(run.blastRadius, policy)}).`,
  ]
  if (run.branch || run.baseBranch) lines.push(`Branch: ${run.branch ?? '(none)'}${run.baseBranch ? ` from ${run.baseBranch}` : ''}.`)
  if (run.question) {
    const step = run.steps.find(s => s.stepId === run.question!.stepId)
    const who = run.question.role ? ` for ${run.question.role}` : ''
    lines.push(`Waiting${who} at "${step?.label ?? run.question.stepId}" (${run.question.kind}${run.question.reason ? `, ${run.question.reason}` : ''}): ${run.question.text}`)
  } else if (run.status === 'running' && run.currentStepIds?.length) {
    const labels = run.currentStepIds.map(id => run.steps.find(s => s.stepId === id)?.label ?? id)
    lines.push(`Running: ${labels.join(', ')}.`)
  }
  const bundle = join(runArtifactsDir(run.id), 'bundle.json')
  if (existsSync(bundle)) {
    lines.push(`Evidence bundle: ${bundle}`)
    lines.push(`Evidence bundle URL: ${base}/api/runs/${run.id}/artifacts/bundle.json`)
  } else {
    lines.push('Evidence bundle: not written yet.')
  }
  lines.push(`Policy for ${run.blastRadius ?? 'unclassified'} (v${policy.version}): reviewers ${tier.reviewers}, specialist ${tier.specialist}, sandbox ${tier.sandbox}, adversarial ${tier.adversarial ? 'required' : 'not required'}, budget ${tier.budget.minutes} min / ${tier.budget.tokens} tokens (panel ${tier.budget.panelTokens}).`)
  lines.push(`Run page: ${base}/runs/${run.id}`)
  return `${lines.join('\n')}\n`
}
