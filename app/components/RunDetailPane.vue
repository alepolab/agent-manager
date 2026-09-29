<script setup lang="ts">
/** The selected run on /runs: the same stack as /runs/:id, keyed by id so switching runs re-subscribes. */
const props = defineProps<{ id: string }>()
const emit = defineEmits<{ changed: [] }>()
const runApi = useRun(props.id)
const { run, logs, error, load, refresh } = runApi
const { onReject, onRework, onNote, onRestart, onStop, onContinue, onRespond } = useRunActionToasts(runApi)
onMounted(load)
watch(() => run.value?.status, (s, was) => { if (was && s !== was) emit('changed') })
useAutoRefresh(refresh)
</script>

<template>
  <p v-if="error" class="t-ui text-label">{{ error }}</p>
  <RunStack
    v-else-if="run" :run="run" :logs="logs"
    @continue="onContinue" @respond="onRespond" @reject="onReject" @rework="onRework"
    @note="onNote" @stop="onStop" @restart="onRestart" @clone="navigateTo(`/workflows/${run.workflowSlug}?clone=${id}`)"
  />
  <SkeletonCard v-else />
</template>
