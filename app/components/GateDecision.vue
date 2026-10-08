<script setup lang="ts">
import { parkedDecision, type WorkflowRun } from '~~/shared/types/run'
import { briefHeadline, riskDetail, riskLevel, unresolvedQuestions } from '~~/shared/utils/decisionBrief'
import { HOLD } from '~~/shared/types/workflowGroup'
import { SETTLED_STATUSES } from '~/utils/runStatus'

/**
 * A run's open gate, as the inbox shows it: one decision to a page.
 *
 * The question in a line, then the choices with what each costs, then one
 * answer bar that stays where it is. What the step found, the criteria, its
 * report, the run so far and the ticket are there, folded: the page used to
 * open all of them at once, and a two-option question ran 3,500px before the
 * box to answer it in. Answering goes through useGateAnswer, the same rules
 * RunGate uses on the run's own page.
 */
const props = defineProps<{ run: WorkflowRun }>()
const emit = defineEmits<{ respond: [reply: string], continue: [note?: string], reject: [note: string], rework: [stepId: string, note: string], stop: [] }>()

const run = toRef(props, 'run')
const {
  role, gateOwner, mineToAnswer, mayAnswer, mustJustify, reviewing, isReply, isApproval, runnerPause,
  note, canApprove, reworkTarget, reworkCandidates, reworksLeft, canSendBack,
  sendingBack, sendBackSelect, changeBrief, sendBackFor, suggestedFor, openSendBack, cancelSendBack, submitNote,
  sending, SENDING_LABEL, send, waitingLabel, askingStep, approveLabel, gateLabel,
} = useGateAnswer(run, {
  respond: r => emit('respond', r), continue: n => emit('continue', n),
  reject: n => emit('reject', n), rework: (id, n) => emit('rework', id, n),
})

const question = computed(() => run.value.question)
const brief = computed(() => (question.value?.kind === 'question' ? question.value.brief : undefined))
const paused = computed(() => run.value.status === 'paused')
const parked = computed(() => run.value.status === 'queued' && !!run.value.parked)

/** A budget pause's two sentences, with the full stop older records lack between them. */
const sentenced = (t: string) => t.replace(/([^.\s])\s+(Continue to grant )/, '$1. $2')

/** The title: the brief's headline, an approval named by what it lets happen, or the runner's own question. */
const headline = computed(() => {
  const q = question.value
  if (reviewing.value) return `${q?.artifact ?? 'Its drafts'} is waiting on your decisions`
  if (brief.value) return briefHeadline(brief.value, q?.text)
  if (q?.kind === 'approval' && !runnerPause.value && q.reason !== 'rework' && q.reason !== 'handoff') return approvalTitle.value
  // Budget pauses recorded before the cap's sentence ended in a full stop
  // read "…242 min cap Continue to grant…": split where the offer starts.
  return briefHeadline(undefined, sentenced(q?.text || 'This run is paused'))
})
/**
 * An approval named by what it lets happen. "Approve "Jira: Dev Done"?" says
 * which step is next and not what it does; the step's kind says that.
 */
const approvalTitle = computed(() => {
  const s = askingStep.value
  const key = run.value.ticketKey ?? 'the ticket'
  const jira = s?.label.match(/^Jira:\s*(.+)$/i)
  if (jira) return `Move ${key} to ${jira[1]}?`
  if (s && /ship|evidence-and-pr/.test(s.agentSlug)) return `Open the pull request for ${key}?`
  if (s && /stack/.test(s.agentSlug)) return 'Rebuild and redeploy the stack from this change?'
  if (s && /ce-work|fix-implementer/.test(s.agentSlug)) return `Let the agent implement the plan for ${key}?`
  return `Approve "${s?.label ?? 'the next step'}"?`
})
/** Two or three lines under the title, the rest one tap away. */
const gist = computed(() => {
  if (brief.value) return brief.value.situation
  const q = question.value
  // A runner-raised approval (send-backs spent, a refused hand-over) says what
  // the choices do in its text; an ordinary gate's verdict card says it instead.
  if (q?.kind === 'approval' && !runnerPause.value && q.reason !== 'rework' && q.reason !== 'handoff') return ''
  const text = sentenced((q?.text ?? '').trim())
  if (!text || text === headline.value) return ''
  // A runner pause's first line is the title; the rest says what the choices do.
  return text.startsWith(headline.value) ? text.slice(headline.value.length).trim() : text
})
const gistOpen = ref(false)
// Per instance: two decisions on one page must not share ids.
const uid = useId()
const ids = { choices: `${uid}-choices`, gist: `${uid}-gist` }
const fullQuestion = computed(() => {
  // The title is clamped at three lines, so a long one has its full text here
  // (a title attribute reaches neither a keyboard nor a touch screen). Without
  // a brief, a short title's rest is already the gist under it.
  const asked = (question.value?.text ?? '').trim()
  if (!asked) return ''
  if (headline.value.length > 140) return asked
  return brief.value && asked !== headline.value ? asked : ''
})

/** The asking step's own report, without its PIPELINE-ASK line. */
const report = computed(() => {
  if (question.value?.kind !== 'question') return ''
  return (askingStep.value?.output ?? '').replace(/^PIPELINE-ASK:.*$/m, '').trim()
})

// ---- The choices ----------------------------------------------------------
const clean = (k: string) => k.replace(/[()]/g, '').trim()
const recommended = computed(() => clean(brief.value?.recommendation?.option ?? '').toLowerCase())
const isRecommended = (key: string) => clean(key).toLowerCase() === recommended.value
const options = computed(() => (brief.value?.options ?? []).map(o => ({
  ...o,
  name: o.title ?? o.label,
  level: riskLevel(o.risk),
  riskText: riskDetail(o.risk),
})))
/** The recommended option starts selected: sending it is still a deliberate click. */
const chosen = ref<string | null>(null)
watch(() => [run.value.id, question.value?.askedAt], () => {
  chosen.value = options.value.find(o => isRecommended(o.key))?.key ?? null
}, { immediate: true })
/** Only what the step could not settle: a resolved intake question is not the reviewer's to decide. */
const openQuestions = computed(() => unresolvedQuestions(brief.value))
const chosenOption = computed(() => options.value.find(o => o.key === chosen.value))
const RISK_WORD = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' } as const

const optionEls = ref<HTMLElement[]>([])
function onOptionKey(e: KeyboardEvent, i: number) {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); chosen.value = options.value[i]!.key; return }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const n = (i + (e.key === 'ArrowDown' ? 1 : -1) + options.value.length) % options.value.length
  chosen.value = options.value[n]!.key
  nextTick(() => optionEls.value[n]?.focus())
}

const noteBox = ref<HTMLTextAreaElement | null>(null)
/** Answering outside the options: the note becomes the whole reply. */
function ownWords() {
  chosen.value = null
  nextTick(() => noteBox.value?.focus())
}
/** A chosen option is sent as "(key) its words", with the note after it, the shape the asking step reads. */
const reply = computed(() => {
  const o = chosenOption.value
  const n = note.value.trim()
  if (!o) return n
  return `(${clean(o.key)}) ${o.label}${n ? `\n\n${n}` : ''}`
})
function sendReply() { if (reply.value) send('respond', reply.value) }

// ---- Stopping -------------------------------------------------------------
/**
 * "Out of budget - approve more, or stop it": the second half needs a button.
 * The run's own page has Stop in its header; the inbox shows no header, so a
 * pause the runner raised carries it here. Asks once, like everywhere else.
 */
const { can } = useUser()
const mayStop = computed(() => can('runEngine') && (runnerPause.value || question.value?.reason === 'rework' || question.value?.reason === 'handoff'))
const confirmingStop = ref(false)
let stopTimer: ReturnType<typeof setTimeout> | undefined
function stopRun() {
  if (!confirmingStop.value) {
    confirmingStop.value = true
    clearTimeout(stopTimer)
    stopTimer = setTimeout(() => { confirmingStop.value = false }, 4000)
    return
  }
  confirmingStop.value = false
  emit('stop')
}
onBeforeUnmount(() => clearTimeout(stopTimer))

// ---- Approvals ------------------------------------------------------------
const notePlaceholder = computed(() => {
  if (isReply.value) return brief.value ? 'Add a note for the run (optional)' : 'Your answer to the agent'
  if (runnerPause.value) return 'Optional note for the step about to run'
  if (mustJustify.value) return 'Why this is right - required to approve, and to send back or reject'
  return 'Add a note - required to send back or reject'
})

// ---- The run so far -------------------------------------------------------
const done = computed(() => run.value.steps.filter(s => SETTLED_STATUSES.has(s.status)).length)
</script>

<template>
  <div class="decision">
    <div class="decision__body space-y-5">
      <!-- What this is, whose it is and how long it has waited. -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 t-small">
        <TicketLink v-if="run.ticketKey" :ticket-key="run.ticketKey" class="font-semibold" />
        <span class="text-label">{{ run.workflowName.split(' — ')[0] }}</span>
        <span class="text-label">Waiting {{ waitingLabel }}</span>
        <UButton
          :to="`/runs/${run.id}${question?.stepId ? `#step-${question.stepId}` : ''}`"
          size="xs" variant="ghost" color="neutral" trailing-icon="i-lucide-arrow-right" label="Full run" class="ml-auto"
        />
      </div>

      <header class="space-y-2">
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1 t-small m-0">
          <StatusLabel :status="run.status" :label="mineToAnswer ? (isApproval && !runnerPause ? 'Your approval' : 'Your decision') : `${gateOwner ?? 'Someone else'}'s decision`" />
          <span class="text-label">· {{ gateLabel }}</span>
        </p>
        <h2 class="decision__title">{{ headline }}</h2>
        <template v-if="gist">
          <p :id="ids.gist" class="decision__gist" :class="{ 'decision__gist--open': gistOpen }">{{ gist }}</p>
          <button v-if="gist.length > 220" class="t-small focus-ring rounded text-link" :aria-expanded="gistOpen" :aria-controls="ids.gist" @click="gistOpen = !gistOpen">
            {{ gistOpen ? 'Show less' : 'Show more' }}
          </button>
        </template>
        <p v-if="run.blastRadius && mustJustify" class="t-small m-0" style="color: var(--warning);">
          Classed <span class="font-mono">{{ run.blastRadius }}</span>: owner-gated, so approving needs a written reason.
        </p>
      </header>

      <!-- A decision taken while the group was full: recorded, not lost, not re-asked. -->
      <div v-if="parked && run.parked" class="group-card t-small space-y-1" role="status">
        <template v-if="run.parked.gaveWayTo === HOLD">
          <p class="t-head m-0 text-strong">Paused: its group is on hold</p>
          <p class="m-0 text-label">It finished the step it was on and stopped there. When the hold is lifted it carries on from the next step, ahead of newer runs.</p>
        </template>
        <template v-else-if="run.parked.gaveWayTo">
          <p class="t-head m-0 text-strong">Stepped aside while {{ run.parked.gaveWayTo }} runs are working</p>
          <p class="m-0 text-label">It carries on from the next step when they are done, ahead of newer runs.</p>
        </template>
        <template v-else>
          <p class="t-head m-0 text-strong">{{ parkedDecision(run.parked).recorded }} recorded - waiting for a free slot</p>
          <p class="m-0 text-label">
            Its group is running as many runs as it allows; this one goes ahead of newer ones.
            <template v-if="run.parked.note || run.parked.reply">Your note: "{{ run.parked.reply ?? run.parked.note }}"</template>
          </p>
        </template>
      </div>

      <!-- Entry-by-entry review of an artifact: the panel that can take those decisions. -->
      <RunDecisionPanel v-else-if="reviewing" :run="run" />

      <!-- A question with a brief: the options to choose between. -->
      <section v-else-if="options.length" :aria-labelledby="ids.choices">
        <div class="group-head">
          <h3 :id="ids.choices">{{ mayAnswer && paused ? 'Choose one' : 'The options' }}</h3>
          <span class="group-head__count">{{ options.length }}</span>
        </div>
        <!-- Radios either way: selecting one opens its detail, which is how an
             option is read. Read-only when it is not this person's to answer. -->
        <div class="choices" role="radiogroup" :aria-labelledby="ids.choices" :aria-readonly="mayAnswer && paused ? undefined : 'true'">
          <div
            v-for="(o, i) in options" :key="o.key"
            ref="optionEls"
            class="choice focus-ring"
            :class="{ 'choice--on': chosen === o.key }"
            role="radio"
            :aria-checked="chosen === o.key"
            :tabindex="chosen === o.key || (!chosen && i === 0) ? 0 : -1"
            @click="chosen = o.key"
            @keydown="onOptionKey($event, i)"
          >
            <div class="choice__head">
              <span v-if="mayAnswer && paused" class="choice__radio" aria-hidden="true" />
              <span class="min-w-0">
                <span class="choice__title">
                  {{ o.name }}
                  <span v-if="isRecommended(o.key)" class="choice__rec">Recommended</span>
                </span>
                <span class="choice__sub">{{ o.delivers }}</span>
              </span>
              <span v-if="o.level" class="choice__risk" :class="`choice__risk--${o.level}`"><i aria-hidden="true" />{{ RISK_WORD[o.level] }}</span>
            </div>
            <dl v-if="chosen === o.key" class="choice__facts">
              <template v-if="o.title && o.label !== o.title"><dt>The option</dt><dd>{{ o.label }}</dd></template>
              <dt>What happens</dt><dd>{{ o.next }}</dd>
              <dt>Left behind</dt><dd>{{ o.leaves }}</dd>
              <template v-if="o.riskText"><dt>Risk</dt><dd>{{ o.riskText }}</dd></template>
            </dl>
          </div>
        </div>
        <p v-if="brief?.recommendation" class="decision__why">
          <UIcon name="i-lucide-info" class="size-4 shrink-0 mt-0.5 text-link" />
          <span><b class="text-strong">Why it is recommended:</b> {{ brief.recommendation.why }}</span>
        </p>
      </section>

      <!-- A budget pause: what granting more buys, and what stopping keeps. -->
      <RunBudgetBrief v-else-if="question?.reason === 'budget'" :run="run" />

      <!-- An approval: what it lets happen, measured. -->
      <RunVerdictCard v-else-if="question?.kind === 'approval' && !runnerPause && question.reason !== 'rework' && question.reason !== 'handoff'" :run="run" @brief="b => { changeBrief = b }" />

      <!-- A question without a brief: the step's report is all there is to go on. -->
      <details v-else-if="report" class="group-details" open>
        <summary class="group-head cursor-pointer focus-ring"><h3>The step's report</h3></summary>
        <pre class="decision__pre">{{ report }}</pre>
      </details>

      <!-- Everything else, folded. -->
      <div class="disclosures">
        <details v-if="brief?.findings?.length">
          <summary class="focus-ring"><UIcon name="i-lucide-chevron-right" class="chev" />What the step found<span class="end">{{ brief.findings.length }}</span></summary>
          <ul class="disclosures__body list-disc pl-9 space-y-1"><li v-for="(f, i) in brief.findings" :key="i">{{ f }}</li></ul>
        </details>
        <details v-if="openQuestions.length" open>
          <summary class="focus-ring"><UIcon name="i-lucide-chevron-right" class="chev" />Intake questions still open<span class="end">{{ openQuestions.length }}</span></summary>
          <dl class="disclosures__body space-y-2 m-0">
            <div v-for="(q, i) in openQuestions" :key="i"><dt class="font-semibold text-strong">{{ q.question }}</dt><dd class="m-0 whitespace-pre-wrap">{{ q.answer }}</dd></div>
          </dl>
        </details>
        <details v-if="brief?.criteria?.length">
          <summary class="focus-ring"><UIcon name="i-lucide-chevron-right" class="chev" />What it is checked against<span class="end">{{ brief.criteria.length }} {{ brief.criteria.length === 1 ? 'criterion' : 'criteria' }}</span></summary>
          <div class="disclosures__body space-y-2">
            <div v-for="c in brief.criteria" :key="c.ref"><b class="block font-semibold text-strong">{{ c.ref }}</b>{{ c.text }}</div>
          </div>
        </details>
        <details v-if="fullQuestion">
          <summary class="focus-ring"><UIcon name="i-lucide-chevron-right" class="chev" />The full question</summary>
          <p class="disclosures__body whitespace-pre-wrap">{{ fullQuestion }}</p>
        </details>
        <details v-if="brief && report">
          <summary class="focus-ring"><UIcon name="i-lucide-chevron-right" class="chev" />The step's full report</summary>
          <pre class="disclosures__body decision__pre">{{ report }}</pre>
        </details>
        <details>
          <summary class="focus-ring"><UIcon name="i-lucide-chevron-right" class="chev" />The run so far<span class="end">{{ done }} of {{ run.steps.length }} steps</span></summary>
          <div class="disclosures__body space-y-2">
            <RunProgressBar :steps="run.steps" :aria-label="`${done} of ${run.steps.length} steps settled`" />
            <ul class="space-y-1">
              <li v-for="s in run.steps" :key="s.stepId" class="flex items-center gap-2">
                <StatusLabel :status="s.status" icon-only />
                <span :style="{ color: s.stepId === question?.stepId ? 'var(--text-primary)' : undefined, fontWeight: s.stepId === question?.stepId ? 600 : undefined }">{{ s.label }}</span>
                <span v-if="s.stepId === question?.stepId" class="ml-auto t-small text-label">waiting on you</span>
              </li>
            </ul>
          </div>
        </details>
        <details>
          <summary class="focus-ring">
            <UIcon name="i-lucide-chevron-right" class="chev" />The ticket
            <span class="end"><TicketLink v-if="run.ticketKey" :ticket-key="run.ticketKey" /></span>
          </summary>
          <pre class="disclosures__body decision__pre">{{ run.initialPrompt }}</pre>
        </details>
      </div>
    </div>

    <!-- One answer bar, in the same place on every decision. -->
    <div v-if="paused && !reviewing" class="decision__bar">
      <div v-if="!mayAnswer" class="t-small text-label">
        This is <span class="font-mono">{{ gateOwner ?? 'a developer' }}</span>'s decision, not yours<template v-if="role">. You are {{ role }}</template>.
      </div>
      <template v-else>
        <textarea
          ref="noteBox" v-model="note" rows="1" class="field-input w-full resize-none t-small decision__note"
          :placeholder="notePlaceholder" :aria-label="notePlaceholder"
          @keydown.meta.enter="submitNote(sendReply)" @keydown.ctrl.enter="submitNote(sendReply)"
          @keydown.esc="sendingBack && cancelSendBack()"
        />
        <div class="flex flex-wrap items-center gap-2">
          <!-- A question -->
          <template v-if="isReply">
            <span class="t-small text-label min-w-0 truncate" style="flex: 1 1 12rem;">
              <template v-if="chosenOption">Answer: <b class="text-strong">{{ chosenOption.name }}</b></template>
              <template v-else-if="options.length">Answering in your own words</template>
            </span>
            <UButton v-if="options.length && chosenOption" size="sm" variant="link" color="primary" label="Answer in my own words" @click="ownWords" />
            <UButton size="sm" icon="i-lucide-send" label="Send answer" :loading="sending === 'respond'" :disabled="!!sending || !reply" @click="sendReply" />
          </template>

          <!-- An approval, or a pause the runner raised -->
          <template v-else-if="isApproval">
            <span class="t-small text-label mr-auto">
              <template v-if="canSendBack">Can be sent back {{ reworksLeft }} more {{ reworksLeft === 1 ? 'time' : 'times' }}</template>
              <span v-if="sendingBack && sendBackFor.length" class="block" role="status" data-testid="send-back-suggestion">
                Suggested:
                <template v-for="(s, i) in sendBackFor" :key="s.key">{{ i ? ' · ' : '' }}<span :title="s.name">({{ s.key }}) <b class="text-strong">{{ s.step.label }}</b></span></template>
              </span>
            </span>
            <template v-if="!runnerPause">
              <UButton
                size="sm" variant="ghost" color="error" label="Reject"
                :loading="sending === 'reject'" :disabled="!!sending || !note.trim()"
                :title="note.trim() ? 'End the run and record why' : 'Say why first'" @click="send('reject')"
              />
              <template v-if="canSendBack">
                <select v-if="sendingBack" ref="sendBackSelect" v-model="reworkTarget" class="field-input t-small w-44" aria-label="Step to send this back to" @keydown.esc.prevent="cancelSendBack">
                  <option value="">Send back to…</option>
                  <option v-for="s in reworkCandidates" :key="s.stepId" :value="s.stepId">{{ s.label }}{{ suggestedFor(s.stepId) ? ` — suggested for ${suggestedFor(s.stepId)}` : '' }}</option>
                </select>
                <UButton
                  v-if="!sendingBack" size="sm" variant="soft" color="neutral" icon="i-lucide-corner-up-left" label="Send back…"
                  @click="openSendBack"
                />
                <UButton
                  v-else size="sm" icon="i-lucide-corner-up-left" label="Send back"
                  :loading="sending === 'rework'" :disabled="!!sending || !reworkTarget || !note.trim()"
                  :title="!reworkTarget ? 'Choose the step it goes back to' : !note.trim() ? 'Say what needs to change' : 'That step runs again with your instruction'"
                  @click="send('rework')"
                />
                <UButton v-if="sendingBack" size="sm" variant="ghost" color="neutral" label="Cancel" title="Close the send-back and keep the gate as it was (Esc)" @click="cancelSendBack" />
              </template>
            </template>
            <UButton
              v-if="mayStop" size="sm" :variant="confirmingStop ? 'solid' : 'ghost'" :color="confirmingStop ? 'error' : 'neutral'"
              icon="i-lucide-circle-stop" :label="confirmingStop ? 'Confirm stop' : 'Stop the run'" @click="stopRun"
            />
            <span class="sr-only" aria-live="polite">{{ confirmingStop ? 'Press Confirm stop again within four seconds to stop the run.' : '' }}</span>
            <!-- Once "Send back…" is chosen, sending back is what the person is doing:
                 it takes the primary look, and approving steps down beside it. -->
            <UButton
              size="sm" icon="i-lucide-check" :label="approveLabel"
              :variant="sendingBack ? 'soft' : 'solid'" :color="sendingBack ? 'neutral' : 'primary'"
              :loading="sending === 'continue'" :disabled="!!sending || (!runnerPause && !canApprove)"
              :title="!runnerPause && !canApprove ? 'Say why this is right before approving' : ''"
              @click="send('continue')"
            />
          </template>

          <!-- Paused with no question -->
          <template v-else>
            <span class="mr-auto" />
            <UButton size="sm" label="Continue" :loading="sending === 'continue'" :disabled="!!sending" @click="send('continue')" />
          </template>
        </div>
      </template>
      <p v-if="sending" class="t-small flex items-center gap-1.5 m-0 text-body" role="status" aria-live="polite">
        <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
        {{ SENDING_LABEL[sending] }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.decision { display: flex; flex-direction: column; min-height: 100%; }
.decision__body { flex: 1; max-width: 44rem; width: 100%; margin: 0 auto; padding-bottom: 24px; }
.decision__title {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-family: var(--font-display);
  font-size: 22px;
  line-height: 1.25;
  font-weight: 700;
  letter-spacing: -0.015em;
  color: var(--text-primary);
  text-wrap: balance;
  margin: 0;
}
.decision__gist {
  margin-top: 6px !important;
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
  max-width: 62ch;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
}
.decision__gist--open { -webkit-line-clamp: unset; display: block; }
.decision__why { display: flex; gap: 8px; margin: 10px 0 0; font-size: 13px; color: var(--text-secondary); }
.decision__pre { white-space: pre-wrap; font-family: var(--font-sans); font-size: 12.5px; color: var(--text-secondary); max-height: 24rem; overflow-y: auto; margin: 0; }

.choices { background: var(--surface-raised); border-radius: 12px; box-shadow: 0 0 0 0.5px var(--border-default); overflow: hidden; }
.choice { cursor: pointer; border-top: 0.5px solid var(--border-subtle); }
.choice:first-child { border-top: 0; }
.choice:hover { background: var(--surface-hover); }
.choice--on, .choice--on:hover { background: var(--accent-muted); }
/* An outline, not a box-shadow: forced-colors mode strips shadows and keeps outlines. */
.choice:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.choice__head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 12px 14px; }
.choice__radio { width: 18px; height: 18px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--border-emphasis, var(--border-default)); margin-top: 1px; }
.choice--on .choice__radio { box-shadow: inset 0 0 0 5px var(--accent); }
/* The radio is drawn with box-shadow, which forced-colors mode strips: give it
   a border there, and fill the chosen one with the system highlight. */
@media (forced-colors: active) {
  .choice__radio { border: 1.5px solid CanvasText; box-shadow: none; }
  .choice--on .choice__radio { background: Highlight; box-shadow: inset 0 0 0 3px Canvas; }
}
.choice__title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; color: var(--text-primary); }
.choice__sub { display: block; margin-top: 2px; font-size: 13px; color: var(--text-secondary); }
.choice__rec { font-size: 11.5px; font-weight: 600; color: var(--accent); background: var(--accent-muted); border-radius: 5px; padding: 1px 6px; }
.choice__risk { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; white-space: nowrap; padding-top: 2px; }
.choice__risk i { width: 7px; height: 7px; border-radius: 2px; background: currentColor; }
.choice__risk--low { color: var(--success); }
.choice__risk--medium { color: var(--warning); }
.choice__risk--high { color: var(--error); }
.choice__facts { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 6px 12px; margin: 0; padding: 0 14px 14px 42px; font-size: 13px; }
.choice__facts dt { color: var(--text-tertiary); }
.choice__facts dd { margin: 0; color: var(--text-primary); }
@media (max-width: 640px) {
  .choice__facts { grid-template-columns: minmax(0, 1fr); gap: 2px; padding-left: 14px; }
  .choice__facts dd { margin-bottom: 8px; }
  .choice__head { grid-template-columns: auto minmax(0, 1fr); }
  .choice__risk { grid-column: 2; }
}

.disclosures { background: var(--surface-raised); border-radius: 12px; box-shadow: 0 0 0 0.5px var(--border-default); overflow: hidden; font-size: 13px; }
.disclosures details { border-top: 0.5px solid var(--border-subtle); }
.disclosures details:first-child { border-top: 0; }
.disclosures summary { list-style: none; display: flex; align-items: center; gap: 10px; padding: 11px 14px; cursor: pointer; color: var(--text-primary); }
.disclosures summary::-webkit-details-marker { display: none; }
.disclosures summary:hover { background: var(--surface-hover); }
.disclosures .chev { width: 14px; height: 14px; color: var(--text-tertiary); flex: none; transition: transform 0.15s; }
.disclosures details[open] > summary .chev { transform: rotate(90deg); }
.disclosures .end { margin-left: auto; color: var(--text-tertiary); font-size: 12px; }
.disclosures__body { padding: 0 14px 14px 38px; color: var(--text-secondary); margin: 0; }

/* Sticks to the bottom of the pane that scrolls, full width of it. */
.decision__bar {
  position: sticky;
  bottom: -20px;
  margin: 0 -24px -20px;
  padding: 12px 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 0.5px solid var(--border-default);
  background: color-mix(in srgb, var(--surface-raised) 92%, transparent);
  backdrop-filter: blur(14px);
  z-index: 2;
}
.decision__bar > * { max-width: 44rem; width: 100%; margin-inline: auto; }
.decision__note { min-height: 36px; max-height: 8rem; field-sizing: content; }
@media (max-width: 640px) { .decision__bar { margin-inline: -16px; padding-inline: 16px; } }
</style>
