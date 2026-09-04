<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'

const props = defineProps<{ run: WorkflowRun | null, runs: WorkflowRun[] }>()
const emit = defineEmits<{ continue: [], stop: [], attach: [id: string] }>()

const STATUS_COLOR: Record<string, string> = {
  running: 'var(--info, #3b82f6)',
  paused: 'var(--warning, #f59e0b)',
  completed: 'var(--success, #22c55e)',
  failed: 'var(--error, #ef4444)',
  stopped: 'var(--text-disabled, #9ca3af)',
  interrupted: 'var(--error, #ef4444)',
  pending: 'var(--text-disabled, #9ca3af)',
  skipped: 'var(--text-disabled, #9ca3af)',
}

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
    <div class="flex gap-0.5" data-testid="run-progress-bar" :aria-label="`${progress.done} of ${progress.total} steps settled`">
      <span
        v-for="step in run.steps"
        :key="`seg-${step.stepId}`"
        class="h-1 flex-1 rounded-sm"
        :style="{ background: STATUS_COLOR[step.status] }"
        :title="`${step.label}: ${step.status}`"
      />
    </div>

    <p v-if="run.status === 'interrupted'" class="text-[11px]" :style="{ color: STATUS_COLOR.failed }">
      The process that was running this is gone. Its steps are frozen where they stopped.
    </p>

    <!-- One row per agent. This is what the panel exists for. -->
    <div class="space-y-1">
      <div v-for="step in run.steps" :key="step.stepId" class="text-[12px]">
        <button class="w-full flex items-center gap-2 text-left py-1" @click="expanded = expanded === step.stepId ? null : step.stepId">
          <span class="w-2 h-2 rounded-full shrink-0" :style="{ background: STATUS_COLOR[step.status] }" />
          <span class="font-medium">{{ step.label }}</span>
          <span class="text-label font-mono text-[10px]">{{ step.agentSlug }}</span>
          <span v-if="step.visits > 1" class="text-[10px] text-label">×{{ step.visits }}</span>
          <span v-if="step.monitorVerdict" class="text-[10px] font-mono">{{ step.monitorVerdict }}</span>
          <span class="ml-auto text-[10px] text-label">{{ elapsed(step) }}</span>
        </button>
        <div v-if="expanded === step.stepId" class="pl-4 pb-2 space-y-1">
          <p v-if="step.error" class="text-[11px]" :style="{ color: STATUS_COLOR.failed }">{{ step.error }}</p>
          <pre v-if="step.output" class="text-[11px] whitespace-pre-wrap max-h-64 overflow-auto">{{ step.output }}</pre>
          <p v-else class="text-[11px] text-label">No output yet.</p>
        </div>
      </div>
    </div>

    <div class="flex gap-2">
      <UButton v-if="run.status === 'paused'" size="xs" label="Continue" @click="emit('continue')" />
      <UButton v-if="run.status === 'running' || run.status === 'paused'" size="xs" variant="ghost" color="neutral" label="Stop" @click="emit('stop')" />
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
