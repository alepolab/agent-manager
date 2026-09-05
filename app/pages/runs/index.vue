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

/** Refetch cadence while anything is still running. The list is small and
 *  served from disk, so this is cheap; the alternative - one SSE stream per
 *  visible run - buys sub-second updates nobody reading a history page needs. */
const LIVE_POLL_MS = 3000
let pollTimer: ReturnType<typeof setInterval> | null = null

async function load(quiet = false) {
  if (!quiet) loading.value = true
  error.value = null
  try {
    runs.value = await $fetch<WorkflowRun[]>('/api/runs')
  } catch (e: unknown) {
    // A failed background refresh must not blank a list that is already on
    // screen: keep showing the last good data and surface the error instead.
    error.value = e instanceof Error ? e.message : 'Could not load run history.'
  } finally {
    loading.value = false
  }
}

const anyLive = computed(() => runs.value.some(r => r.status === 'running' || r.status === 'paused'))

/** Poll only while something is actually live, and stop as soon as nothing
 *  is. A history page left open overnight should not sit refetching for ever. */
function syncPolling() {
  if (anyLive.value && !pollTimer) {
    pollTimer = setInterval(() => load(true), LIVE_POLL_MS)
  } else if (!anyLive.value && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
watch(anyLive, syncPolling)
onMounted(async () => { await load(); syncPolling() })
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

/** The run the expanded row is showing, re-read from `runs` on every refresh
 *  so the detail updates in place rather than freezing at the moment it was
 *  opened. */
const expandedRun = computed(() => runs.value.find(r => r.id === expanded.value) ?? null)

async function stopRun(id: string) {
  try { await $fetch(`/api/runs/${id}/stop`, { method: 'POST' }); await load(true) } catch { /* surfaced by the next poll */ }
}
async function continueRun(id: string) {
  try { await $fetch(`/api/runs/${id}/continue`, { method: 'POST' }); await load(true) } catch { /* surfaced by the next poll */ }
}

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
        <UButton label="Refresh" icon="i-lucide-refresh-cw" size="sm" variant="ghost" color="neutral" @click="() => load()" />
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

            <!-- The SAME component the workflow page uses, not a second
                 rendering of the same data. Reusing it is what makes the two
                 views agree by construction: per-step rows, expandable output,
                 monitor verdicts, the cost summary and the run controls all
                 come from one place, so a change to any of them cannot land in
                 one view and miss the other. -->
            <div v-if="expandedRun && expanded === run.id" class="border-t border-subtle px-4 py-3 space-y-2">
              <div class="flex items-center gap-3 text-[11px] text-label">
                <span class="font-mono">{{ run.id }}</span>
                <NuxtLink :to="`/workflows/${run.workflowSlug}`" class="hover:underline" style="color: var(--info);">
                  Open workflow &rarr;
                </NuxtLink>
              </div>
              <WorkflowRunPanel
                :run="expandedRun"
                :runs="[]"
                @stop="stopRun(run.id)"
                @continue="continueRun(run.id)"
              />
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
