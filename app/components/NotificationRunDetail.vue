<script setup lang="ts">
import { RUN_STATUS_COLOR, runStatusLabel } from '~/utils/runStatus'
import { isWaitingOnAPerson } from '~~/shared/types/run'
import type { NotificationItem } from '~~/shared/types/notification'

/**
 * A run's open gate, decided in place.
 *
 * WorkflowRunPanel already carries everything a gate needs: the question, whose
 * it is, the verdict card, the per-draft review, the earlier decisions and the
 * buttons. This adds what the inbox reader has not seen yet because they did not
 * start the run: what it is for, and the ticket it came from.
 */
const props = defineProps<{ item: Extract<NotificationItem, { kind: 'gate' }> }>()
const emit = defineEmits<{ decided: [] }>()

const runApi = useRun(props.item.runId)
const { run, logs, error, load, continueRun, stop, respond } = runApi
const { onReject, onRework, onNote, onRestart } = useRunActionToasts(runApi)
onMounted(load)

// The run streams over SSE, so a decision taken here — or by someone else,
// anywhere — arrives as a status frame. Moving on is decided by the run leaving
// the gate, not by which button was pressed.
watch(() => run.value?.status, (status, was) => {
  if (was && status && isWaitingOnAPerson(was) && !isWaitingOnAPerson(status)) emit('decided')
})

const ticketOpen = ref(false)
/** The prompt's first line, led by the ticket key unless the line already starts with it. */
const headline = computed(() => {
  const first = (run.value?.initialPrompt.split('\n')[0] ?? '').slice(0, 120)
  const key = run.value?.ticketKey
  return key && !first.startsWith(key) ? `${key} · ${first}` : first
})
</script>

<template>
  <div v-if="error" class="rounded-lg p-4 space-y-2" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
    <p class="t-head" style="color: var(--text-primary);">This run could not be opened.</p>
    <p class="t-ui text-label">{{ error }}</p>
  </div>
  <div v-else-if="run" class="space-y-3">
    <!-- What this run is, for someone who did not start it. -->
    <div class="rounded-lg p-3 space-y-1" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <p class="t-head truncate" style="color: var(--text-primary);">{{ headline }}</p>
          <p class="t-small font-mono text-meta truncate">
            <span :style="{ color: RUN_STATUS_COLOR[run.status] }">{{ runStatusLabel(run.status) }}</span>
            · {{ run.workflowName }}{{ run.product ? ` · ${run.product.name}` : '' }}{{ run.startedBy ? ` · started by ${run.startedBy}` : '' }}{{ run.branch ? ` · ${run.branch}` : '' }}
          </p>
        </div>
        <UButton :to="`/runs/${run.id}`" size="xs" variant="ghost" color="neutral" trailing-icon="i-lucide-arrow-right" label="Full run and evidence" class="shrink-0" />
      </div>
      <!-- The ticket text the run was started with. Collapsed: it is the
           background to the decision, not the decision. -->
      <button
        v-if="run.initialPrompt.includes('\n')"
        class="t-small text-label flex items-center gap-1 focus-ring"
        :aria-expanded="ticketOpen"
        @click="ticketOpen = !ticketOpen"
      >
        <UIcon :name="ticketOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3" />
        {{ ticketOpen ? 'Hide' : 'Show' }} what this run was asked to do
      </button>
      <pre v-if="ticketOpen" class="t-small whitespace-pre-wrap rounded p-2 max-h-80 overflow-y-auto" style="background: var(--surface-base); color: var(--text-secondary);">{{ run.initialPrompt }}</pre>
    </div>

    <WorkflowRunPanel
      :run="run" :runs="[run]" :logs="logs" full-page
      @continue="(n) => continueRun(n)" @respond="respond" @reject="onReject" @rework="onRework"
      @note="onNote" @stop="stop" @restart="onRestart" @clone="navigateTo(`/workflows/${run.workflowSlug}?clone=${run.id}`)"
    />
  </div>
  <SkeletonCard v-else />
</template>
