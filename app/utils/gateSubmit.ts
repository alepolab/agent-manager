/**
 * What Cmd/Ctrl+Enter in a gate's note box does: the primary action on
 * screen, or nothing while that action is not ready to send.
 *
 * It used to approve whenever it was not a reply. With "Send back…" open, the
 * operator types the reason for the send-back and presses the shortcut they
 * use everywhere else in the bar - and the note they just typed was exactly
 * what satisfied approval, so the run was approved and the next step started.
 */
export type NoteSubmit = 'respond' | 'rework' | 'continue' | null

export function noteSubmitAction(s: { isReply: boolean, sendingBack: boolean, canRework: boolean, canApprove: boolean }): NoteSubmit {
  if (s.isReply) return 'respond'
  if (s.sendingBack) return s.canRework ? 'rework' : null
  return s.canApprove ? 'continue' : null
}

/**
 * The step "Send back…" opens on: the one the brief's recommended option sends
 * back to, else the only step any option names, else none - a choice between
 * two steps is the reviewer's, not a guess. A recommendation to approve picks
 * nothing on its own account.
 */
export function sendBackPreselect(recommended: string | undefined, targets: { key: string, stepId: string }[]): string {
  const rec = (recommended ?? '').replace(/[()]/g, '').trim().toLowerCase()
  const hit = rec ? targets.find(t => t.key.toLowerCase() === rec) : undefined
  if (hit) return hit.stepId
  const steps = new Set(targets.map(t => t.stepId))
  return steps.size === 1 ? [...steps][0]! : ''
}
