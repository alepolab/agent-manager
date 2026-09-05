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
export const RUN_STATUS_COLOR: Record<string, string> = {
  running: 'var(--info, #3b82f6)',
  paused: 'var(--warning, #f59e0b)',
  completed: 'var(--success, #22c55e)',
  failed: 'var(--error, #ef4444)',
  stopped: 'var(--text-disabled, #9ca3af)',
  interrupted: 'var(--error, #ef4444)',
  pending: 'var(--text-disabled, #9ca3af)',
  skipped: 'var(--text-disabled, #9ca3af)',
}

export function runStatusColor(status: string): string {
  return RUN_STATUS_COLOR[status] ?? 'var(--text-disabled, #9ca3af)'
}

/** A run or step is "settled" when nothing further will happen to it. Note
 *  that `skipped` counts: a step the scheduler passed over is finished, not
 *  pending, and counting it as outstanding makes a halted run look like it is
 *  still going. */
export const SETTLED_STATUSES = new Set(['completed', 'failed', 'skipped', 'stopped'])

/** Wall-clock duration, or '' when the thing never started. An in-flight item
 *  is measured to now, so a running step's timer advances. */
export function elapsedLabel(s: { startedAt?: number, completedAt?: number }): string {
  if (!s.startedAt) return ''
  const end = s.completedAt ?? Date.now()
  const secs = Math.round((end - s.startedAt) / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}
