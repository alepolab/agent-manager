<script setup lang="ts">
import { isWaitingOnAPerson } from '~~/shared/types/run'
import type { NotificationItem } from '~~/shared/types/notification'

/**
 * A run's open gate, decided in place.
 *
 * RunStack already carries everything a gate needs: the question, whose
 * it is, the verdict card, the per-draft review, the earlier decisions and the
 * buttons. This adds what the inbox reader has not seen yet because they did not
 * start the run: what it is for, and the ticket it came from.
 */
const props = defineProps<{ item: Extract<NotificationItem, { kind: 'gate' }> }>()
const emit = defineEmits<{ decided: [] }>()

const runApi = useRun(props.item.runId)
const { run, logs, error, load } = runApi
const { onReject, onRework, onNote, onRestart, onStop, onContinue, onRespond } = useRunActionToasts(runApi)
onMounted(load)

// The run streams over SSE, so a decision taken here — or by someone else,
// anywhere — arrives as a status frame. Moving on is decided by the run leaving
// the gate, not by which button was pressed.
watch(() => run.value?.status, (status, was) => {
  if (was && status && isWaitingOnAPerson(was) && !isWaitingOnAPerson(status)) emit('decided')
})

/** The prompt's first line, without the ticket key the eyebrow above it already shows. */
const headline = computed(() => {
  const first = run.value?.initialPrompt.split('\n')[0] ?? ''
  const key = run.value?.ticketKey
  return key && first.startsWith(key) ? first.slice(key.length).replace(/^[:\s·-]+/, '') : first
})
</script>

<template>
  <div v-if="error" class="group-card space-y-2">
    <p class="t-head" style="color: var(--text-primary);">This run could not be opened.</p>
    <p class="t-ui text-label">{{ error }}</p>
  </div>
  <div v-else-if="run" class="space-y-5">
    <!-- What this run is, for someone who did not start it: set as the head of
         a page, not boxed as one more card among the cards below it. -->
    <header class="space-y-1.5">
      <div class="flex items-center gap-3">
        <span v-if="run.ticketKey" class="t-small font-mono text-label">{{ run.ticketKey }}</span>
        <StatusLabel :status="run.status" />
        <UButton :to="`/runs/${run.id}${run.question?.stepId ? `#step-${run.question.stepId}` : ''}`" size="xs" variant="ghost" color="neutral" trailing-icon="i-lucide-arrow-right" label="Full run and evidence" class="ml-auto shrink-0" />
      </div>
      <h2 class="text-page-title">{{ headline }}</h2>
      <p class="t-small text-label">
        {{ run.workflowName }}{{ run.product ? ` · ${run.product.name}` : '' }}{{ run.startedBy ? ` · started by ${run.startedBy}` : '' }}<template v-if="run.branch"> · <span class="font-mono">{{ run.branch }}</span></template>
      </p>
      <!-- The ticket text the run was started with. Collapsed: it is the
           background to the decision, not the decision. -->
      <details v-if="run.initialPrompt.includes('\n')" class="group-details pt-1">
        <summary class="group-head cursor-pointer focus-ring t-small" style="margin: 0;"><span class="t-small text-label">What this run was asked to do</span></summary>
        <pre class="t-small whitespace-pre-wrap group-card mt-2 max-h-80 overflow-y-auto" style="color: var(--text-secondary); font-family: var(--font-sans);">{{ run.initialPrompt }}</pre>
      </details>
    </header>

    <RunStack
      :run="run" :logs="logs"
      @continue="onContinue" @respond="onRespond" @reject="onReject" @rework="onRework"
      @note="onNote" @stop="onStop" @restart="onRestart" @clone="navigateTo(`/workflows/${run.workflowSlug}?clone=${run.id}`)"
    />
  </div>
  <SkeletonCard v-else />
</template>
