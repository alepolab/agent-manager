<script setup lang="ts">
import type { RunStep } from '~~/shared/types/run'
import { RUN_STATUS_COLOR } from '~/utils/runStatus'

const props = defineProps<{ steps: RunStep[] }>()

/** Colour carries the status visually; this sentence carries it for everyone else. */
const summary = computed(() => {
  const counts: Record<string, number> = {}
  for (const s of props.steps) counts[s.status] = (counts[s.status] ?? 0) + 1
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')
})
</script>

<template>
  <!-- One segment per step, coloured by that step's own status: a run whose
       third step failed is not "43% done", it is finished, badly. -->
  <div class="flex gap-0.5" data-testid="run-progress-bar" role="img" :aria-label="summary">
    <span
      v-for="step in steps"
      :key="`seg-${step.stepId}`"
      class="h-1 flex-1 rounded-sm"
      :style="{ background: RUN_STATUS_COLOR[step.status] }"
      :title="`${step.label}: ${step.status}`"
    />
  </div>
</template>
