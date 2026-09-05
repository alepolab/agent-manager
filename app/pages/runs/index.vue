<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'

/**
 * Every workflow run, across every workflow, newest first.
 *
 * Runs were previously reachable only from the workflow that produced them,
 * which meant a run started headlessly (scripts/run-ticket.mjs) or by a watch
 * had nowhere to be seen unless you already knew which workflow to open.
 */
const runs = ref<WorkflowRun[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const expanded = ref<string | null>(null)
const statusFilter = ref<string>('all')

async function load() {
  loading.value = true
  error.value = null
  try {
    runs.value = await $fetch<WorkflowRun[]>('/api/runs')
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Could not load run history.'
  } finally {
    loading.value = false
  }
}
onMounted(load)

// Counts come from the unfiltered list so the tab labels stay stable while a
// filter is applied - a filter that renumbers its own tabs is disorienting.
const counts = computed(() => {
  const c: Record<string, number> = { all: runs.value.length }
  for (const r of runs.value) c[r.status] = (c[r.status] ?? 0) + 1
  return c
})

const FILTERS = ['all', 'running', 'completed', 'failed', 'stopped', 'interrupted', 'paused']
const visibleFilters = computed(() => FILTERS.filter(f => f === 'all' || counts.value[f]))

const filtered = computed(() =>
  statusFilter.value === 'all' ? runs.value : runs.value.filter(r => r.status === statusFilter.value))

/** Settled step count, not a percentage - see WorkflowRunPanel's `progress`
 *  comment for why a run that failed at step 3 of 7 is not "43% done". */
function settledCount(run: WorkflowRun) {
  return run.steps.filter(s => SETTLED_STATUSES.has(s.status)).length
}

/** The step that explains the run: the one that failed, else the last one to
 *  have started. A history row is only useful if it says where things got to. */
function furthestStep(run: WorkflowRun) {
  return run.steps.find(s => s.status === 'failed')
    ?? [...run.steps].reverse().find(s => s.startedAt)
    ?? null
}
</script>

<template>
  <div>
    <PageHeader title="Run History">
      <template #trailing>
        <span class="text-[12px] text-meta">{{ runs.length }}</span>
      </template>
      <template #right>
        <UButton label="Refresh" icon="i-lucide-refresh-cw" size="sm" variant="ghost" color="neutral" @click="load" />
      </template>
    </PageHeader>

    <div class="px-6 py-4">
      <p class="text-[13px] mb-4 leading-relaxed text-label">
        Every workflow run on this machine, newest first — including runs started from the
        command line or by a watch, which have no other home in the UI.
      </p>

      <div
        v-if="error"
        class="rounded-xl px-4 py-3 mb-4 flex items-start gap-3"
        style="background: rgba(248, 113, 113, 0.06); border: 1px solid rgba(248, 113, 113, 0.12);"
      >
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0 mt-0.5" style="color: var(--error);" />
        <span class="text-[12px]" style="color: var(--error);">{{ error }}</span>
      </div>

      <div v-if="loading" class="space-y-3">
        <SkeletonCard v-for="i in 4" :key="i" />
      </div>

      <div v-else-if="!runs.length" class="flex flex-col items-center justify-center py-16 space-y-3">
        <UIcon name="i-lucide-history" class="size-8 text-meta" />
        <p class="text-[13px] text-label">No runs yet.</p>
        <NuxtLink to="/workflows" class="text-[12px] hover:underline" style="color: var(--info);">Go to workflows</NuxtLink>
      </div>

      <template v-else>
        <div class="flex flex-wrap gap-1 mb-4">
          <button
            v-for="f in visibleFilters"
            :key="f"
            class="text-[11px] px-2.5 py-1 rounded-md border"
            :class="statusFilter === f ? 'border-subtle bg-card' : 'border-transparent'"
            :style="statusFilter === f ? 'color: var(--text-primary);' : ''"
            @click="statusFilter = f"
          >
            <span v-if="f !== 'all'" class="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle" :style="{ background: runStatusColor(f) }" />
            <span class="capitalize">{{ f }}</span>
            <span class="text-meta ml-1 tabular-nums">{{ counts[f] ?? 0 }}</span>
          </button>
        </div>

        <div class="space-y-2">
          <div v-for="run in filtered" :key="run.id" data-testid="run-history-row" class="rounded-lg bg-card border border-subtle overflow-hidden">
            <button
              class="w-full flex items-center gap-3 px-4 py-3 text-left"
              @click="expanded = expanded === run.id ? null : run.id"
            >
              <span class="w-2 h-2 rounded-full shrink-0" :style="{ background: runStatusColor(run.status) }" />
              <span class="text-[13px] font-medium truncate">{{ run.workflowName }}</span>
              <span class="text-[11px] font-mono uppercase shrink-0" :style="{ color: runStatusColor(run.status) }">{{ run.status }}</span>

              <span class="ml-auto flex items-center gap-3 shrink-0">
                <span class="text-[11px] text-label tabular-nums" data-testid="run-history-count">{{ settledCount(run) }} / {{ run.steps.length }}</span>
                <span class="text-[11px] text-label tabular-nums">{{ elapsedLabel({ startedAt: run.startedAt, completedAt: run.endedAt }) }}</span>
                <span class="text-[11px] text-meta">{{ new Date(run.startedAt).toLocaleString() }}</span>
              </span>
            </button>

            <!-- One segment per step, coloured by that step's own status. -->
            <div class="flex gap-0.5 px-4 pb-2" data-testid="run-history-bar">
              <span
                v-for="step in run.steps"
                :key="`seg-${run.id}-${step.stepId}`"
                class="h-1 flex-1 rounded-sm"
                :style="{ background: runStatusColor(step.status) }"
                :title="`${step.label}: ${step.status}`"
              />
            </div>

            <p v-if="furthestStep(run)" class="px-4 pb-3 text-[11px] text-label truncate">
              {{ furthestStep(run)!.status === 'failed' ? 'Failed at' : 'Reached' }}:
              <span class="font-medium">{{ furthestStep(run)!.label }}</span>
              <span v-if="furthestStep(run)!.error" :style="{ color: runStatusColor('failed') }"> — {{ furthestStep(run)!.error }}</span>
            </p>

            <div v-if="expanded === run.id" class="border-t border-subtle px-4 py-3 space-y-2">
              <div class="flex items-center gap-3 text-[11px] text-label">
                <span class="font-mono">{{ run.id }}</span>
                <NuxtLink :to="`/workflows/${run.workflowSlug}`" class="hover:underline" style="color: var(--info);">
                  Open workflow &rarr;
                </NuxtLink>
              </div>
              <div v-for="step in run.steps" :key="step.stepId" class="flex items-center gap-2 text-[12px]">
                <span class="w-2 h-2 rounded-full shrink-0" :style="{ background: runStatusColor(step.status) }" />
                <span>{{ step.label }}</span>
                <span class="text-label font-mono text-[10px]">{{ step.agentSlug }}</span>
                <span v-if="step.visits > 1" class="text-[10px] text-label">&times;{{ step.visits }}</span>
                <span v-if="step.monitorVerdict" class="text-[10px] font-mono">{{ step.monitorVerdict }}</span>
                <span class="ml-auto text-[10px] text-label tabular-nums">{{ elapsedLabel(step) }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
