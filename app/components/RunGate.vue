<script setup lang="ts">
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
const shown = computed(() => !!props.run.question || reviewing.value || props.run.status === 'paused')

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

function send(kind: 'respond' | 'continue' | 'reject' | 'rework') {
  const text = note.value.trim()
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
    <div v-if="run.question" class="rounded-lg p-3 t-small space-y-1" style="background: var(--accent-muted); border: 1px solid var(--accent);" role="alert">
      <!-- The eyebrow is the label; the question is the thing to read. These were
           the same size, inside a box built exactly like the two informational
           boxes above it — which is how the console's whole reason to exist came
           to look like a footnote. -->
      <div class="t-label" style="color: var(--text-secondary);">{{ run.question.reason === 'budget' ? 'Budget reached' : run.question.reason === 'rework' ? 'Send-backs spent' : run.question.kind === 'approval' ? 'Waiting for your approval' : askingLabel }}</div>
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
    <RunVerdictCard
      v-else-if="run.question?.kind === 'approval' && run.question.reason !== 'budget'"
      :run="run"
    />
    <textarea
      v-if="!reviewing && mayAnswer && run.status === 'paused'"
      v-model="note"
      rows="2"
      class="field-input w-full resize-none t-small"
      :placeholder="placeholder"
      :aria-label="placeholder"
      @keydown.meta.enter="isReply ? send('respond') : send('continue')"
    />
    <div class="flex flex-wrap gap-2">
      <UButton v-if="mayAnswer && !reviewing && isReply" size="xs" icon="i-lucide-send" label="Reply" :disabled="!note.trim()" @click="send('respond')" />
      <UButton
        v-else-if="mayAnswer && run.status === 'paused' && run.question?.kind === 'approval'"
        size="xs" icon="i-lucide-check"
        :label="run.question.reason === 'budget' ? 'Continue with a fresh allowance' : 'Approve and run'"
        :disabled="run.question.reason !== 'budget' && !canApprove"
        :title="run.question.reason !== 'budget' && !canApprove ? 'Say why this is right before approving' : ''"
        @click="send('continue')"
      />
      <UButton v-else-if="mayAnswer && run.status === 'paused'" size="xs" label="Continue" @click="send('continue')" />
      <!-- The reviewer's third answer, and the one that was missing: hand the
           work back to a named earlier step with the instruction it works from.
           The runner has always been able to do this; only an agent could ask
           for it. "Reject run" beside it ends the run - they were previously the
           same button, labelled as this one and behaving as that one. -->
      <template v-if="mayAnswer && run.status === 'paused' && run.question?.kind === 'approval' && run.question.reason !== 'budget' && reworkCandidates.length && reworksLeft > 0">
        <select v-model="reworkTarget" class="field-input t-small w-44" aria-label="Step to send this back to">
          <option value="">Send back to…</option>
          <option v-for="s in reworkCandidates" :key="s.stepId" :value="s.stepId">{{ s.label }}</option>
        </select>
        <UButton
          size="xs" variant="soft" color="warning" icon="i-lucide-corner-up-left"
          :label="`Send back (${reworksLeft} left)`"
          :disabled="!reworkTarget || !note.trim()"
          :title="!reworkTarget ? 'Choose the step it goes back to' : !note.trim() ? 'Say what needs to change' : 'That step runs again with your instruction'"
          @click="send('rework')"
        />
      </template>
      <UButton
        v-if="mayAnswer && run.status === 'paused' && run.question?.kind === 'approval' && run.question.reason !== 'budget'"
        size="xs" variant="ghost" color="error" icon="i-lucide-circle-x" label="Reject run"
        :disabled="!note.trim()" :title="note.trim() ? 'End the run and record why' : 'Say why first'"
        @click="send('reject')"
      />
      <p v-if="!mayAnswer && run.status === 'paused'" class="t-small text-label self-center">This run is waiting on a decision from a developer.</p>
    </div>
  </div>
</template>
