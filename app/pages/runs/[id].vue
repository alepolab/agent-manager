<script setup lang="ts">
import { RUN_STATUS_COLOR } from '~/utils/runStatus'

/**
 * A run, full screen: steps and their live output on the left, the evidence
 * bundle on the right. The slide-over in the workflow builder is the quick
 * look; this is where a developer reads what an agent actually did.
 */
const route = useRoute()
const id = route.params.id as string
const { run, logs, error, load, continueRun, stop, restart, respond, sendNote } = useRun(id)
async function onNote(text: string) {
  try {
    const r = await sendNote(text)
    toast.add({ title: r.delivered?.length ? `Sent to ${r.delivered.join(', ')}` : 'Note queued for the next step', color: 'success' })
  } catch (e: any) { toast.add({ title: 'Could not send the note', description: e.data?.message || e.message, color: 'error' }) }
}
const toast = useToast()
onMounted(load)
useHead({ title: computed(() => `${run.value ? (run.value.initialPrompt.split('\n')[0] ?? '').slice(0, 40) : 'Run'} | Agent Manager`) })
const live = computed(() => !!run.value && (run.value.status === 'running' || run.value.status === 'paused'))
async function onRestart(stepId: string, note?: string) {
  try { await restart(stepId, note) } catch (e: any) { toast.add({ title: 'Could not restart', description: e.data?.message || e.message, color: 'error' }) }
}
</script>

<template>
  <div class="h-full flex flex-col">
    <PageHeader :title="run ? (run.initialPrompt.split('\n')[0] ?? '').slice(0, 80) : 'Run'">
      <template #leading>
        <UButton to="/runs" icon="i-lucide-arrow-left" size="sm" variant="ghost" color="neutral" aria-label="All runs" />
      </template>
      <template #subtitle>
        <p v-if="run" class="text-[11px] font-mono text-meta truncate">
          <span :style="{ color: RUN_STATUS_COLOR[run.status] }">{{ run.status }}</span>
          · {{ run.workflowName }}{{ run.product ? ` · ${run.product.name}` : '' }}{{ run.startedBy ? ` · ${run.startedBy}` : '' }}{{ run.branch ? ` · ${run.branch}` : '' }}{{ run.usage ? ` · $${run.usage.usd.toFixed(2)}` : '' }}
        </p>
      </template>
      <template #right>
        <UButton :to="`/workflows/${run?.workflowSlug ?? ''}?run=${id}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-git-branch" label="Open in builder" :disabled="!run" />
        <UButton :to="`/workflows/${run?.workflowSlug ?? ''}?clone=${id}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-copy" label="Clone" :disabled="!run" />
      </template>
    </PageHeader>
    <div v-if="error" class="px-6 py-4 text-[12px]" style="color: var(--error);">{{ error }}</div>
    <div v-else-if="run" class="flex-1 min-h-0 grid gap-4 px-6 py-4" style="grid-template-columns: minmax(22rem, 2fr) minmax(0, 3fr);">
      <div class="min-h-0 overflow-y-auto pr-1">
        <WorkflowRunPanel :run="run" :runs="[run]" :logs="logs" full-page @continue="(n) => continueRun(n)" @respond="respond" @note="onNote" @stop="stop" @restart="onRestart" @clone="navigateTo(`/workflows/${run.workflowSlug}?clone=${id}`)" />
      </div>
      <RunArtifacts :run-id="id" :live="live" class="min-h-0" />
    </div>
    <div v-else class="px-6 py-4"><SkeletonCard /></div>
  </div>
</template>
