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
