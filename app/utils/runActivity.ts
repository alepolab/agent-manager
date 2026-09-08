/**
 * What a live run is doing right now, derived from the run record alone.
 *
 * Kept out of the component because these are the decisions worth being sure
 * about — which step counts as "current", and when silence is worth flagging —
 * and a computed inside an SFC cannot be run by the plain-node tests this repo
 * uses. See scripts/test-run-activity.mjs.
 */
import type { RunStep, WorkflowRun } from '~~/shared/types/run'

/** A step that will never change again; the same set the store settles on. */
const SETTLED = new Set(['completed', 'failed', 'skipped'])

/**
 * The step to name on a live run.
 *
 * A running step is the answer when there is one. A PAUSED run has none — it
 * stopped between steps, usually waiting on a person — and the useful answer
 * there is the step it is about to run, which is what the scheduler recorded in
 * currentStepIds. Falling back to the first unsettled step keeps a record
 * written by an older version from rendering blank.
 */
export function currentStep(run: WorkflowRun): RunStep | undefined {
  return run.steps.find(s => s.status === 'running')
    ?? run.steps.find(s => run.currentStepIds?.includes(s.stepId))
    ?? run.steps.find(s => !SETTLED.has(s.status))
}

/** Steps behind it, for "3/11". `skipped` counts as done: the run passed it. */
export function stepsDone(run: WorkflowRun): number {
  return run.steps.filter(s => SETTLED.has(s.status) && s.status !== 'failed').length
}

/**
 * Seconds since the agent last reported anything, or null when it never has.
 *
 * Null is not zero. A step whose caller reported no telemetry (a stub, or a
 * call that died before its first assistant turn) has not been quiet for 0
 * seconds — nothing is known — and drawing that as "0s ago" would invent a
 * heartbeat that was never measured.
 */
export function quietSeconds(step: RunStep | undefined, now: number): number | null {
  return step?.lastActivityAt ? Math.max(0, Math.round((now - step.lastActivityAt) / 1000)) : null
}

/**
 * Long enough that an ordinary slow tool call does not trip it: a step sits
 * legitimately silent through a docker build, an install or a long test run.
 * This is a prompt to go and look, never a verdict that anything is wrong.
 */
export const QUIET_WARN_SECONDS = 180

/** Only a RUNNING run can be quiet. A paused one is not slow — it is waiting on
 *  a person, which the card says in words instead. */
export function isQuiet(run: WorkflowRun, step: RunStep | undefined, now: number): boolean {
  if (run.status !== 'running') return false
  const secs = quietSeconds(step, now)
  return secs !== null && secs >= QUIET_WARN_SECONDS
}

/** "45s" / "6m" — a duration in the smallest unit that still reads at a glance. */
export function shortDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000))
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`
}
