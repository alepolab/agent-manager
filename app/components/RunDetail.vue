<script setup lang="ts">
import { isLiveStatus } from '~~/shared/types/run'

/**
 * One run, read as a page: its head, its steps, and (when there is room) the
 * evidence bundle beside them. Rendered full screen at /runs/[id] and in the
 * right pane of /runs, so a run reads the same wherever it is opened.
 */
const props = defineProps<{
  id: string
  /** In the /runs split view there is no room for a third column: evidence is one click away on the full page. */
  compact?: boolean
}>()

const runApi = useRun(props.id)
const { run, logs, error, load, refresh, continueRun, stop, respond } = runApi
const { onReject, onRework, onNote, onRestart } = useRunActionToasts(runApi)
useAutoRefresh(refresh)
onMounted(load)
const live = computed(() => !!run.value && isLiveStatus(run.value.status))

/** The prompt's first line, without the ticket key the eyebrow above it already shows. */
const headline = computed(() => {
  const first = run.value?.initialPrompt.split('\n')[0] ?? ''
  const key = run.value?.ticketKey
  return key && first.startsWith(key) ? first.slice(key.length).replace(/^[:\s·-]+/, '') : first
})
defineExpose({ run })
</script>

<template>
  <!-- A missing or unreadable run used to render one bare red line of raw API
       text, with no heading and no way back except the browser button. -->
  <div v-if="error" class="space-y-2">
    <p class="t-head" style="color: var(--text-primary);">This run could not be opened.</p>
    <p class="t-ui text-label">{{ error }}</p>
    <UButton to="/runs" size="sm" variant="soft" icon="i-lucide-arrow-left" label="All runs" />
  </div>
  <!-- Stacks below `lg` on the full page: the evidence pane has a 15rem file
       list of its own, and a fixed two-column grid squeezed it to nothing. -->
  <div
    v-else-if="run"
    class="grid gap-6"
    :class="compact ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-[minmax(22rem,2fr)_minmax(0,3fr)] h-full min-h-0'"
  >
    <div :class="compact ? '' : 'min-h-0 overflow-y-auto pr-1'" class="space-y-5">
      <header class="space-y-1.5">
        <span v-if="run.ticketKey" class="t-small font-mono text-label">{{ run.ticketKey }}</span>
        <h2 class="text-page-title">{{ headline }}</h2>
        <p class="t-small text-label">
          {{ run.workflowName }}{{ run.product ? ` · ${run.product.name}` : '' }}{{ run.startedBy ? ` · started by ${run.startedBy}` : '' }}<template v-if="run.branch"> · <span class="font-mono">{{ run.branch }}</span></template>
        </p>
      </header>
      <WorkflowRunPanel
        :run="run" :runs="[run]" :logs="logs" full-page
        @continue="(n) => continueRun(n)" @respond="respond" @reject="onReject" @rework="onRework"
        @note="onNote" @stop="stop" @restart="onRestart" @clone="navigateTo(`/workflows/${run.workflowSlug}?clone=${id}`)"
      />
    </div>
    <RunArtifacts v-if="!compact" :run-id="id" :live="live" class="min-h-0" />
  </div>
  <SkeletonCard v-else />
</template>
