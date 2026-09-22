import type { WorkflowRun, RunDecision } from '../types/run'

/**
 * Gate decisions: recording them, and reading what they cost in human time.
 *
 * In `shared/` rather than `server/` because both halves need it and neither
 * function touches the filesystem or the request: the routes record a decision,
 * and the manager board reads the latency back out. Duplicating the arithmetic
 * on the client is how the two would come to disagree — the same mistake this
 * repo already paid for with run duration (see shared/utils/runClock.ts).
 */

/**
 * Write a gate decision onto the run, before the decision takes effect.
 *
 * Order matters and is the whole reason this is a helper rather than three
 * copies. Every one of the three answers destroys the evidence it needs:
 * `continue` clears `run.question`, `reject` replaces the run's status, and
 * `rework` restarts a step which re-reads the run from disk. So the decision has
 * to be recorded from the run as it stands *now*, while `question.askedAt` is
 * still there to measure against — afterwards the wait is gone for good.
 *
 * Append-only, and never a source of truth about what the run then did: it
 * records what a person chose, not whether it worked.
 */
export function recordDecision(
  run: WorkflowRun,
  verdict: RunDecision['verdict'],
  by: string,
  note?: string,
  target?: string,
): RunDecision | null {
  const question = run.question
  // No question means no gate was waiting, so there is no decision to record —
  // and inventing one with `waitedMs: 0` would put a figure in the record that
  // nothing measured, which a board summing them would under-report.
  if (!question) return null

  const at = Date.now()
  const decision: RunDecision = {
    stepId: question.stepId,
    label: run.steps.find(s => s.stepId === question.stepId)?.label ?? question.stepId,
    at,
    by,
    verdict,
    // Carried so separation of duties can ask "who answered the implementation
    // gate on this run" without re-deriving it from a step label a template
    // rename would invalidate.
    ...(question.gateKind ? { gateKind: question.gateKind } : {}),
    // Clamped at zero rather than trusted: askedAt comes from the server that
    // raised the gate, and a negative wait would be a clock artefact, not a fact.
    waitedMs: Math.max(0, at - question.askedAt),
    ...(note ? { note } : {}),
    ...(target ? { target } : {}),
    ...(run.blastRadius ? { blastRadius: run.blastRadius } : {}),
  }
  run.decisions = [...(run.decisions ?? []), decision]
  return decision
}

/**
 * Milliseconds this run has spent waiting on people at gates, over its whole life.
 *
 * The figure the manager board exists to show, and the one nothing computed: a
 * run's wall clock minus `activeMs` says how long it was not executing, but not
 * why. This says how much of that was a person.
 */
export function humanWaitMs(run: WorkflowRun): number {
  const decided = (run.decisions ?? []).reduce((sum, d) => sum + d.waitedMs, 0)
  // A gate open right now has not been decided, so it is in no decision yet;
  // its wait is still accruing, and omitting it would report the most stuck run
  // on the board as the cheapest.
  const open = run.question ? Math.max(0, Date.now() - run.question.askedAt) : 0
  return decided + open
}
