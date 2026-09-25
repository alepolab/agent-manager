<script setup lang="ts">
/** The selected run on /runs: the same stack as /runs/:id, keyed by id so switching runs re-subscribes. */
const props = defineProps<{ id: string }>()
const emit = defineEmits<{ changed: [] }>()
const runApi = useRun(props.id)
const { run, logs, error, load, continueRun, stop, respond } = runApi
const { onReject, onRework, onNote, onRestart } = useRunActionToasts(runApi)
onMounted(load)
watch(() => run.value?.status, (s, was) => { if (was && s !== was) emit('changed') })

// useRun's stop() has no try/catch of its own - an unwrapped @stop left a
// failed stop with no visible feedback at all.
const toast = useToast()
async function handleStop() {
  try { await stop() } catch (e: any) { toast.add({ title: 'Failed to stop', description: e.data?.message || e.message, color: 'error' }) }
}
</script>

<template>
  <p v-if="error" class="t-ui text-label">{{ error }}</p>
  <RunStack
    v-else-if="run" :run="run" :logs="logs"
    @continue="(n) => continueRun(n)" @respond="respond" @reject="onReject" @rework="onRework"
    @note="onNote" @stop="handleStop" @restart="onRestart" @clone="navigateTo(`/workflows/${run.workflowSlug}?clone=${id}`)"
  />
  <SkeletonCard v-else />
</template>
