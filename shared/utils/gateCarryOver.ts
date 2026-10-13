import type { RunDecision, WorkflowRun } from '../types/run'

/**
 * A person who approved a change is not asked to approve it again further
 * down the same runbook:
 *
 * - approved at "Jira: Dev Done": not asked again at the PR step
 *   ("Evidence Bundle + PR", or "Push + PR" in Runbook C);
 * - approved at Dev Done or the PR step: not asked again at "Jira: QA Done".
 *
 * Pure, so the runner and its test read the one rule. The runner applies it
 * (server/utils/workflowRunner.ts) and records the carried approval as its own
 * decision, marked `auto`, so the run's history says who it came from.
 */

interface GateStep {
  id: string
  label: string
  agentSlug?: string
  approval?: boolean
  gateRole?: string
  runWhen?: unknown
  jira?: { transition?: string }
}

const transitionIs = (s: GateStep, to: RegExp) => to.test(s.jira?.transition?.trim() ?? '')

/** The "Jira: QA Done" step: a Jira step moving the ticket to QA Done. */
export function isQaDoneStep(s: GateStep): boolean {
  return transitionIs(s, /^qa done$/i) || /^jira:\s*qa done$/i.test(s.label)
}

/** "Jira: Dev Done": a Jira step moving the ticket to Dev Done. */
export function isDevDoneStep(s: GateStep): boolean {
  return transitionIs(s, /^dev done$/i) || /^jira:\s*dev done$/i.test(s.label)
}

/** The step that pushes and opens the pull request: "Evidence Bundle + PR" (Runbooks A, B), "Push + PR" (C). */
export function isPrStep(s: GateStep): boolean {
  return /^sdlc-(evidence-and-pr|ce-ship)$/.test(s.agentSlug ?? '') || /^evidence bundle/i.test(s.label)
}

/**
 * Which earlier gates' approval a gate may take instead of asking, or null when
 * it always asks. QA Done takes Dev Done's or the PR step's; the PR step takes
 * Dev Done's.
 */
export function carriedFrom(s: GateStep): ((earlier: GateStep) => boolean) | null {
  if (isQaDoneStep(s)) return e => isDevDoneStep(e) || isPrStep(e)
  if (isPrStep(s)) return isDevDoneStep
  return null
}

/**
 * The person's approval the gate `gateId` can take, or null to ask as usual.
 *
 * - The gate must be a plain approval gate: one with a `runWhen` is a condition
 *   a carried approval would waive, so it is asked.
 * - The earlier approval must be a person's (not itself carried), at a gate
 *   `carriedFrom` accepts, with the same `gateRole` - the role that may answer
 *   this gate is the one that already did.
 * - It must be newer than the run's last send-back, a person's or an agent's.
 *   A send-back re-runs the work, and the gates it passes ask again; an
 *   approval from before it signed off code that has since changed.
 * - That step must have completed on its latest visit.
 *
 * The newest such approval wins, so the record names the latest sign-off.
 */
export function earlierApprovalFor(
  run: Pick<WorkflowRun, 'decisions' | 'sendBacks' | 'steps'>,
  steps: GateStep[],
  gateId: string,
): RunDecision | null {
  const qa = steps.find(s => s.id === gateId)
  const accepts = qa && carriedFrom(qa)
  if (!qa || !accepts || !qa.approval || qa.runWhen) return null
  const decisions = run.decisions ?? []
  const lastSendBack = Math.max(0,
    ...decisions.filter(d => d.verdict === 'sent-back').map(d => d.at),
    ...(run.sendBacks ?? []).map(b => b.at))
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i]!
    if (d.verdict !== 'approved' || d.auto || d.at <= lastSendBack) continue
    const gate = steps.find(s => s.id === d.stepId)
    if (!gate || gate.id === qa.id || !gate.approval || !accepts(gate)) continue
    if ((gate.gateRole ?? '') !== (qa.gateRole ?? '')) continue
    if (run.steps.find(s => s.stepId === d.stepId)?.status !== 'completed') continue
    return d
  }
  return null
}

/** The decision recorded when a gate takes an earlier approval instead of asking. */
export function carriedDecision(qa: GateStep, from: RunDecision, blastRadius?: string, at = Date.now()): RunDecision {
  return {
    stepId: qa.id,
    label: qa.label,
    at,
    by: `auto: earlier approval by ${from.by} at ${from.label}`,
    verdict: 'approved',
    waitedMs: 0,
    auto: true,
    ...(blastRadius ? { blastRadius } : {}),
  }
}
