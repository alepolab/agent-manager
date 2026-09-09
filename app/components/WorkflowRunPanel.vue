<script setup lang="ts">
import { isLiveStatus, type WorkflowRun, type RunCostSummary } from '~~/shared/types/run'
import { RUN_STATUS_COLOR as STATUS_COLOR, SETTLED_STATUSES, runElapsedLabel, RUN_DURATION_HINT, runStatusLabel } from '~/utils/runStatus'

const props = defineProps<{ run: WorkflowRun | null, runs: WorkflowRun[], logs?: Record<string, string[]>, fullPage?: boolean }>()
const emit = defineEmits<{ continue: [note?: string], stop: [], attach: [id: string], restart: [stepId: string, note?: string], clone: [], close: [], respond: [reply: string], note: [text: string] }>()

/** The run is gated on the entries of an artifact, so RunDecisionPanel owns
 *  both the question and the resume: the generic note box and Approve button
 *  below would offer a second, cruder way to answer the same gate — one that
 *  acts on every entry. */
const reviewing = computed(() => props.run?.status === 'awaiting_review')

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
function send(kind: 'respond' | 'note' | 'continue') {
  const text = note.value.trim()
  if (kind === 'respond') emit('respond', text)
  else if (kind === 'note') { emit('note', text); sent.value = text }
  else emit('continue', text || undefined)
  note.value = ''
}

/** Optional correction handed to whichever step is restarted next. */
const note = ref('')

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
const settledRun = computed(() => !!props.run && !isLiveStatus(props.run.status))
const stepSettled = (s: { status: string }) => ['completed', 'failed', 'skipped'].includes(s.status)

/** A live run's timer has to advance between the run updates that arrive over
 *  SSE, or it reads as frozen while an agent works. One second, cleared with
 *  the component. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })

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
/** The run's declared inputs, as pairs, so the template stays declarative. */
const statedParameters = computed(() => Object.entries(props.run?.parameters ?? {}))

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
        class="text-[11px] text-label hover:underline shrink-0"
        data-testid="run-back-to-history"
        @click="emit('close')"
      >
        &larr; All runs ({{ runs.length }})
      </button>
      <NuxtLink v-if="!fullPage" :to="`/runs/${run.id}`" class="text-[11px] text-label hover:underline shrink-0 focus-ring" title="Steps, live output and every evidence file, full screen">Full page &nearr;</NuxtLink>
      <span class="text-[11px] font-mono uppercase" :style="{ color: STATUS_COLOR[run.status] }">
        {{ runStatusLabel(run.status) }}
      </span>
      <span class="text-[12px] text-label">{{ run.workflowName }}</span>
      <span class="text-[11px] text-label ml-auto font-mono tabular-nums" data-testid="run-progress-count">
        {{ progress.done }} / {{ progress.total }}
      </span>
      <span class="text-[11px] text-label" :title="RUN_DURATION_HINT">{{ runElapsedLabel(run, now) }}</span>
    </div>

    <!-- One segment per step, coloured by that step's status. See `progress`. -->
    <RunProgressBar :steps="run.steps" :aria-label="`${progress.done} of ${progress.total} steps settled`" />

    <!-- What this run was actually given. Shown because a reader deciding
         whether to clone or restart needs to know the inputs, and the prompt
         alone no longer carries them. -->
    <div v-if="statedParameters.length" class="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-mono" data-testid="run-parameters">
      <span v-for="[name, value] in statedParameters" :key="name" class="text-label">
        <span style="color: var(--text-tertiary);">{{ name }}:</span> {{ value }}
      </span>
    </div>

    <p v-if="run.status === 'interrupted'" class="text-[11px]" :style="{ color: STATUS_COLOR.failed }">
      The process that was running this is gone. Its steps are frozen where they stopped.
    </p>

    <!-- What the runner checked before any agent ran. Only the checks that need
         a person: an all-clear is the silent, expected case. -->
    <div v-if="preflightNotable.length" class="rounded-lg p-2 text-[11px] space-y-1" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <div class="font-medium" style="color: var(--text-primary);">Preflight</div>
      <div v-for="c in preflightNotable" :key="c.name" class="flex gap-2">
        <span class="font-mono shrink-0" :style="{ color: c.level === 'fail' ? STATUS_COLOR.failed : 'var(--warning)' }">{{ c.name }}</span>
        <span class="text-label">{{ c.detail }}</span>
      </div>
    </div>

    <div v-if="intake?.open_questions?.length" class="rounded-lg p-2 text-[11px] space-y-1" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <div class="font-medium" style="color: var(--text-primary);">Intake left {{ intake.open_questions.length }} question(s) open</div>
      <ol class="list-decimal ml-4 space-y-0.5"><li v-for="q in intake.open_questions" :key="q">{{ q }}</li></ol>
      <p class="text-label">Answer in the note below and restart the step that needs the answer.</p>
    </div>
    <div v-if="prLinks.length" class="flex flex-wrap gap-3 text-[11px]">
      <a v-for="u in prLinks" :key="u" :href="u" target="_blank" rel="noopener" class="underline" style="color: var(--accent);">Pull request: {{ u.replace(/^https?:\/\/(www\.)?github\.com\//, '') }}</a>
    </div>
    <!-- A run gated on the entries of an artifact gets the panel that can take
         those decisions, not the one-line banner and the single Approve button
         below: approving the step acts on every entry, which is the thing the
         reviewer is here to prevent. -->
    <RunDecisionPanel v-if="reviewing" :run="run" />
    <div v-else-if="run.question" class="rounded-lg p-3 text-[12px] space-y-1" style="background: var(--accent-muted); border: 1px solid var(--accent);" role="alert">
      <div class="font-medium" style="color: var(--text-primary);">{{ run.question.reason === 'budget' ? 'Budget reached' : run.question.kind === 'approval' ? 'Waiting for your approval' : `${run.steps.find(s => s.stepId === run?.question?.stepId)?.label ?? 'A step'} is asking you` }}</div>
      <p class="whitespace-pre-wrap">{{ run.question.text }}</p>
    </div>
    <p v-if="sent && run.status === 'running'" class="text-[11px] text-label">Queued for the next step: "{{ sent }}"</p>
    <textarea
      v-if="!reviewing && (settledRun || run.status === 'paused' || run.status === 'running')"
      v-model="note"
      rows="2"
      class="field-input w-full resize-none text-[12px]"
      :placeholder="notePlaceholder"
      :aria-label="notePlaceholder"
      @keydown.meta.enter="noteMode === 'reply' ? send('respond') : noteMode === 'steer' ? send('note') : noteMode === 'continue' ? send('continue') : undefined"
    />
    <p v-if="settledRun && run.steps.some(s => s.sessionId)" class="text-[11px] text-label">
      Questions or feedback for a step's agent go to its chat: expand the step and choose Ask this agent, or use the speech bubble on its row. The conversation continues with everything the agent saw. A note typed here goes to the step you restart.
    </p>
    <!-- Tokens against the budget cap. The cost figure that used to lead this
         row was removed on request; the totals still come from
         server/utils/costReport.ts, which is the only place that aggregates
         per-step usage, and the cap is what the run pauses against. -->
    <div v-if="cost" class="flex items-center gap-2 text-[11px]" data-testid="run-usage-summary">
      <span class="text-label">{{ (cost.totals.input_tokens + cost.totals.output_tokens).toLocaleString() }} tokens</span>
      <span v-if="run.budget" class="text-label" :title="`Cap ${run.budget.maxTokens.toLocaleString()} tokens, ${run.budget.maxMinutes} min. Set in Settings; the run pauses and asks when it is reached.`">of {{ run.budget.maxTokens.toLocaleString() }}</span>
    </div>
    <p v-else-if="costError" class="text-[11px] text-label">Usage unavailable.</p>

    <!-- One row per agent. This is what the panel exists for. -->
    <div class="space-y-1">
      <div v-for="step in run.steps" :key="step.stepId" class="text-[12px]">
        <div class="flex items-center gap-1">
          <button
            class="flex-1 min-w-0 flex items-center gap-2 text-left py-1"
            :aria-expanded="expanded === step.stepId"
            @click="expanded = expanded === step.stepId ? null : step.stepId"
          >
            <span class="w-2 h-2 rounded-full shrink-0" :style="{ background: STATUS_COLOR[step.status] }" />
            <span class="font-medium">{{ step.label }}</span>
            <span class="text-label font-mono text-[10px]">{{ step.agentSlug }}</span>
            <span v-if="step.visits > 1" class="text-[10px] text-label">×{{ step.visits }}</span>
            <span v-if="step.monitorVerdict" class="text-[10px] font-mono">{{ step.monitorVerdict }}</span>
            <span class="ml-auto text-[10px] text-label">{{ elapsed(step) }}</span>
          </button>
          <!-- Visible on the row itself: an action nobody has to discover by expanding. -->
          <UButton
            v-if="step.sessionId && step.sessionProject"
            size="xs" variant="soft" icon="i-lucide-message-circle"
            :to="`/cli/project/${step.sessionProject}/session/${step.sessionId}`"
            :aria-label="`Open the ${step.label} agent's chat`" :title="`Open the ${step.label} agent's chat`"
          />
          <UButton
            v-if="settledRun && stepSettled(step)"
            size="xs" variant="soft" icon="i-lucide-rotate-ccw"
            :aria-label="`Restart from ${step.label}`" :title="`Restart from ${step.label}`"
            @click="emit('restart', step.stepId, note)"
          />
        </div>
        <div v-if="step.status === 'running' && latest(step.stepId) && expanded !== step.stepId" class="pl-4 text-[10px] font-mono truncate text-label" :title="latest(step.stepId)">{{ latest(step.stepId) }}</div>
        <div v-if="expanded === step.stepId" class="pl-4 pb-2 space-y-1">
          <!-- Questions and feedback for a finished step go to the agent itself: its
               Claude Code session continues on /cli with everything it saw. -->
          <UButton
            v-if="step.sessionId && step.sessionProject"
            size="xs" variant="soft" icon="i-lucide-message-circle" label="Ask this agent"
            :to="`/cli/project/${step.sessionProject}/session/${step.sessionId}`"
          />
          <p v-if="step.error" class="text-[11px]" :style="{ color: STATUS_COLOR.failed }">{{ step.error }}</p>
          <div v-if="liveFor(step.stepId).length" class="space-y-0.5">
            <div class="text-[10px] text-label">Live output{{ step.status === 'running' ? '' : ' (this attempt)' }}</div>
            <div :ref="(el) => { logPre[step.stepId] = el as HTMLElement | null }" class="max-h-72 overflow-auto rounded p-2" style="background: var(--surface-base); border: 1px solid var(--border-subtle);"><LogLines :lines="liveFor(step.stepId)" /></div>
          </div>
          <pre v-if="step.output" class="text-[11px] whitespace-pre-wrap max-h-64 overflow-auto">{{ step.output }}</pre>
          <p v-else-if="!liveFor(step.stepId).length" class="text-[11px] text-label">No output yet.</p>
        </div>
      </div>
    </div>

    <div class="space-y-1">
      <button class="text-[11px] text-label underline" @click="artifacts ? (artifacts = null) : loadArtifacts()">
        {{ artifacts ? 'Hide evidence files' : 'Show evidence files' }}
      </button>
      <div v-if="artifacts" class="space-y-0.5">
        <p v-if="!artifacts.length" class="text-[11px] text-label">No files yet.</p>
        <div v-for="f in artifacts" :key="f.name" class="text-[11px]">
          <button class="font-mono underline" :aria-expanded="openFile === f.name" @click="showFile(f.name)">{{ f.name }}</button>
          <span class="text-label ml-1">{{ f.size < 1024 ? f.size + ' B' : Math.round(f.size / 1024) + ' KB' }}</span>
          <pre v-if="openFile === f.name" class="whitespace-pre-wrap max-h-72 overflow-auto mt-1 p-2 rounded" style="background: var(--surface-raised);">{{ fileText }}</pre>
        </div>
      </div>
    </div>

    <div class="flex gap-2">
      <UButton v-if="!reviewing && noteMode === 'reply'" size="xs" icon="i-lucide-send" label="Reply" :disabled="!note.trim()" @click="send('respond')" />
      <UButton v-else-if="run.status === 'paused' && run.question?.kind === 'approval'" size="xs" icon="i-lucide-check" :label="run.question.reason === 'budget' ? 'Continue with a fresh allowance' : 'Approve and run'" @click="send('continue')" />
      <UButton v-else-if="run.status === 'paused'" size="xs" label="Continue" @click="send('continue')" />
      <UButton v-if="noteMode === 'steer'" size="xs" variant="soft" icon="i-lucide-message-square" :label="anyRunning ? 'Send to running agent' : 'Send note to next step'" :disabled="!note.trim()" @click="send('note')" />
      <UButton v-if="run.status === 'interrupted'" size="xs" icon="i-lucide-play" label="Resume" @click="emit('continue')" />
      <UButton v-if="isLiveStatus(run.status)" size="xs" variant="ghost" color="neutral" label="Stop" @click="emit('stop')" />
      <UButton v-if="settledRun" size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" label="Clone run" @click="emit('clone')" />
    </div>
  </div>

  <div v-else-if="runs.length" class="space-y-1">
    <div class="flex items-center gap-2">
      <p class="text-[11px] text-label">Previous runs</p>
      <NuxtLink to="/runs" class="ml-auto text-[11px] text-label hover:underline">All run history &rarr;</NuxtLink>
    </div>
    <button v-for="r in runs.slice(0, 10)" :key="r.id" class="w-full flex items-center gap-2 text-[12px] py-1 text-left" @click="emit('attach', r.id)">
      <span class="w-2 h-2 rounded-full" :style="{ background: STATUS_COLOR[r.status] }" />
      <span>{{ new Date(r.startedAt).toLocaleString() }}</span>
      <span class="text-[10px] text-label" :title="RUN_DURATION_HINT">{{ runElapsedLabel(r, now) }}</span>
      <span class="ml-auto text-[10px] font-mono text-label">{{ runStatusLabel(r.status) }}</span>
    </button>
    <p v-if="runs.length > 10" class="text-[11px] text-label pt-1">
      Showing 10 of {{ runs.length }}. <NuxtLink to="/runs" class="hover:underline">See all</NuxtLink>.
    </p>
  </div>
</template>
