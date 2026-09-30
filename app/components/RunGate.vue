<script setup lang="ts">
import { HOLD } from '~~/shared/types/workflowGroup'
import type { WorkflowRun } from '~~/shared/types/run'
import { needsJustification } from '~~/shared/utils/oversight'
import { gateIsMine } from '~~/shared/utils/notifications'

/**
 * A run's open decision: the question, whose it is, the evidence being
 * approved, and the answers. Shared by RunStack, which renders it inside the
 * card of the step that is waiting. Renders when a question is set, or the
 * run is awaiting_review or paused.
 */
const props = defineProps<{ run: WorkflowRun }>()
const emit = defineEmits<{ respond: [reply: string], continue: [note?: string], reject: [note: string], rework: [stepId: string, note: string] }>()

const { can, role } = useUser()
/** Mirrors requireGateRole on the server, as a courtesy: the server is what refuses. */
const gateOwner = computed(() => props.run.question?.role)
const mineToAnswer = computed(() => gateIsMine(gateOwner.value, role.value))
const mayAnswer = computed(() => can('answerGate') && mineToAnswer.value)
const mustJustify = computed(() => needsJustification(props.run.blastRadius))
/** Gated on an artifact's entries: RunDecisionPanel owns both the question and the resume. */
const reviewing = computed(() => props.run.status === 'awaiting_review')
const isReply = computed(() => props.run.status === 'paused' && props.run.question?.kind === 'question')
const shown = computed(() => !!props.run.question || reviewing.value || props.run.status === 'paused' || (props.run.status === 'queued' && !!props.run.parked))
const PARKED_LABEL = { continue: 'Your decision is', respond: 'Your answer is', restart: 'The restart is' } as const
/** A pause the runner raised about itself - budget spent, model unreachable - rather than a gate on the work. */
const runnerPause = computed(() => ['budget', 'auth', 'quota'].includes(props.run.question?.reason ?? ''))
/**
 * The asking step's own report, behind its question. Shown open when the step
 * wrote no decision brief - the one `PIPELINE-ASK:` line alone named "criteria
 * 2-3" and three options with nothing to explain them - and collapsed beneath
 * the brief when it did.
 */
const askContext = computed(() => {
  const q = props.run.question
  if (q?.kind !== 'question') return ''
  const out = props.run.steps.find(s => s.stepId === q.stepId)?.output ?? ''
  return out.replace(/^PIPELINE-ASK:.*$/m, '').trim()
})

const note = ref('')
const canApprove = computed(() => !mustJustify.value || !!note.value.trim())
const placeholder = computed(() => (isReply.value
  ? 'Your answer to the agent'
  : 'Optional note for the step about to run, e.g. target the SaskTel branch policy'))

/** Where a send-back goes. The reviewer picks; the run never guesses. Candidates are steps that have run. */
const stepSettled = (s: { status: string }) => ['completed', 'failed', 'skipped'].includes(s.status)
const reworkTarget = ref('')
const reworkCandidates = computed(() => props.run.steps.filter(s => stepSettled(s) && s.stepId !== props.run.question?.stepId))
const reworksLeft = computed(() => 2 - (props.run.reworks ?? 0))
watch(() => props.run.id, () => { reworkTarget.value = ''; note.value = '' })

const noteBox = ref<HTMLTextAreaElement | null>(null)
/** An option chosen from the brief becomes the reply, for the person to send or add to. */
function chooseOption(text: string) {
  note.value = text
  nextTick(() => noteBox.value?.focus())
}

/**
 * A decision this person has just sent and the run has not yet acted on.
 * Approving can take a while - the runner re-checks the environment before the
 * next step starts - and the panel used to show nothing in the meantime, so
 * "Approve and run" looked like a button that had not registered the click.
 * Cleared when the run leaves the gate (its status or question changes, which
 * the live stream reports), and after a minute regardless, so a request that
 * failed - reported by its own toast - does not leave the panel locked.
 */
const sending = ref<null | 'respond' | 'continue' | 'reject' | 'rework'>(null)
let sendingTimer: ReturnType<typeof setTimeout> | undefined
watch(() => [props.run.status, props.run.question?.stepId, props.run.question?.askedAt], () => {
  sending.value = null
  clearTimeout(sendingTimer)
})
onBeforeUnmount(() => clearTimeout(sendingTimer))
const SENDING_LABEL: Record<NonNullable<typeof sending.value>, string> = {
  continue: 'Approval recorded - starting the next step…',
  respond: 'Reply recorded - the step is picking it up…',
  reject: 'Rejection recorded - ending the run…',
  rework: 'Send-back recorded - restarting that step…',
}

function send(kind: 'respond' | 'continue' | 'reject' | 'rework') {
  const text = note.value.trim()
  sending.value = kind
  clearTimeout(sendingTimer)
  sendingTimer = setTimeout(() => { sending.value = null }, 60_000)
  if (kind === 'rework') emit('rework', reworkTarget.value, text)
  else if (kind === 'reject') emit('reject', text)
  else if (kind === 'respond') emit('respond', text)
  else emit('continue', text || undefined)
  note.value = ''
  reworkTarget.value = ''
}

/** How long this gate has waited on a person, ticking. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })
const waitingLabel = computed(() => {
  const asked = props.run.question?.askedAt
  if (!asked) return 'for a decision'
  const secs = Math.max(0, Math.round((now.value - asked) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
})
const askingLabel = computed(() => `${props.run.steps.find(s => s.stepId === props.run.question?.stepId)?.label ?? 'A step'} is asking you`)
</script>

<template>
  <div v-if="shown" class="space-y-3" data-testid="run-gate">
    <!-- A decision taken while the group was full: recorded, and carried out
         by the queue when a slot frees - it is not lost and not re-asked. -->
    <div v-if="run.status === 'queued' && run.parked" class="rounded-lg p-3 t-small space-y-1" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);" role="status">
      <template v-if="run.parked.gaveWayTo === HOLD">
        <p class="t-head m-0" style="color: var(--text-primary);">Paused: its group is on hold</p>
        <p class="m-0 text-label">
          It finished the step it was on and stopped there. When the hold is lifted it carries on from the next
          step, ahead of newer runs.
        </p>
      </template>
      <template v-else-if="run.parked.gaveWayTo">
        <p class="t-head m-0" style="color: var(--text-primary);">Stepped aside while {{ run.parked.gaveWayTo }} runs are working</p>
        <p class="m-0 text-label">
          Its group gives way to {{ run.parked.gaveWayTo }} so they get the machine to themselves. The step it had
          finished stays finished; it goes ahead of newer runs and carries on from the next step when they are done.
        </p>
      </template>
      <template v-else>
      <p class="t-head m-0" style="color: var(--text-primary);">{{ PARKED_LABEL[run.parked.action] }} recorded - waiting for a free slot</p>
      <p class="m-0 text-label">
        Its group is running as many runs as it allows. This run goes ahead of newer ones in the queue and
        {{ run.parked.action === 'restart' ? 'restarts' : 'continues' }} the moment a slot frees.
        <template v-if="run.parked.note || run.parked.reply">Your note: "{{ run.parked.reply ?? run.parked.note }}"</template>
      </p>
      </template>
    </div>
    <div v-if="run.question && !run.parked" class="rounded-lg p-3 t-small space-y-1" style="background: var(--accent-muted); border: 1px solid var(--accent);" role="alert">
      <!-- The eyebrow is the label; the question is the thing to read. These were
           the same size, inside a box built exactly like the two informational
           boxes above it — which is how the console's whole reason to exist came
           to look like a footnote. -->
      <div class="t-label" style="color: var(--text-secondary);">{{ run.question.reason === 'budget' ? 'Budget reached' : run.question.reason === 'auth' ? 'Could not reach the model' : run.question.reason === 'quota' ? 'Waiting for the quota to reset' : run.question.reason === 'rework' ? 'Send-backs spent' : run.question.kind === 'approval' ? 'Waiting for your approval' : askingLabel }}</div>
      <p class="t-head whitespace-pre-wrap" style="color: var(--text-primary);">{{ run.question.text }}</p>
      <p v-if="run.blastRadius" class="t-small mt-1 text-label">
        Blast radius <span class="font-mono">{{ run.blastRadius }}</span>{{ mustJustify ? ' — owner-gated: a written reason is required to approve.' : '' }}
      </p>
      <!-- How long this has been waiting on a person. The figure existed on the
           record (question.askedAt) and was rendered nowhere, so neither the
           reviewer nor anyone watching could see a gate going stale. -->
      <p class="t-small text-label">
        Waiting {{ waitingLabel }}<template v-if="(run.reworks ?? 0) > 0"> · sent back {{ run.reworks }} of 2 times already</template>
      </p>
      <!-- Whose decision this is. Said out loud when it is not yours, because a
           panel with the controls quietly removed is indistinguishable from a
           broken one. -->
      <p v-if="gateOwner" class="t-small" :style="{ color: mineToAnswer ? 'var(--text-tertiary)' : 'var(--warning)' }">
        <template v-if="mineToAnswer">This gate is <span class="font-mono">{{ gateOwner }}</span>'s decision — yours to answer.</template>
        <template v-else>This gate is <span class="font-mono">{{ gateOwner }}</span>'s decision, not yours. You are {{ role }}.</template>
      </p>
    </div>
    <!-- A run gated on the entries of an artifact gets the panel that can take
         those decisions, not the one-line banner and the single Approve button
         below: approving the step acts on every entry, which is the thing the
         reviewer is here to prevent. -->
    <RunDecisionPanel v-if="reviewing" :run="run" />
    <!-- What the reviewer is actually approving. The gate used to show a step
         label and one line of agent prose, with the measured change, the test
         results and the security verdict all sitting unread in the bundle. -->
    <RunBudgetBrief v-else-if="run.question?.reason === 'budget' && !run.parked" :run="run" />
    <RunVerdictCard
      v-else-if="run.question?.kind === 'approval' && !runnerPause && !run.parked"
      :run="run"
    />
    <!-- A step's question: its brief, laid out for someone who has not read
         the ticket or the report. The banner above carries the question once. -->
    <RunDecisionBrief
      v-else-if="run.question?.kind === 'question' && run.question.brief && !run.parked"
      :brief="run.question.brief" :can-answer="mayAnswer && run.status === 'paused'" @choose="chooseOption"
    />
    <details
      v-if="run.question?.kind === 'question' && askContext && !run.parked" :open="!run.question.brief"
      class="rounded-lg p-3 t-small" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);"
    >
      <summary class="cursor-pointer font-medium" style="color: var(--text-primary);">
        {{ run.question.brief ? "The step's full report" : 'The step wrote no decision brief - its report' }}
      </summary>
      <pre class="whitespace-pre-wrap font-sans mt-2 max-h-96 overflow-y-auto" style="color: var(--text-secondary);">{{ askContext }}</pre>
    </details>
    <textarea
      v-if="!reviewing && mayAnswer && run.status === 'paused'"
      ref="noteBox"
      v-model="note"
      rows="2"
      class="field-input w-full resize-none t-small"
      :placeholder="placeholder"
      :aria-label="placeholder"
      @keydown.meta.enter="isReply ? send('respond') : send('continue')"
    />
    <div class="flex flex-wrap gap-2">
      <UButton v-if="mayAnswer && !reviewing && isReply" size="xs" icon="i-lucide-send" label="Reply" :loading="sending === 'respond'" :disabled="!!sending || !note.trim()" @click="send('respond')" />
      <UButton
        v-else-if="mayAnswer && run.status === 'paused' && run.question?.kind === 'approval'"
        size="xs" icon="i-lucide-check"
        :label="run.question.reason === 'budget' ? 'Continue with a fresh allowance' : run.question.reason === 'auth' ? 'Retry the step' : run.question.reason === 'quota' ? 'Retry now' : 'Approve and run'"
        :loading="sending === 'continue'"
        :disabled="!!sending || (!runnerPause && !canApprove)"
        :title="!runnerPause && !canApprove ? 'Say why this is right before approving' : ''"
        @click="send('continue')"
      />
      <UButton v-else-if="mayAnswer && run.status === 'paused'" size="xs" label="Continue" :loading="sending === 'continue'" :disabled="!!sending" @click="send('continue')" />
      <!-- The reviewer's third answer, and the one that was missing: hand the
           work back to a named earlier step with the instruction it works from.
           The runner has always been able to do this; only an agent could ask
           for it. "Reject run" beside it ends the run - they were previously the
           same button, labelled as this one and behaving as that one. -->
      <template v-if="mayAnswer && run.status === 'paused' && run.question?.kind === 'approval' && !runnerPause && reworkCandidates.length && reworksLeft > 0">
        <select v-model="reworkTarget" class="field-input t-small w-44" aria-label="Step to send this back to">
          <option value="">Send back to…</option>
          <option v-for="s in reworkCandidates" :key="s.stepId" :value="s.stepId">{{ s.label }}</option>
        </select>
        <UButton
          size="xs" variant="soft" color="warning" icon="i-lucide-corner-up-left"
          :label="`Send back (${reworksLeft} left)`"
          :loading="sending === 'rework'"
          :disabled="!!sending || !reworkTarget || !note.trim()"
          :title="!reworkTarget ? 'Choose the step it goes back to' : !note.trim() ? 'Say what needs to change' : 'That step runs again with your instruction'"
          @click="send('rework')"
        />
      </template>
      <UButton
        v-if="mayAnswer && run.status === 'paused' && run.question?.kind === 'approval' && !runnerPause"
        size="xs" variant="ghost" color="error" icon="i-lucide-circle-x" label="Reject run"
        :loading="sending === 'reject'"
        :disabled="!!sending || !note.trim()" :title="note.trim() ? 'End the run and record why' : 'Say why first'"
        @click="send('reject')"
      />
      <p v-if="!mayAnswer && run.status === 'paused'" class="t-small text-label self-center">This run is waiting on a decision from a developer.</p>
    </div>
    <p v-if="sending" class="t-small flex items-center gap-1.5 m-0" style="color: var(--text-secondary);" role="status" aria-live="polite">
      <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
      {{ SENDING_LABEL[sending] }}
    </p>
  </div>
</template>
