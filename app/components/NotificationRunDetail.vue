<script setup lang="ts">
import { isWaitingOnAPerson } from '~~/shared/types/run'
import type { NotificationItem } from '~~/shared/types/notification'

/**
 * A run's open gate, decided in place. GateDecision lays the decision out on
 * its own; the whole run - its stack, logs and evidence - is one link away.
 */
const props = defineProps<{ item: Extract<NotificationItem, { kind: 'gate' }> }>()
const emit = defineEmits<{ decided: [] }>()

const runApi = useRun(props.item.runId)
const { run, error, load } = runApi
const { onReject, onRework, onContinue, onRespond, onStop } = useRunActionToasts(runApi)
onMounted(load)

// The run streams over SSE, so a decision taken here — or by someone else,
// anywhere — arrives as a status frame. Moving on is decided by the run leaving
// the gate, not by which button was pressed.
watch(() => run.value?.status, (status, was) => {
  if (was && status && isWaitingOnAPerson(was) && !isWaitingOnAPerson(status)) emit('decided')
})
</script>

<template>
  <div v-if="error" class="group-card space-y-2">
    <p class="t-head" style="color: var(--text-primary);">This run could not be opened.</p>
    <p class="t-ui text-label">{{ error }}</p>
  </div>
  <GateDecision
    v-else-if="run" :run="run" class="flex-1"
    @continue="onContinue" @respond="onRespond" @reject="onReject" @rework="onRework" @stop="onStop"
  />
  <SkeletonCard v-else />
</template>
