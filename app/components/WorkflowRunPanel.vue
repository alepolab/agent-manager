<script setup lang="ts">
import type { WorkflowRun, RunCostSummary } from '~~/shared/types/run'
import { RUN_STATUS_COLOR as STATUS_COLOR, SETTLED_STATUSES, runElapsedLabel, RUN_DURATION_HINT } from '~/utils/runStatus'
import { needsJustification, oversightReason } from '~~/shared/utils/oversight'

const props = defineProps<{ run: WorkflowRun | null, runs: WorkflowRun[], logs?: Record<string, string[]>, fullPage?: boolean }>()
const emit = defineEmits<{ continue: [note?: string], stop: [], attach: [id: string], restart: [stepId: string, note?: string], clone: [], close: [], respond: [reply: string], note: [text: string], reject: [note: string], rework: [stepId: string, note: string] }>()

/**
 * What this person may do here. A reviewer holds `answerGate` and not
 * `runEngine`: they decide at the gate, and the pipeline's controls — stop,
 * restart a step, clone, steer a running agent — are not theirs. The server
 * refuses those routes for them too; this only stops us offering what would
 * then be refused.
 */
const { can, role } = useUser()
const mayDrive = computed(() => can('runEngine'))

/**
 * Whose gate this is, and whether it is mine to answer.
 *
 * Mirrors requireGateRole on the server — deliberately, and only as a courtesy:
 * the server is what actually refuses. Without it a developer would be shown
 * Approve on QA's verification gate and get a 403 after clicking, which is the
 * "click and see what happens" pattern the role model exists to end.
 *
 * A gate with no declared owner is anyone's, and an operator answers anything as
 * the backstop for a role nobody on this instance holds.
 */
const gateOwner = computed(() => props.run?.question?.role)
const mineToAnswer = computed(() =>
  !gateOwner.value || !role.value || role.value === 'operator' || role.value === gateOwner.value)
const mayAnswer = computed(() => can('answerGate') && mineToAnswer.value)
/** An owner-gated run cannot be approved in silence — the same rule the server
 *  enforces, applied here so the reviewer learns it from the button rather than
 *  from a 400 after they have already clicked. */
const mustJustify = computed(() => needsJustification(props.run?.blastRadius))
const canApprove = computed(() => !mustJustify.value || !!note.value.trim())

/** An agent is mid-call: a note reaches it directly instead of waiting for the next step. */
const anyRunning = computed(() => props.run?.steps.some(s => s.status === 'running') ?? false)
/** What the note box is for right now: a reply, an approval note, a note to the next step, or a restart note. */
const noteMode = computed(() => {
  const r = props.run
  if (!r) return 'restart'
  if (r.status === 'paused' && r.question?.kind === 'question') return 'reply'
  if (r.status === 'paused') return 'continue'
  if (r.status === 'running') return 'steer'
  return 'restart'
})
const notePlaceholder = computed(() => ({
  reply: 'Your answer to the agent',
  continue: 'Optional note for the step about to run, e.g. target the SaskTel branch policy',
  steer: anyRunning.value
    ? 'Instruction for the agent working now, e.g. the plugin lives under modules/administrator'
    : 'Send a note to whichever step starts next, e.g. the plugin lives under modules/administrator',
  restart: 'Optional note for the step you restart, e.g. verify from inside the container only',
}[noteMode.value]))
const sent = ref<string | null>(null)
function send(kind: 'respond' | 'note' | 'continue' | 'reject' | 'rework') {
  const text = note.value.trim()
  if (kind === 'rework') { emit('rework', reworkTarget.value, text); note.value = ''; reworkTarget.value = ''; return }
  if (kind === 'reject') { emit('reject', text); note.value = ''; return }
  if (kind === 'respond') emit('respond', text)
  else if (kind === 'note') { emit('note', text); sent.value = text }
  else emit('continue', text || undefined)
  note.value = ''
}

/** Optional correction handed to whichever step is restarted next. */
const note = ref('')

/**
 * Where a send-back goes. The reviewer picks; the run never guesses.
 *
 * A gate used to offer exactly two answers — approve, or end the run — while the
 * runner could always hand work back to a named step with an instruction. The
 * reason given for not exposing that was that the target could not be inferred
 * ("Push + PR" has three predecessors), which is true and beside the point: the
 * person deciding knows which step was wrong.
 *
 * Candidates are the steps that have already run. A pending step has produced
 * nothing to correct, and the gated step itself is what Approve is for.
 */
const reworkTarget = ref('')
const reworkCandidates = computed(() =>
  (props.run?.steps ?? []).filter(s => stepSettled(s) && s.stepId !== props.run?.question?.stepId))
const reworksLeft = computed(() => 2 - (props.run?.reworks ?? 0))
watch(() => props.run?.id, () => { reworkTarget.value = '' })

/** Evidence: the run's artifact files, listed on demand and opened one at a time. */
const artifacts = ref<{ name: string, size: number }[] | null>(null)
const openFile = ref<string | null>(null)
const fileText = ref('')
async function loadArtifacts() {
  if (!props.run) return
  artifacts.value = await $fetch<{ name: string, size: number }[]>(`/api/runs/${props.run.id}/artifacts`)
}
async function showFile(name: string) {
  if (!props.run) return
  if (openFile.value === name) { openFile.value = null; return }
  openFile.value = name
  fileText.value = await $fetch<string>(`/api/runs/${props.run.id}/artifacts/${name.split('/').map(encodeURIComponent).join('/')}`, { responseType: 'text' })
}
watch(() => props.run?.id, () => { artifacts.value = null; openFile.value = null })

/** What intake left unanswered, and where the fix landed: read from the run's own artifacts. */
const intake = ref<{ open_questions?: string[] } | null>(null)
const prLinks = ref<string[]>([])

/** Only the preflight checks that need a person; an all-clear is the silent, expected case. */
const preflightNotable = computed(() => (props.run?.preflight?.checks ?? []).filter(c => c.level === 'fail' || c.level === 'warn'))
async function loadFacts() {
  if (!props.run) { intake.value = null; prLinks.value = []; return }
  const id = props.run.id
  try { intake.value = JSON.parse(await $fetch<string>(`/api/runs/${id}/artifacts/context-packet.json`, { responseType: 'text' })) } catch { intake.value = null }
  try {
    const meta = JSON.parse(await $fetch<string>(`/api/runs/${id}/artifacts/meta.json`, { responseType: 'text' }))
    // A real pull request only: the schema forces the fix step to write a placeholder URL before one exists.
    prLinks.value = (meta?.fix?.repos ?? []).map((r: any) => r?.pr).filter((u: unknown): u is string => typeof u === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(u))
  } catch { prLinks.value = [] }
}
watch(() => [props.run?.id, props.run?.status, props.run?.steps.filter(s => s.status === 'completed').length], loadFacts, { immediate: true })

/** Restart and clone only make sense once nothing is executing. */
const settledRun = computed(() => !!props.run && !['running', 'paused'].includes(props.run.status))
const stepSettled = (s: { status: string }) => ['completed', 'failed', 'skipped'].includes(s.status)

/** A live run's timer has to advance between the run updates that arrive over
 *  SSE, or it reads as frozen while an agent works. One second, cleared with
 *  the component. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })

/**
 * How long this gate has been waiting on a person, ticking with the clock above.
 *
 * `question.askedAt` has always been on the record and was rendered nowhere, so
 * a gate that had been open for three hours looked exactly like one raised a
 * moment ago — to the reviewer, and to anyone wondering why a run had not moved.
 */
const waitingLabel = computed(() => {
  const asked = props.run?.question?.askedAt
  if (!asked) return 'for a decision'
  const secs = Math.max(0, Math.round((now.value - asked) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
})

const elapsed = (s: { startedAt?: number, completedAt?: number }) => {
  if (!s.startedAt) return ''
  const end = s.completedAt ?? Date.now()
  const secs = Math.round((end - s.startedAt) / 1000)
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
}

/**
 * Progress is reported as a count and a segment per step, never as a single
 * percentage. A run whose third step failed and whose remaining four were
 * skipped is not "43% done" — it is finished, badly. One segment per step,
 * coloured by that step's own status, says what actually happened; a bar
 * filling left to right would imply progress the run never made.
 */
const settled = SETTLED_STATUSES
const progress = computed(() => {
  const steps = props.run?.steps ?? []
  return { done: steps.filter(s => settled.has(s.status)).length, total: steps.length }
})

const expanded = ref<string | null>(null)
/** Live output for a step, newest last; the pre scrolls to the newest line as it arrives. */
const liveFor = (stepId: string) => props.logs?.[stepId] ?? []
const latest = (stepId: string) => liveFor(stepId).at(-1)?.slice(9) ?? ''
const logPre = ref<Record<string, HTMLElement | null>>({})
watch(() => expanded.value && liveFor(expanded.value).length, async () => {
  await nextTick()
  const el = expanded.value ? logPre.value[expanded.value] : null
  if (el) el.scrollTop = el.scrollHeight
})

// Usage totals are fetched separately from the run record (GET /api/runs/[id]/cost,
// server/utils/costReport.ts) rather than computed here: pricing lives in
// server/utils/models.ts only, and this component has no business re-deriving
// it from raw token counts. Re-fetched on the run's id (a different run
// entirely) AND on how many of its steps have settled - a live run's cost
// only grows when a step actually finishes reporting usage, not on every
// intermediate SSE status frame in between.
const cost = ref<RunCostSummary | null>(null)
const costError = ref(false)
watch([() => props.run?.id, () => progress.value.done], async ([id]) => {
  costError.value = false
  if (!id) { cost.value = null; return }
  try {
    cost.value = await $fetch<RunCostSummary>(`/api/runs/${id}/cost`)
  } catch {
    costError.value = true
  }
}, { immediate: true })
</script>

<template>
  <div v-if="run" class="border rounded-md p-4 space-y-3">
    <div class="flex items-center gap-3">
      <!-- Without this there is no way back to the history: the list below is
           v-else of this block, so opening a run hid every other run with no
           affordance to return. -->
      <button
        v-if="runs.length > 1"
        class="t-small text-label hover:underline shrink-0"
        data-testid="run-back-to-history"
        @click="emit('close')"
      >
        &larr; All runs ({{ runs.length }})
      </button>
      <NuxtLink v-if="!fullPage" :to="`/runs/${run.id}`" class="t-small text-label hover:underline shrink-0 focus-ring" title="Steps, live output and every evidence file, full screen">Full page &nearr;</NuxtLink>
      <span class="t-small font-mono uppercase" :style="{ color: STATUS_COLOR[run.status] }">
        {{ run.status }}
      </span>
      <span class="t-small text-label">{{ run.workflowName }}</span>
      <span class="t-small text-label ml-auto font-mono tabular-nums" data-testid="run-progress-count">
        {{ progress.done }} / {{ progress.total }}
      </span>
      <span class="t-small text-label" :title="RUN_DURATION_HINT">{{ runElapsedLabel(run, now) }}</span>
    </div>

    <!-- One segment per step, coloured by that step's status. See `progress`. -->
    <RunProgressBar :steps="run.steps" :aria-label="`${progress.done} of ${progress.total} steps settled`" />

    <p v-if="run.status === 'interrupted'" class="t-small" :style="{ color: STATUS_COLOR.failed }">
      The process that was running this is gone. Its steps are frozen where they stopped.
    </p>

    <!-- What the runner checked before any agent ran. Only the checks that need
         a person: an all-clear is the silent, expected case. -->
    <div v-if="preflightNotable.length" class="rounded-lg p-2 t-small space-y-1" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <div class="font-medium" style="color: var(--text-primary);">Preflight</div>
      <div v-for="c in preflightNotable" :key="c.name" class="flex gap-2">
        <span class="font-mono shrink-0" :style="{ color: c.level === 'fail' ? STATUS_COLOR.failed : 'var(--warning)' }">{{ c.name }}</span>
        <span class="text-label">{{ c.detail }}</span>
      </div>
    </div>

    <!-- The outcome leads. This run finished, opened a pull request and spent
         96 minutes over 11 steps, and the first thing the page showed was a box
         of intake questions telling the reader to restart a step — on a run that
         was over. What the run PRODUCED is the answer to why anyone opened it. -->
    <div v-if="prLinks.length" class="flex flex-wrap gap-2">
      <!-- Named as an outcome and an action. A bare "alepolab/billing_cpp14/pull/106"
           says what it is and never what it is doing on the page or what to do
           with it — which is the whole answer to why this run existed. -->
      <a
        v-for="u in prLinks" :key="u" :href="u" target="_blank" rel="noopener"
        class="inline-flex items-center gap-2 rounded-lg px-3 py-2 t-ui focus-ring"
        style="background: var(--accent-muted); border: 1px solid var(--accent); color: var(--accent);"
      >
        <UIcon name="i-lucide-git-pull-request" class="size-4 shrink-0" />
        <span class="flex flex-col leading-tight text-left">
          <span class="font-medium">{{ settledRun ? 'This run opened a pull request — review it on GitHub' : 'Pull request opened — review it on GitHub' }}</span>
          <span class="t-small font-mono opacity-80">{{ u.replace(/^https?:\/\/(www\.)?github\.com\//, '') }}</span>
        </span>
        <UIcon name="i-lucide-external-link" class="size-3.5 shrink-0 ml-1" />
      </a>
    </div>

    <!-- Open on a live run, where they are a prompt to act. Collapsed on a
         settled one, where they are history and were taking the top of the page. -->
    <details v-if="intake?.open_questions?.length" class="rounded-lg p-2 t-small" :open="!settledRun" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <summary class="font-medium cursor-pointer focus-ring" style="color: var(--text-primary);">
        Intake left {{ intake.open_questions.length }} question(s) open
      </summary>
      <ol class="list-decimal ml-4 space-y-0.5 mt-1"><li v-for="q in intake.open_questions" :key="q">{{ q }}</li></ol>
      <p v-if="!settledRun" class="text-label mt-1">Answer in the note below and restart the step that needs the answer.</p>
    </details>
    <div v-if="run.question" class="rounded-lg p-3 t-small space-y-1" style="background: var(--accent-muted); border: 1px solid var(--accent);" role="alert">
      <!-- The eyebrow is the label; the question is the thing to read. These were
           the same size, inside a box built exactly like the two informational
           boxes above it — which is how the console's whole reason to exist came
           to look like a footnote. -->
      <div class="t-label" style="color: var(--text-secondary);">{{ run.question.reason === 'budget' ? 'Budget reached' : run.question.kind === 'approval' ? 'Waiting for your approval' : `${run.steps.find(s => s.stepId === run?.question?.stepId)?.label ?? 'A step'} is asking you` }}</div>
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

    <!-- What the reviewer is actually approving. The gate used to show a step
         label and one line of agent prose, with the measured change, the test
         results and the security verdict all sitting unread in the bundle. -->
    <RunVerdictCard
      v-if="run.question?.kind === 'approval' && run.question.reason !== 'budget'"
      :run="run"
    />

    <!-- What was decided at this run's earlier gates. A four-gate runbook used
         to arrive at its last gate with no record of who approved the first
         three or why: approval notes lived in memory and died with the process. -->
    <div v-if="run.decisions?.length" class="rounded-lg p-2 t-small space-y-1" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <div class="font-medium" style="color: var(--text-primary);">Earlier decisions on this run</div>
      <div v-for="d in run.decisions" :key="d.at" class="flex gap-2">
        <span
          class="font-mono uppercase shrink-0"
          :style="{ color: d.verdict === 'approved' ? STATUS_COLOR.completed : d.verdict === 'rejected' ? STATUS_COLOR.failed : STATUS_COLOR.paused }"
        >{{ d.verdict }}</span>
        <span class="shrink-0">{{ d.label }}</span>
        <span class="text-label truncate">{{ d.by }}<template v-if="d.note">: {{ d.note }}</template></span>
      </div>
    </div>
    <p v-if="sent && run.status === 'running'" class="t-small text-label">Queued for the next step: "{{ sent }}"</p>
    <!-- A live run or an open gate: the note has somewhere to go the moment it is
         typed, so it is offered directly. -->
    <textarea
      v-if="(mayDrive && run.status === 'running') || (mayAnswer && run.status === 'paused')"
      v-model="note"
      rows="2"
      class="field-input w-full resize-none t-small"
      :placeholder="notePlaceholder"
      :aria-label="notePlaceholder"
      @keydown.meta.enter="noteMode === 'reply' ? send('respond') : noteMode === 'steer' ? send('note') : noteMode === 'continue' ? send('continue') : undefined"
    />
    <!-- On a finished run, a note has nowhere to go until a step is chosen, so
         offering an open text box captioned "for the step you restart" asks the
         reader to act before there is an action. Both it and the explanation it
         needed now sit behind the thing they are for. -->
    <details v-if="mayDrive && settledRun" class="t-small rounded-lg p-2" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <summary class="cursor-pointer focus-ring" style="color: var(--text-primary);">Run part of this again</summary>
      <p class="text-label mt-1">
        Pick a step below and press its <span class="font-mono">↻</span> to run it again from there. Anything typed
        here is handed to that step as an instruction.
      </p>
      <p v-if="run.steps.some(s => s.sessionId)" class="text-label mt-1">
        To ask a step's agent a question instead, use the speech bubble on its row — that continues the conversation in
        the session it already ran in, with everything it saw.
      </p>
      <textarea
        v-model="note"
        rows="2"
        class="field-input w-full resize-none t-small mt-2"
        :placeholder="notePlaceholder"
        :aria-label="notePlaceholder"
      />
    </details>
    <!-- Tokens against the budget cap. The cost figure that used to lead this
         row was removed on request; the totals still come from
         server/utils/costReport.ts, which is the only place that aggregates
         per-step usage, and the cap is what the run pauses against. -->
    <!-- "20,276,919 tokens of 8,000,000" read as a run two and a half times over
         its limit, with nothing to say why it kept going. The cap is only worth
         showing as a denominator while the run is still measured against it. -->
    <div v-if="cost" class="flex items-center gap-2 t-small" data-testid="run-usage-summary">
      <span class="text-label" :title="run.budget ? `Cap ${run.budget.maxTokens.toLocaleString()} tokens, ${run.budget.maxMinutes} min.` : ''">
        {{ (cost.totals.input_tokens + cost.totals.output_tokens).toLocaleString() }} tokens
      </span>
      <span
        v-if="run.budget && (cost.totals.input_tokens + cost.totals.output_tokens) <= run.budget.maxTokens"
        class="text-label"
        :title="`Cap ${run.budget.maxTokens.toLocaleString()} tokens, ${run.budget.maxMinutes} min. Set in Settings; the run pauses and asks when it is reached.`"
      >of {{ run.budget.maxTokens.toLocaleString() }}</span>
      <span
        v-else-if="run.budget" class="text-label"
        :title="`This run was allowed to continue past its cap of ${run.budget.maxTokens.toLocaleString()} tokens.`"
      >· past its cap</span>
    </div>
    <!-- "Usage unavailable" was shown both for a run that reported no usage and
         for a request that failed. This line is only reached on a failure. -->
    <p v-else-if="costError" class="t-small" style="color: var(--warning);">Could not read this run's usage.</p>

    <!-- One row per agent. This is what the panel exists for. -->
    <div class="space-y-1">
      <div v-for="step in run.steps" :key="step.stepId" class="t-small">
        <div class="flex items-center gap-1">
          <button
            class="flex-1 min-w-0 flex items-center gap-2 text-left py-1"
            :aria-expanded="expanded === step.stepId"
            @click="expanded = expanded === step.stepId ? null : step.stepId"
          >
            <!-- A step's status was carried by hue and nothing else: this dot was
                 the only thing separating a completed step from a failed one, so
                 the row said nothing to a screen reader and nothing to anyone who
                 does not separate red from green. The colour stays; it is no
                 longer the only channel. -->
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :style="{ background: STATUS_COLOR[step.status] }"
              role="img"
              :aria-label="step.status"
              :title="step.status"
            />
            <!-- "Stand Up Stack" and its agent slug wrapped to two lines, making
                 that row taller than the ten around it and breaking the rhythm
                 the list is read down. The name holds; the slug gives way. -->
            <span class="font-medium whitespace-nowrap shrink-0">{{ step.label }}</span>
            <span class="text-label font-mono t-small truncate min-w-0">{{ step.agentSlug }}</span>
            <span v-if="step.visits > 1" class="t-small text-label" :title="`This step ran ${step.visits} times`">×{{ step.visits }}</span>
            <!-- The monitor's reasoning was recorded and never rendered: the row
                 showed an eight-character verdict and kept the sentence that
                 explains it to itself. -->
            <!-- Only when the monitor had something to say. CONTINUE is the
                 boring case and it was printed on all eleven rows in the same
                 weight as the step's own name, so the two verdicts that matter
                 had nothing to stand out from. -->
            <span
              v-if="step.monitorVerdict && step.monitorVerdict !== 'CONTINUE'"
              class="t-small font-mono shrink-0"
              :style="{ color: step.monitorVerdict === 'ABORT' ? STATUS_COLOR.failed : 'var(--warning)' }"
              :title="step.monitorNote || step.monitorVerdict"
            >{{ step.monitorVerdict }}</span>
            <!-- "The agent declared this not applicable" and "the scheduler
                 passed over it after an upstream failure" both rendered as the
                 same grey word. The runner treats that distinction as
                 load-bearing; the row never showed it. -->
            <span v-if="step.status === 'skipped' && step.skipReason" class="t-small text-label truncate" :title="step.skipReason">skipped: {{ step.skipReason }}</span>
            <span class="ml-auto t-small text-label">{{ elapsed(step) }}</span>
          </button>
          <!-- Visible on the row itself: an action nobody has to discover by
               expanding. Not for a reviewer: it opens the agent's live Claude
               Code session, which is the same power the sidebar's CLI entry
               was taken away from them for. -->
          <UButton
            v-if="mayDrive && step.sessionId && step.sessionProject"
            size="xs" variant="soft" icon="i-lucide-message-circle"
            :to="`/cli/project/${step.sessionProject}/session/${step.sessionId}`"
            :aria-label="`Open the ${step.label} agent's chat`" :title="`Open the ${step.label} agent's chat`"
          />
          <UButton
            v-if="mayDrive && settledRun && stepSettled(step)"
            size="xs" variant="soft" icon="i-lucide-rotate-ccw"
            :aria-label="`Restart from ${step.label}`" :title="`Restart from ${step.label}`"
            @click="emit('restart', step.stepId, note)"
          />
        </div>
        <div v-if="step.status === 'running' && latest(step.stepId) && expanded !== step.stepId" class="pl-4 t-small font-mono truncate text-label" :title="latest(step.stepId)">{{ latest(step.stepId) }}</div>
        <div v-if="expanded === step.stepId" class="pl-4 pb-2 space-y-1">
          <!-- Questions and feedback for a finished step go to the agent itself: its
               Claude Code session continues on /cli with everything it saw. -->
          <UButton
            v-if="mayDrive && step.sessionId && step.sessionProject"
            size="xs" variant="soft" icon="i-lucide-message-circle" label="Ask this agent"
            :to="`/cli/project/${step.sessionProject}/session/${step.sessionId}`"
          />
          <p v-if="step.error" class="t-small" :style="{ color: STATUS_COLOR.failed }">{{ step.error }}</p>
          <div v-if="liveFor(step.stepId).length" class="space-y-0.5">
            <div class="t-small text-label">Live output{{ step.status === 'running' ? '' : ' (this attempt)' }}</div>
            <div :ref="(el) => { logPre[step.stepId] = el as HTMLElement | null }" class="max-h-72 overflow-auto rounded p-2" style="background: var(--surface-base); border: 1px solid var(--border-subtle);"><LogLines :lines="liveFor(step.stepId)" /></div>
          </div>
          <pre v-if="step.output" class="t-small whitespace-pre-wrap max-h-64 overflow-auto">{{ step.output }}</pre>
          <p v-else-if="!liveFor(step.stepId).length" class="t-small text-label">No output yet.</p>
        </div>
      </div>
    </div>

    <!-- Not on the full run page, which already shows the real evidence browser
         beside this column: two file lists for one bundle, the lesser one
         rendering raw text in a <pre>. This stays for the builder's slide-over,
         where there is no other way to reach the files. -->
    <div v-if="!fullPage" class="space-y-1">
      <button class="t-small text-label underline" @click="artifacts ? (artifacts = null) : loadArtifacts()">
        {{ artifacts ? 'Hide evidence files' : 'Show evidence files' }}
      </button>
      <div v-if="artifacts" class="space-y-0.5">
        <p v-if="!artifacts.length" class="t-small text-label">No files yet.</p>
        <div v-for="f in artifacts" :key="f.name" class="t-small">
          <button class="font-mono underline" :aria-expanded="openFile === f.name" @click="showFile(f.name)">{{ f.name }}</button>
          <span class="text-label ml-1">{{ f.size < 1024 ? f.size + ' B' : Math.round(f.size / 1024) + ' KB' }}</span>
          <pre v-if="openFile === f.name" class="whitespace-pre-wrap max-h-72 overflow-auto mt-1 p-2 rounded" style="background: var(--surface-raised);">{{ fileText }}</pre>
        </div>
      </div>
    </div>

    <div class="flex gap-2">
      <UButton v-if="mayAnswer && noteMode === 'reply'" size="xs" icon="i-lucide-send" label="Reply" :disabled="!note.trim()" @click="send('respond')" />
      <UButton
        v-else-if="mayAnswer && run.status === 'paused' && run.question?.kind === 'approval'"
        size="xs" icon="i-lucide-check"
        :label="run.question.reason === 'budget' ? 'Continue with a fresh allowance' : 'Approve and run'"
        :disabled="run.question.reason !== 'budget' && !canApprove"
        :title="run.question.reason !== 'budget' && !canApprove ? 'Say why this is right before approving' : ''"
        @click="send('continue')"
      />
      <UButton v-else-if="mayAnswer && run.status === 'paused'" size="xs" label="Continue" @click="send('continue')" />
      <!-- The counterpart of Approve, on the same capability: a reviewer who
           cannot refuse is not gating anything. Disabled until a reason is
           typed, because the reason is the point. -->
      <!-- The reviewer's third answer, and the one that was missing: hand the
           work back to a named earlier step with the instruction it works from.
           The runner has always been able to do this; only an agent could ask
           for it. "Reject run" beside it ends the run — they were previously the
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
      <UButton v-if="mayDrive && noteMode === 'steer'" size="xs" variant="soft" icon="i-lucide-message-square" :label="anyRunning ? 'Send to running agent' : 'Send note to next step'" :disabled="!note.trim()" @click="send('note')" />
      <UButton v-if="mayDrive && run.status === 'interrupted'" size="xs" icon="i-lucide-play" label="Resume" @click="emit('continue')" />
      <UButton v-if="mayDrive && (run.status === 'running' || run.status === 'paused')" size="xs" variant="ghost" color="neutral" label="Stop" @click="emit('stop')" />
      <UButton v-if="mayDrive && settledRun" size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" label="Clone run" @click="emit('clone')" />
      <p v-if="!mayAnswer && run.status === 'paused'" class="t-small text-label self-center">This run is waiting on a decision from a developer.</p>
    </div>
  </div>

  <div v-else-if="runs.length" class="space-y-1">
    <div class="flex items-center gap-2">
      <p class="t-small text-label">Previous runs</p>
      <NuxtLink to="/runs" class="ml-auto t-small text-label hover:underline">All run history &rarr;</NuxtLink>
    </div>
    <button v-for="r in runs.slice(0, 10)" :key="r.id" class="w-full flex items-center gap-2 t-small py-1 text-left" @click="emit('attach', r.id)">
      <span class="w-2 h-2 rounded-full" :style="{ background: STATUS_COLOR[r.status] }" />
      <span>{{ new Date(r.startedAt).toLocaleString() }}</span>
      <span class="t-small text-label" :title="RUN_DURATION_HINT">{{ runElapsedLabel(r, now) }}</span>
      <span class="ml-auto t-small font-mono text-label">{{ r.status }}</span>
    </button>
    <p v-if="runs.length > 10" class="t-small text-label pt-1">
      Showing 10 of {{ runs.length }}. <NuxtLink to="/runs" class="hover:underline">See all</NuxtLink>.
    </p>
  </div>
</template>
