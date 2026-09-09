import { runElapsedMs, type RunClockRecord } from '../../shared/utils/runClock.ts'

/**
 * Presentation helpers shared by everything that renders a run or one of its
 * steps — the run panel and the run-history page today.
 *
 * Extracted rather than copied: this repo already learned the cost of the same
 * lookup table living in several components (see the Model Registry section of
 * CLAUDE.md). A run status rendered green in one view and grey in another is
 * the same class of defect, and it is worse here because the colour is the
 * only thing distinguishing a run that finished from one that died.
 */

/** Every status a WorkflowRun or one of its steps can hold. Keep exhaustive:
 *  an unlisted status falls back to the disabled grey, which reads as
 *  "nothing happened" — the wrong story for a failure. */
export const RUN_STATUS_COLOR = {
  /** Waiting for a slot in its concurrency group. Not the disabled grey a
   *  settled run gets, and not the blue of one that is working: it is going to
   *  run, it has not started. */
  queued: 'var(--text-secondary, #6b7280)',
  running: 'var(--info, #3b82f6)',
  paused: 'var(--warning, #f59e0b)',
  /** Stopped on a person who has entries to decide about. Shares the warning
   *  colour with `paused` deliberately — both mean "this is on you now", and
   *  inventing a seventh hue would say they differ in urgency rather than in
   *  what is being asked. The label is what tells them apart. */
  awaiting_review: 'var(--warning, #f59e0b)',
  completed: 'var(--success, #22c55e)',
  failed: 'var(--error, #ef4444)',
  stopped: 'var(--text-disabled, #9ca3af)',
  interrupted: 'var(--error, #ef4444)',
  pending: 'var(--text-disabled, #9ca3af)',
  skipped: 'var(--text-disabled, #9ca3af)',
  waiting: 'var(--warning, #f59e0b)',
} as Record<string, string>

export function runStatusColor(status: string): string {
  return RUN_STATUS_COLOR[status] ?? 'var(--text-disabled, #9ca3af)'
}

/** How a status reads to a person. The statuses are rendered uppercase all over
 *  this app, and a raw multi-word one arrives as AWAITING_REVIEW — an
 *  identifier, not a phrase. One transformation rather than a label table:
 *  every status name already reads correctly once its underscore is a space. */
export function runStatusLabel(status: string): string {
  return status.replace(/_/g, ' ')
}

/** A run or step is "settled" when nothing further will happen to it. Note
 *  that `skipped` counts: a step the scheduler passed over is finished, not
 *  pending, and counting it as outstanding makes a halted run look like it is
 *  still going. */
export const SETTLED_STATUSES = new Set(['completed', 'failed', 'skipped', 'stopped'])

/** Wall-clock duration, or '' when the thing never started. An in-flight item
 *  is measured to now, so a running step's timer advances.
 *
 *  For a STEP. A run is not the difference between two timestamps — see
 *  runElapsedLabel below and shared/utils/runClock.ts. */
export function elapsedLabel(s: { startedAt?: number, completedAt?: number }): string {
  if (!s.startedAt) return ''
  const end = s.completedAt ?? Date.now()
  const secs = Math.round((end - s.startedAt) / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/**
 * How long a RUN has been executing, formatted for a table cell or a header.
 *
 * Not `elapsedLabel({ startedAt: run.startedAt, completedAt: run.endedAt })`,
 * which is what every one of these call sites used to compute for itself: a
 * restarted run resumes under the same id, so that subtraction reports the
 * hours it spent failed and waiting for someone as run time. The run clock
 * (shared/utils/runClock.ts) counts only the stretches it was actually
 * running. `now` is a parameter so a component with a ticking clock re-renders
 * a live run's duration.
 */
export function runElapsedLabel(run: RunClockRecord, now: number = Date.now()): string {
  const secs = Math.round(runElapsedMs(run, now) / 1000)
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
}

/** What the Duration column and the panel's timer mean, for a `title=`. One
 *  sentence, in one place, so the two surfaces cannot explain it differently. */
export const RUN_DURATION_HINT =
  'Time this run spent executing. Time it sat failed, stopped or paused waiting for a person is not counted, '
  + 'so a restarted run does not accumulate the gap. The Started column shows when it first began.'
