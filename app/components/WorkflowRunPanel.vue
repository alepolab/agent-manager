<script setup lang="ts">
import type { WorkflowRun, RunCostSummary } from '~~/shared/types/run'

const props = defineProps<{ run: WorkflowRun | null, runs: WorkflowRun[] }>()
const emit = defineEmits<{ continue: [], stop: [], attach: [id: string], close: [] }>()

// Colours and duration formatting live in app/utils/runStatus.ts so this panel
// and the /runs history page cannot drift apart.
const STATUS_COLOR = RUN_STATUS_COLOR
const elapsed = elapsedLabel
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

// Cost is fetched separately from the run record itself (GET /api/runs/[id]/cost,
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
const money = (n: number) => `$${n.toFixed(4)}`
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

    <!-- One honest number: the run's cost so far, from server/utils/costReport.ts.
         Never fabricated - a step that hasn't reported usage, or ran on a model
         with no pricing entry, makes this a stated PARTIAL total, not a silent
         one. See RunCostSummary's `note` (title on the badge) for the caveats. -->
    <div v-if="cost" class="flex items-center gap-2 text-[11px]" data-testid="run-cost-summary">
      <span class="font-mono tabular-nums" style="color: var(--text-primary);" :title="cost.note">
        {{ money(cost.totals.cost_usd) }}
      </span>
      <span class="text-label">{{ (cost.totals.input_tokens + cost.totals.output_tokens).toLocaleString() }} tokens</span>
      <span
        v-if="!cost.totals.complete"
        class="text-[10px] px-1.5 py-0.5 rounded"
        :style="{ color: STATUS_COLOR.failed, background: 'rgba(239, 68, 68, 0.1)' }"
        :title="`${cost.totals.unmeasured_step_count} step(s) with no observed usage, ${cost.totals.unpriced_step_count} on an unpriced model - excluded from this total`"
      >
        partial: {{ cost.totals.unmeasured_step_count + cost.totals.unpriced_step_count }} step(s) excluded
      </span>
    </div>
    <p v-else-if="costError" class="text-[11px] text-label">Cost unavailable.</p>

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
    <div class="flex items-center gap-2">
      <p class="text-[11px] text-label">Previous runs</p>
      <NuxtLink to="/runs" class="ml-auto text-[11px] text-label hover:underline">All run history &rarr;</NuxtLink>
    </div>
    <button v-for="r in runs.slice(0, 10)" :key="r.id" class="w-full flex items-center gap-2 text-[12px] py-1 text-left" @click="emit('attach', r.id)">
      <span class="w-2 h-2 rounded-full" :style="{ background: STATUS_COLOR[r.status] }" />
      <span>{{ new Date(r.startedAt).toLocaleString() }}</span>
      <span class="text-[10px] text-label">{{ elapsed({ startedAt: r.startedAt, completedAt: r.endedAt }) }}</span>
      <span class="ml-auto text-[10px] font-mono text-label">{{ r.status }}</span>
    </button>
    <p v-if="runs.length > 10" class="text-[11px] text-label pt-1">
      Showing 10 of {{ runs.length }}. <NuxtLink to="/runs" class="hover:underline">See all</NuxtLink>.
    </p>
  </div>
</template>
