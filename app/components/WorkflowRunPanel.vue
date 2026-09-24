<script setup lang="ts">
import { isLiveStatus, type WorkflowRun } from '~~/shared/types/run'
import { RUN_STATUS_COLOR as STATUS_COLOR, runElapsedLabel, RUN_DURATION_HINT, runStatusLabel } from '~/utils/runStatus'

const props = defineProps<{ run: WorkflowRun | null, runs: WorkflowRun[], logs?: Record<string, string[]>, fullPage?: boolean }>()
const emit = defineEmits<{ continue: [note?: string], stop: [], attach: [id: string], restart: [stepId: string, note?: string], clone: [], close: [], respond: [reply: string], note: [text: string], reject: [note: string], rework: [stepId: string, note: string] }>()

/**
 * What this person may do here. A reviewer holds `answerGate` and not
 * `runEngine`: they decide at the gate, and the pipeline's controls — stop,
 * restart a step, clone, steer a running agent — are not theirs. The server
 * refuses those routes for them too; this only stops us offering what would
 * then be refused.
 */
const { can } = useUser()
const mayDrive = computed(() => can('runEngine'))

/** Restart and clone only make sense once nothing is executing. */
const settledRun = computed(() => !!props.run && !isLiveStatus(props.run.status))
const stepSettled = (s: { status: string }) => ['completed', 'failed', 'skipped'].includes(s.status)

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
    </div>
    <RunHeader :run="run" @note="(t) => emit('note', t)" @continue="emit('continue')" @stop="emit('stop')" @clone="emit('clone')" />
    <RunGate
      :run="run"
      @respond="(r) => emit('respond', r)" @continue="(n) => emit('continue', n)"
      @reject="(n) => emit('reject', n)" @rework="(s, n) => emit('rework', s, n)"
    />
    <details v-if="mayDrive && settledRun" class="t-small rounded-lg p-2" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <summary class="cursor-pointer focus-ring" style="color: var(--text-primary);">Run part of this again</summary>
      <p class="text-label mt-1">Pick a step below and press its <span class="font-mono">↻</span> to run it again from there. Anything typed here is handed to that step as an instruction.</p>
      <p v-if="run.steps.some(s => s.sessionId)" class="text-label mt-1">To ask a step's agent a question instead, use the speech bubble on its row — that continues the conversation in the session it already ran in, with everything it saw.</p>
      <textarea v-model="note" rows="2" class="field-input w-full resize-none t-small mt-2" placeholder="Optional note for the step you restart, e.g. verify from inside the container only" aria-label="Note for the step you restart" />
    </details>

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
            <span v-if="step.childRunIds?.length" class="t-small text-label shrink-0" data-testid="child-run-count">
              {{ step.childRunIds.length }} {{ step.childRunIds.length === 1 ? 'child run' : 'child runs' }}
            </span>
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
          <!-- The runs this step started. Without these a fan-out is a set of
               unrelated rows on /runs, and childRunIds - persisted since the
               dispatch step existed - was the link nothing followed. -->
          <div v-if="step.childRunIds?.length" class="space-y-0.5" data-testid="child-runs">
            <div class="t-small text-label">
              {{ step.childRunIds.length === 1 ? 'The run this step started' : 'The runs this step started' }}<template v-if="step.status === 'waiting'">, which it is waiting for</template>
            </div>
            <div class="flex flex-wrap gap-x-2 gap-y-0.5">
              <NuxtLink
                v-for="childId in step.childRunIds" :key="childId" :to="`/runs/${childId}`"
                class="font-mono t-small underline" :title="childId"
              >{{ childId.slice(0, 8) }}</NuxtLink>
            </div>
          </div>
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
      <span class="ml-auto t-small font-mono text-label">{{ runStatusLabel(r.status) }}</span>
    </button>
    <p v-if="runs.length > 10" class="t-small text-label pt-1">
      Showing 10 of {{ runs.length }}. <NuxtLink to="/runs" class="hover:underline">See all</NuxtLink>.
    </p>
  </div>
</template>
