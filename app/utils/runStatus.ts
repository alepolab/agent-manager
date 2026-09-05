/** One colour per run/step status, shared by the run panel, the progress bar and the Runs page. */
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
