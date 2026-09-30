import type { WorkflowRun } from '~~/shared/types/run'
import { needsJustification } from '~~/shared/utils/oversight'
import { gateIsMine } from '~~/shared/utils/notifications'

export type GateAction = 'respond' | 'continue' | 'reject' | 'rework'
export interface GateEmits {
  respond: (reply: string) => void
  continue: (note?: string) => void
  reject: (note: string) => void
  rework: (stepId: string, note: string) => void
}

/**
 * Answering a run's open gate: who may, what a send-back may target, and the
 * "recorded, waiting for the run" state between a click and the run acting on
 * it. Shared by RunGate (inside a run's stack) and GateDecision (the inbox), so
 * the two can never disagree about who is allowed to approve what.
 */
export function useGateAnswer(run: Ref<WorkflowRun>, emit: GateEmits) {
  const { can, role } = useUser()
  /** Mirrors requireGateRole on the server, as a courtesy: the server is what refuses. */
  const gateOwner = computed(() => run.value.question?.role)
  const mineToAnswer = computed(() => gateIsMine(gateOwner.value, role.value))
  const mayAnswer = computed(() => can('answerGate') && mineToAnswer.value)
  const mustJustify = computed(() => needsJustification(run.value.blastRadius))
  /** Gated on an artifact's entries: RunDecisionPanel owns both the question and the resume. */
  const reviewing = computed(() => run.value.status === 'awaiting_review')
  const isReply = computed(() => run.value.status === 'paused' && run.value.question?.kind === 'question')
  const isApproval = computed(() => run.value.status === 'paused' && run.value.question?.kind === 'approval')
  /** A pause the runner raised about itself - budget spent, model unreachable - rather than a gate on the work. */
  const runnerPause = computed(() => ['budget', 'auth', 'quota'].includes(run.value.question?.reason ?? ''))

  const note = ref('')
  const canApprove = computed(() => !mustJustify.value || !!note.value.trim())

  /** Where a send-back goes. The reviewer picks; the run never guesses. Candidates are steps that have run. */
  const stepSettled = (s: { status: string }) => ['completed', 'failed', 'skipped'].includes(s.status)
  const reworkTarget = ref('')
  const reworkCandidates = computed(() => run.value.steps.filter(s => stepSettled(s) && s.stepId !== run.value.question?.stepId))
  const reworksLeft = computed(() => 2 - (run.value.reworks ?? 0))
  const canSendBack = computed(() => isApproval.value && !runnerPause.value && reworkCandidates.value.length > 0 && reworksLeft.value > 0)
  watch(() => run.value.id, () => { reworkTarget.value = ''; note.value = '' })

  /**
   * A decision this person has just sent and the run has not yet acted on.
   * Approving can take a while - the runner re-checks the environment before the
   * next step starts - and the panel used to show nothing in the meantime, so
   * "Approve and run" looked like a button that had not registered the click.
   * Cleared when the run leaves the gate (its status or question changes, which
   * the live stream reports), and after a minute regardless, so a request that
   * failed - reported by its own toast - does not leave the panel locked.
   */
  const sending = ref<null | GateAction>(null)
  let sendingTimer: ReturnType<typeof setTimeout> | undefined
  watch(() => [run.value.status, run.value.question?.stepId, run.value.question?.askedAt], () => {
    sending.value = null
    clearTimeout(sendingTimer)
  })
  onBeforeUnmount(() => clearTimeout(sendingTimer))
  const SENDING_LABEL: Record<GateAction, string> = {
    continue: 'Approval recorded - starting the next step…',
    respond: 'Reply recorded - the step is picking it up…',
    reject: 'Rejection recorded - ending the run…',
    rework: 'Send-back recorded - restarting that step…',
  }

  /** `text` overrides the note, for an answer composed from a chosen option. */
  function send(kind: GateAction, text = note.value.trim()) {
    sending.value = kind
    clearTimeout(sendingTimer)
    sendingTimer = setTimeout(() => { sending.value = null }, 60_000)
    if (kind === 'rework') emit.rework(reworkTarget.value, text)
    else if (kind === 'reject') emit.reject(text)
    else if (kind === 'respond') emit.respond(text)
    else emit.continue(text || undefined)
    note.value = ''
    reworkTarget.value = ''
  }

  /** How long this gate has waited on a person, ticking. */
  const now = ref(Date.now())
  let clock: ReturnType<typeof setInterval> | null = null
  onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
  onUnmounted(() => { if (clock) clearInterval(clock) })
  const waitingLabel = computed(() => {
    const asked = run.value.question?.askedAt
    if (!asked) return 'for a decision'
    const secs = Math.max(0, Math.round((now.value - asked) / 1000))
    if (secs < 60) return `${secs}s`
    if (secs < 3600) return `${Math.floor(secs / 60)}m`
    return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
  })
  const askingStep = computed(() => run.value.steps.find(s => s.stepId === run.value.question?.stepId))

  /** The label on the approve button, which says what it does for a runner pause. */
  const approveLabel = computed(() => {
    const r = run.value.question?.reason
    return r === 'budget' ? 'Continue with a fresh allowance' : r === 'auth' ? 'Retry the step' : r === 'quota' ? 'Retry now' : 'Approve and run'
  })
  /** The eyebrow over the question. */
  const gateLabel = computed(() => {
    const q = run.value.question
    return q?.reason === 'budget' ? 'Budget reached'
      : q?.reason === 'auth' ? 'Could not reach the model'
      : q?.reason === 'quota' ? 'Waiting for the quota to reset'
      : q?.reason === 'rework' ? 'Send-backs spent'
      : q?.kind === 'approval' ? 'Waiting for your approval'
      : `${askingStep.value?.label ?? 'A step'} is asking you`
  })

  return {
    role, gateOwner, mineToAnswer, mayAnswer, mustJustify, reviewing, isReply, isApproval, runnerPause,
    note, canApprove, reworkTarget, reworkCandidates, reworksLeft, canSendBack,
    sending, SENDING_LABEL, send, waitingLabel, askingStep, approveLabel, gateLabel,
  }
}
