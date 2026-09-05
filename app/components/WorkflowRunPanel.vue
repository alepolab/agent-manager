<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import { RUN_STATUS_COLOR as STATUS_COLOR } from '~/utils/runStatus'

const props = defineProps<{ run: WorkflowRun | null, runs: WorkflowRun[] }>()
const emit = defineEmits<{ continue: [], stop: [], attach: [id: string], restart: [stepId: string, note?: string], clone: [] }>()

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

/** Restart and clone only make sense once nothing is executing. */
const settledRun = computed(() => !!props.run && !['running', 'paused'].includes(props.run.status))
const stepSettled = (s: { status: string }) => ['completed', 'failed', 'skipped'].includes(s.status)

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
const settled = new Set(['completed', 'failed', 'skipped', 'stopped'])
const progress = computed(() => {
  const steps = props.run?.steps ?? []
  return { done: steps.filter(s => settled.has(s.status)).length, total: steps.length }
})

const expanded = ref<string | null>(null)
</script>

<template>
  <div v-if="run" class="border rounded-md p-4 space-y-3">
    <div class="flex items-center gap-3">
      <span class="text-[11px] font-mono uppercase" :style="{ color: STATUS_COLOR[run.status] }">
        {{ run.status }}
      </span>
      <span class="text-[12px] text-label">{{ run.workflowName }}</span>
      <span class="text-[11px] text-label ml-auto font-mono tabular-nums" data-testid="run-progress-count">
        {{ progress.done }} / {{ progress.total }}
      </span>
      <span class="text-[11px] text-label">{{ elapsed({ startedAt: run.startedAt, completedAt: run.endedAt }) }}</span>
    </div>

    <!-- One segment per step, coloured by that step's status. See `progress`. -->
    <RunProgressBar :steps="run.steps" :aria-label="`${progress.done} of ${progress.total} steps settled`" />

    <p v-if="run.status === 'interrupted'" class="text-[11px]" :style="{ color: STATUS_COLOR.failed }">
      The process that was running this is gone. Its steps are frozen where they stopped.
    </p>

    <textarea
      v-if="settledRun"
      v-model="note"
      rows="2"
      class="field-input w-full resize-none text-[12px]"
      placeholder="Optional note for the step you restart, e.g. verify from inside the container only"
      aria-label="Note for the restarted step"
    />

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
            v-if="settledRun && stepSettled(step)"
            size="xs" variant="ghost" color="neutral" icon="i-lucide-rotate-ccw"
            :aria-label="`Restart from ${step.label}`" :title="`Restart from ${step.label}`"
            @click="emit('restart', step.stepId, note)"
          />
        </div>
        <div v-if="expanded === step.stepId" class="pl-4 pb-2 space-y-1">
          <p v-if="step.error" class="text-[11px]" :style="{ color: STATUS_COLOR.failed }">{{ step.error }}</p>
          <pre v-if="step.output" class="text-[11px] whitespace-pre-wrap max-h-64 overflow-auto">{{ step.output }}</pre>
          <p v-else class="text-[11px] text-label">No output yet.</p>
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
      <UButton v-if="run.status === 'paused'" size="xs" label="Continue" @click="emit('continue')" />
      <UButton v-if="run.status === 'interrupted'" size="xs" icon="i-lucide-play" label="Resume" @click="emit('continue')" />
      <UButton v-if="run.status === 'running' || run.status === 'paused'" size="xs" variant="ghost" color="neutral" label="Stop" @click="emit('stop')" />
      <UButton v-if="settledRun" size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" label="Clone run" @click="emit('clone')" />
    </div>
  </div>

  <div v-else-if="runs.length" class="space-y-1">
    <p class="text-[11px] text-label">Previous runs</p>
    <button v-for="r in runs.slice(0, 10)" :key="r.id" class="w-full flex items-center gap-2 text-[12px] py-1 text-left" @click="emit('attach', r.id)">
      <span class="w-2 h-2 rounded-full" :style="{ background: STATUS_COLOR[r.status] }" />
      <span>{{ new Date(r.startedAt).toLocaleString() }}</span>
      <span class="ml-auto text-[10px] font-mono text-label">{{ r.status }}</span>
    </button>
  </div>
</template>
