<script setup lang="ts">
import type { RunStep } from '~~/shared/types/run'
import { statusKind, type StatusKind } from '~/utils/runStatus'

const props = defineProps<{ steps: RunStep[] }>()

/** Colour carries the status visually; this sentence carries it for everyone else. */
const summary = computed(() => {
  // A run with no steps produced an empty aria-label on a role="img", which
  // announces as an unlabelled image rather than as "nothing recorded".
  if (!props.steps.length) return 'No steps recorded for this run'
  const counts: Record<string, number> = {}
  for (const s of props.steps) counts[s.status] = (counts[s.status] ?? 0) + 1
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')
})

/**
 * The pipeline track: the one signature element in the app.
 *
 * Done is quiet grey, not green: on a board of 14-step runs, green on every
 * finished step painted the whole screen as "success" and left nothing to
 * look at. Only three things get colour — now (the accent, with a slow
 * sweep), waiting on a person, and failed.
 */
// The same map StatusLabel reads, so a step's segment and its label never
// disagree. Skipped is settled, so it draws with done.
const SEGMENT: Record<StatusKind, string> = {
  now: 'track__seg--now', wait: 'track__seg--wait', fail: 'track__seg--fail',
  done: 'track__seg--done', skip: 'track__seg--done', idle: '',
}
const segment = (status: string) => SEGMENT[statusKind(status)]
</script>

<template>
  <!-- One segment per step, coloured by that step's own status: a run whose
       third step failed is not "43% done", it is finished, badly. -->
  <div class="track" data-testid="run-progress-bar" role="img" :aria-label="summary">
    <span
      v-for="step in steps"
      :key="`seg-${step.stepId}`"
      class="track__seg"
      :class="segment(step.status)"
      :title="`${step.label}: ${step.status}`"
    />
  </div>
</template>
