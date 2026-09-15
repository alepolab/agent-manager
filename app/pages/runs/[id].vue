<script setup lang="ts">
import { RUN_STATUS_COLOR } from '~/utils/runStatus'

/**
 * A run, full screen: steps and their live output on the left, the evidence
 * bundle on the right. The slide-over in the workflow builder is the quick
 * look; this is where a developer reads what an agent actually did.
 */
const route = useRoute()
const id = route.params.id as string
const { run, logs, error, load, continueRun, stop, restart, respond, sendNote, reject, rework } = useRun(id)
// The builder and Clone are pipeline controls; a reviewer opening the run they
// hold a gate on has no use for either, and the API refuses them anyway.
const { can } = useUser()
async function onReject(note: string) {
  try {
    await reject(note)
    // This toast used to say "Sent back", which described something the route
    // does not do: reject stops the run. Sending back to a step is `onRework`.
    toast.add({ title: 'Run rejected', description: 'The run is stopped and your reason is on the record.', color: 'success' })
  } catch (e: any) { toast.add({ title: 'Could not reject it', description: e.data?.message || e.message, color: 'error' }) }
}
async function onRework(stepId: string, note: string) {
  try {
    await rework(stepId, note)
    const label = run.value?.steps.find(s => s.stepId === stepId)?.label ?? 'that step'
    toast.add({ title: `Sent back to ${label}`, description: 'It restarts with your instruction.', color: 'success' })
  } catch (e: any) { toast.add({ title: 'Could not send it back', description: e.data?.message || e.message, color: 'error' }) }
}
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
        <p v-if="run" class="t-small font-mono text-meta truncate">
          <span :style="{ color: RUN_STATUS_COLOR[run.status] }">{{ run.status }}</span>
          · {{ run.workflowName }}{{ run.product ? ` · ${run.product.name}` : '' }}{{ run.startedBy ? ` · ${run.startedBy}` : '' }}{{ run.branch ? ` · ${run.branch}` : '' }}
        </p>
      </template>
      <template #right>
        <UButton v-if="can('configure')" :to="`/workflows/${run?.workflowSlug ?? ''}?run=${id}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-git-branch" label="Open in builder" :disabled="!run" />
        <UButton v-if="can('runEngine')" :to="`/workflows/${run?.workflowSlug ?? ''}?clone=${id}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-copy" label="Clone" :disabled="!run" />
      </template>
    </PageHeader>
    <div v-if="error" class="page t-small" style="color: var(--error);">{{ error }}</div>
    <!-- Stacks below `lg`. This was a fixed two-column grid at every width — about
         37rem of minimum track before the evidence pane's own 15rem file list was
         counted — so on anything narrower than a laptop the evidence a reviewer is
         meant to be reading was squeezed to nothing and the page scrolled sideways. -->
    <div v-else-if="run" class="flex-1 min-h-0 grid gap-4 page page--wide grid-cols-1 lg:grid-cols-[minmax(22rem,2fr)_minmax(0,3fr)]">
      <div class="min-h-0 overflow-y-auto pr-1">
        <WorkflowRunPanel :run="run" :runs="[run]" :logs="logs" full-page @continue="(n) => continueRun(n)" @respond="respond" @reject="onReject" @rework="onRework" @note="onNote" @stop="stop" @restart="onRestart" @clone="navigateTo(`/workflows/${run.workflowSlug}?clone=${id}`)" />
      </div>
      <RunArtifacts :run-id="id" :live="live" class="min-h-0" />
    </div>
    <div v-else class="page"><SkeletonCard /></div>
  </div>
</template>
