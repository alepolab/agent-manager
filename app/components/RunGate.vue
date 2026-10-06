<script setup lang="ts">
import { HOLD } from '~~/shared/types/workflowGroup'
import type { WorkflowRun } from '~~/shared/types/run'

/**
 * A run's open decision: the question, whose it is, the evidence being
 * approved, and the answers. Shared by RunStack, which renders it inside the
 * card of the step that is waiting. Renders when a question is set, or the
 * run is awaiting_review or paused. The inbox shows the same decision laid out
 * on its own page (GateDecision); both answer through useGateAnswer.
 */
const props = defineProps<{ run: WorkflowRun }>()
const emit = defineEmits<{ respond: [reply: string], continue: [note?: string], reject: [note: string], rework: [stepId: string, note: string] }>()

const {
  role, gateOwner, mineToAnswer, mayAnswer, mustJustify, reviewing, isReply, runnerPause,
  note, canApprove, reworkTarget, reworkCandidates, reworksLeft, canSendBack,
  sendingBack, sendBackSelect, changeBrief, sendBackFor, suggestedFor, openSendBack, cancelSendBack, submitNote,
  sending, SENDING_LABEL, send, waitingLabel, gateLabel, approveLabel,
} = useGateAnswer(toRef(props, 'run'), {
  respond: r => emit('respond', r), continue: n => emit('continue', n),
  reject: n => emit('reject', n), rework: (id, n) => emit('rework', id, n),
})
const shown = computed(() => !!props.run.question || reviewing.value || props.run.status === 'paused' || (props.run.status === 'queued' && !!props.run.parked))
const PARKED_LABEL = { continue: 'Your decision is', respond: 'Your answer is', restart: 'The restart is' } as const
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
const placeholder = computed(() => (isReply.value
  ? 'Your answer to the agent'
  : 'Optional note for the step about to run, e.g. target the SaskTel branch policy'))

const noteBox = ref<HTMLTextAreaElement | null>(null)
/** An option chosen from the brief becomes the reply, for the person to send or add to. */
function chooseOption(text: string) {
  note.value = text
  nextTick(() => noteBox.value?.focus())
}
</script>

<template>
  <div v-if="shown" class="space-y-3" data-testid="run-gate">
    <!-- A decision taken while the group was full: recorded, and carried out
         by the queue when a slot frees - it is not lost and not re-asked. -->
    <div v-if="run.status === 'queued' && run.parked" class="group-card p-3! t-small space-y-1" role="status">
      <template v-if="run.parked.gaveWayTo === HOLD">
        <p class="t-head m-0 text-strong">Paused: its group is on hold</p>
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
      <div class="t-label" style="color: var(--text-secondary);">{{ gateLabel }}</div>
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
      <p v-if="gateOwner" class="t-small" :style="{ color: mineToAnswer ? 'var(--text-tertiary)' : 'var(--text-secondary)' }">
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
      :run="run" @brief="b => { changeBrief = b }"
    />
    <!-- A step's question: its brief, laid out for someone who has not read
         the ticket or the report. The banner above carries the question once. -->
    <RunDecisionBrief
      v-else-if="run.question?.kind === 'question' && run.question.brief && !run.parked"
      :brief="run.question.brief" :can-answer="mayAnswer && run.status === 'paused'" @choose="chooseOption"
    />
    <details
      v-if="run.question?.kind === 'question' && askContext && !run.parked" :open="!run.question.brief"
      class="group-card p-3! t-small"
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
      @keydown.meta.enter="submitNote()" @keydown.ctrl.enter="submitNote()"
    />
    <div class="flex flex-wrap gap-2">
      <UButton v-if="mayAnswer && !reviewing && isReply" size="xs" icon="i-lucide-send" label="Reply" :loading="sending === 'respond'" :disabled="!!sending || !note.trim()" @click="send('respond')" />
      <UButton
        v-else-if="mayAnswer && run.status === 'paused' && run.question?.kind === 'approval'"
        size="xs" icon="i-lucide-check"
        :variant="sendingBack ? 'soft' : 'solid'" :color="sendingBack ? 'neutral' : 'primary'"
        :label="approveLabel"
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
      <!-- Sending back is a mode the person opens, as in the inbox (GateDecision):
           until then Approve is primary; once open, Send back is, the list
           starts on the step the brief suggests, and Esc or Cancel closes it. -->
      <template v-if="mayAnswer && canSendBack">
        <UButton
          v-if="!sendingBack" size="xs" variant="soft" color="neutral" icon="i-lucide-corner-up-left"
          :label="`Send back… (${reworksLeft} left)`" @click="openSendBack"
        />
        <template v-else>
          <select ref="sendBackSelect" v-model="reworkTarget" class="field-input t-small w-44" aria-label="Step to send this back to" @keydown.esc.prevent="cancelSendBack">
            <option value="">Send back to…</option>
            <option v-for="s in reworkCandidates" :key="s.stepId" :value="s.stepId">{{ s.label }}{{ suggestedFor(s.stepId) ? ` — suggested for ${suggestedFor(s.stepId)}` : '' }}</option>
          </select>
          <UButton
            size="xs" icon="i-lucide-corner-up-left"
            :label="`Send back (${reworksLeft} left)`"
            :loading="sending === 'rework'"
            :disabled="!!sending || !reworkTarget || !note.trim()"
            :title="!reworkTarget ? 'Choose the step it goes back to' : !note.trim() ? 'Say what needs to change' : 'That step runs again with your instruction'"
            @click="send('rework')"
          />
          <UButton size="xs" variant="ghost" color="neutral" label="Cancel" title="Close the send-back and keep the gate as it was (Esc)" @click="cancelSendBack" />
          <span v-if="sendBackFor.length" class="t-small text-label w-full" role="status">
            Suggested:
            <template v-for="(s, i) in sendBackFor" :key="s.key">{{ i ? ' · ' : '' }}<span :title="s.name">({{ s.key }}) <b class="text-strong">{{ s.step.label }}</b></span></template>
          </span>
        </template>
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
