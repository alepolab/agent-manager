<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import { RUN_STATUS_COLOR } from '~/utils/runStatus'

/**
 * The one-line run control that stays visible above the canvas. Every action a
 * developer reaches for while a run is going lives here, so nothing scrolls.
 * The per-step detail lives in the slide-over opened by "Details".
 */
const props = defineProps<{ run: WorkflowRun | null, runs: WorkflowRun[] }>()
const emit = defineEmits<{ continue: [], stop: [], restart: [stepId: string], clone: [], details: [] }>()

const settled = computed(() => !!props.run && !['running', 'paused'].includes(props.run.status))
/** One-click restart resumes from the failed step, or from what was executing. */
const restartPoint = computed(() => {
  const r = props.run
  if (!r) return undefined
  return r.steps.find(s => s.status === 'failed')?.stepId
    ?? r.currentStepIds[0]
    ?? r.steps.find(s => s.status !== 'completed')?.stepId
})
const canRestart = computed(() => settled.value && props.run!.status !== 'completed' && !!restartPoint.value)

const settledSet = new Set(['completed', 'failed', 'skipped', 'stopped'])
const progress = computed(() => {
  const steps = props.run?.steps ?? []
  return { done: steps.filter(s => settledSet.has(s.status)).length, total: steps.length }
})
const elapsed = computed(() => {
  const r = props.run
  if (!r) return ''
  const secs = Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000)
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
})
const current = computed(() => {
  const r = props.run
  if (!r) return ''
  const ids = new Set(r.currentStepIds)
  return r.steps.filter(s => ids.has(s.stepId)).map(s => s.label).join(', ')
})

// Stop is irreversible for the step in flight, so it asks once, inline, and
// forgets the question after a few seconds. No browser dialog.
const confirmingStop = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null
function onStop() {
  if (!confirmingStop.value) {
    confirmingStop.value = true
    confirmTimer = setTimeout(() => { confirmingStop.value = false }, 4000)
    return
  }
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmingStop.value = false
  emit('stop')
}
</script>

<template>
  <div
    v-if="run || runs.length"
    class="px-4 py-2 flex items-center gap-3 flex-wrap"
    style="border-bottom: 1px solid var(--border-subtle); background: var(--surface-raised);"
    data-testid="run-bar"
  >
    <template v-if="run">
      <span class="text-[11px] font-mono uppercase" :style="{ color: RUN_STATUS_COLOR[run.status] }" aria-live="polite">
        {{ run.status }}
      </span>
      <div class="w-40"><RunProgressBar :steps="run.steps" /></div>
      <span class="text-[11px] text-label font-mono tabular-nums" data-testid="run-progress-count">{{ progress.done }} / {{ progress.total }}</span>
      <span v-if="current" class="text-[11px] text-label truncate max-w-[16rem]">{{ current }}</span>
      <span class="text-[11px] text-label font-mono tabular-nums">{{ elapsed }}</span>
      <span v-if="run.usage" class="text-[11px] text-label font-mono tabular-nums" :title="`${run.usage.input_tokens} in / ${run.usage.output_tokens} out`">${{ run.usage.usd.toFixed(2) }}</span>
      <div class="flex items-center gap-1 ml-auto">
        <UButton v-if="run.status === 'paused'" size="xs" icon="i-lucide-play" label="Continue" @click="emit('continue')" />
        <UButton v-if="run.status === 'interrupted'" size="xs" icon="i-lucide-play" label="Resume" @click="emit('continue')" />
        <UButton v-if="canRestart" size="xs" variant="soft" icon="i-lucide-rotate-ccw" label="Restart" title="Re-run from the failed step" @click="emit('restart', restartPoint!)" />
        <UButton
          v-if="run.status === 'running' || run.status === 'paused'"
          size="xs" :variant="confirmingStop ? 'solid' : 'ghost'" :color="confirmingStop ? 'error' : 'neutral'"
          :label="confirmingStop ? 'Confirm stop' : 'Stop'" @click="onStop"
        />
        <UButton v-if="settled" size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" label="Clone" @click="emit('clone')" />
        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-panel-right" label="Details" @click="emit('details')" />
      </div>
    </template>
    <template v-else>
      <span class="text-[11px] text-label">
        Last run {{ runs[0].status }}, {{ new Date(runs[0].startedAt).toLocaleString() }}
      </span>
      <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-panel-right" label="Previous runs" class="ml-auto" @click="emit('details')" />
    </template>
  </div>
</template>
