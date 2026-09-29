<script setup lang="ts">
import { isLiveStatus, isTestRun, type WorkflowRun, type RunCostSummary } from '~~/shared/types/run'
import { RUN_STATUS_COLOR as STATUS_COLOR, SETTLED_STATUSES, runElapsedLabel, RUN_DURATION_HINT, GATE_VERDICT } from '~/utils/runStatus'

/**
 * A run as a whole: what it is, how far it got, what it was given, what it
 * produced and cost, and the controls that act on all of it. Shared by
 * RunStack, which renders it above the run's step cards.
 */
const props = defineProps<{ run: WorkflowRun }>()
const emit = defineEmits<{ note: [text: string], continue: [], stop: [], clone: [] }>()

const { can } = useUser()
const mayDrive = computed(() => can('runEngine'))
const settledRun = computed(() => !isLiveStatus(props.run.status))
const anyRunning = computed(() => props.run.steps.some(s => s.status === 'running'))

// Stop is irreversible for whatever step is mid-flight: ask once, inline, then
// forget - the same two-click confirm /runs used to give it in its table row.
const confirmingStop = ref(false)
let stopTimer: ReturnType<typeof setTimeout> | null = null
function handleStop() {
  if (!confirmingStop.value) {
    confirmingStop.value = true
    if (stopTimer) clearTimeout(stopTimer)
    stopTimer = setTimeout(() => { confirmingStop.value = false }, 4000)
    return
  }
  confirmingStop.value = false
  if (stopTimer) clearTimeout(stopTimer)
  emit('stop')
}
// A different run replacing this one (RunDetailPane keys on id, but this
// component itself does not remount) must not leave a stale "Confirm stop"
// armed against the run now showing.
watch(() => props.run.id, () => { confirmingStop.value = false; if (stopTimer) clearTimeout(stopTimer) })
onUnmounted(() => { if (stopTimer) clearTimeout(stopTimer) })

/** Steering a running run: the note reaches the agent working now, or the next step to start. */
const steer = ref('')
const sent = ref<string | null>(null)
const steerPlaceholder = computed(() => (anyRunning.value
  ? 'Instruction for the agent working now, e.g. the plugin lives under modules/administrator'
  : 'Send a note to whichever step starts next, e.g. the plugin lives under modules/administrator'))
function sendNote() {
  const text = steer.value.trim()
  if (!text) return
  emit('note', text)
  sent.value = text
  steer.value = ''
}

const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })

const statedParameters = computed(() => Object.entries(props.run.parameters ?? {}))
const progress = computed(() => ({
  done: props.run.steps.filter(s => SETTLED_STATUSES.has(s.status)).length,
  total: props.run.steps.length,
}))
const preflightNotable = computed(() => (props.run.preflight?.checks ?? []).filter(c => c.level === 'fail' || c.level === 'warn'))

/** What intake left unanswered, and where the fix landed: read from the run's own artifacts. */
const intake = ref<{ open_questions?: string[] } | null>(null)
const prLinks = ref<string[]>([])

async function loadFacts() {
  const id = props.run.id
  try { intake.value = JSON.parse(await $fetch<string>(`/api/runs/${id}/artifacts/context-packet.json`, { responseType: 'text' })) } catch { intake.value = null }
  try {
    const meta = JSON.parse(await $fetch<string>(`/api/runs/${id}/artifacts/meta.json`, { responseType: 'text' }))
    // A real pull request only: the schema forces the fix step to write a placeholder URL before one exists.
    prLinks.value = (meta?.fix?.repos ?? []).map((r: any) => r?.pr).filter((u: unknown): u is string => typeof u === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(u))
  } catch { prLinks.value = [] }
}
watch(() => [props.run.id, props.run.status, props.run.steps.filter(s => s.status === 'completed').length], loadFacts, { immediate: true })

// Usage totals are fetched separately from the run record (GET /api/runs/[id]/cost,
// server/utils/costReport.ts) rather than computed here: pricing lives in
// server/utils/models.ts only, and this component has no business re-deriving
// it from raw token counts. Re-fetched on the run's id (a different run
// entirely) AND on how many of its steps have settled - a live run's cost
// only grows when a step actually finishes reporting usage, not on every
// intermediate SSE status frame in between.
const cost = ref<RunCostSummary | null>(null)
const costError = ref(false)
watch([() => props.run.id, () => progress.value.done], async ([id]) => {
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
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <StatusLabel :status="run.status" />
      <span class="t-small text-label">{{ run.workflowName }}</span>
      <span class="t-small text-label ml-auto tabular-nums" data-testid="run-progress-count">{{ progress.done }} of {{ progress.total }}</span>
      <span class="t-small text-label" :title="RUN_DURATION_HINT">{{ runElapsedLabel(run, now) }}</span>
    </div>
    <p v-if="run.error" class="t-small" style="color: var(--error);">{{ run.error }}</p>
    <RunProgressBar :steps="run.steps" :aria-label="`${progress.done} of ${progress.total} steps settled`" />

    <!-- What this run was actually given. Shown because a reader deciding
         whether to clone or restart needs to know the inputs, and the prompt
         alone no longer carries them. -->
    <div v-if="statedParameters.length" class="flex flex-wrap gap-x-4 gap-y-1 t-small" data-testid="run-parameters">
      <span v-for="[name, value] in statedParameters" :key="name" class="text-label">
        <span style="color: var(--text-tertiary);">{{ name }}</span> <span class="font-mono" style="color: var(--text-primary);">{{ value }}</span>
      </span>
    </div>

    <p v-if="run.status === 'interrupted'" class="t-small" :style="{ color: STATUS_COLOR.failed }">
      The process that was running this is gone. Its steps are frozen where they stopped.
    </p>

    <!-- What the runner checked before any agent ran. Only the checks that need
         a person: an all-clear is the silent, expected case. -->
    <div v-if="preflightNotable.length" class="group-card p-3! t-small space-y-1">
      <div class="font-medium" style="color: var(--text-primary);">Preflight</div>
      <div v-for="c in preflightNotable" :key="c.name" class="flex gap-2">
        <StatusLabel :status="c.level === 'fail' ? 'failed' : 'paused'" :label="c.name" class="shrink-0" />
        <span class="text-label">{{ c.detail }}</span>
      </div>
    </div>

    <!-- The outcome leads. This run finished, opened a pull request and spent
         96 minutes over 11 steps, and the first thing the page showed was a box
         of intake questions telling the reader to restart a step — on a run that
         was over. What the run PRODUCED is the answer to why anyone opened it. -->
    <div v-if="prLinks.length || run.ci" class="flex flex-wrap items-center gap-2">
      <!-- Named as an outcome and an action. A bare "alepolab/billing_cpp14/pull/106"
           says what it is and never what it is doing on the page or what to do
           with it — which is the whole answer to why this run existed. -->
      <a
        v-for="u in prLinks" :key="u" :href="u" target="_blank" rel="noopener"
        class="inline-flex items-center gap-2 rounded-lg px-3 py-2 t-ui focus-ring"
        style="background: var(--accent-muted); color: var(--accent);"
      >
        <UIcon name="i-lucide-git-pull-request" class="size-4 shrink-0" />
        <span class="flex flex-col leading-tight text-left">
          <span class="font-medium">{{ settledRun ? 'This run opened a pull request — review it on GitHub' : 'Pull request opened — review it on GitHub' }}</span>
          <span class="t-small font-mono opacity-80">{{ u.replace(/^https?:\/\/(www\.)?github\.com\//, '') }}</span>
        </span>
        <UIcon name="i-lucide-external-link" class="size-3.5 shrink-0 ml-1" />
      </a>
      <a
        v-if="run.ci"
        :href="run.ci.pr" target="_blank" rel="noopener"
        class="ml-1 t-small underline self-center"
        :title="run.ci.checks.map(c => `${c.name}: ${c.bucket}`).join('\n') || run.ci.error || ''"
        :style="{ color: run.ci.status === 'failing' ? STATUS_COLOR.failed : run.ci.status === 'passing' ? STATUS_COLOR.completed : 'inherit' }"
      >CI {{ run.ci.status }}</a>
    </div>

    <!-- Open on a live run, where they are a prompt to act. Collapsed on a
         settled one, where they are history and were taking the top of the page. -->
    <details v-if="intake?.open_questions?.length" class="group-card p-3! t-small" :open="!settledRun">
      <summary class="font-medium cursor-pointer focus-ring" style="color: var(--text-primary);">
        Intake left {{ intake.open_questions.length }} question(s) open
      </summary>
      <ol class="list-decimal ml-4 space-y-0.5 mt-1"><li v-for="q in intake.open_questions" :key="q">{{ q }}</li></ol>
      <p v-if="!settledRun" class="text-label mt-1">Answer it when you replay the step that needs it.</p>
    </details>

    <!-- What was decided at this run's earlier gates. A four-gate runbook used
         to arrive at its last gate with no record of who approved the first
         three or why: approval notes lived in memory and died with the process. -->
    <div v-if="run.decisions?.length" class="group-card p-3! t-small space-y-1">
      <div class="font-medium" style="color: var(--text-primary);">Earlier decisions on this run</div>
      <div v-for="d in run.decisions" :key="d.at" class="flex gap-2">
        <StatusLabel :status="GATE_VERDICT[d.verdict]?.status ?? 'paused'" :label="GATE_VERDICT[d.verdict]?.word ?? d.verdict" class="shrink-0" />
        <span class="shrink-0">{{ d.label }}</span>
        <span class="text-label truncate">{{ d.by }}<template v-if="d.note">: {{ d.note }}</template></span>
      </div>
    </div>

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

    <p v-if="sent && run.status === 'running'" class="t-small text-label">Queued for the next step: "{{ sent }}"</p>
    <textarea
      v-if="mayDrive && run.status === 'running'"
      v-model="steer" rows="2" class="field-input w-full resize-none t-small"
      :placeholder="steerPlaceholder" :aria-label="steerPlaceholder"
      @keydown.meta.enter="sendNote"
    />
    <div class="flex flex-wrap gap-2">
      <UButton v-if="mayDrive && run.status === 'running'" size="xs" variant="soft" icon="i-lucide-message-square" :label="anyRunning ? 'Send to running agent' : 'Send note to next step'" :disabled="!steer.trim()" @click="sendNote" />
      <UButton v-if="mayDrive && run.status === 'interrupted'" size="xs" icon="i-lucide-play" label="Resume" @click="emit('continue')" />
      <UButton
        v-if="mayDrive && isLiveStatus(run.status)"
        size="xs" :variant="confirmingStop ? 'solid' : 'ghost'" :color="confirmingStop ? 'error' : 'neutral'"
        icon="i-lucide-square" :label="confirmingStop ? 'Confirm stop' : 'Stop'" @click="handleStop"
      />
      <!-- Not for a test run: a clone is a REAL run, and would carry a test's config into real side effects. -->
      <UButton v-if="mayDrive && settledRun && !isTestRun(run)" size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" label="Clone run" @click="emit('clone')" />
    </div>
  </div>
</template>
