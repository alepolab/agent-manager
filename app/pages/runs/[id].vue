<script setup lang="ts">
import { RUN_STATUS_COLOR, runStatusLabel } from '~/utils/runStatus'
import { isLiveStatus } from '~~/shared/types/run'

/**
 * A run, full screen: steps and their live output on the left, the evidence
 * bundle on the right. The slide-over in the workflow builder is the quick
 * look; this is where a developer reads what an agent actually did.
 */
const route = useRoute()
const id = route.params.id as string
const runApi = useRun(id)
const { run, logs, error, load, refresh, continueRun, stop, respond } = runApi
const { onReject, onRework, onNote, onRestart } = useRunActionToasts(runApi)
useAutoRefresh(refresh)
// The builder and Clone are pipeline controls; a reviewer opening the run they
// hold a gate on has no use for either, and the API refuses them anyway.
const { can } = useUser()
onMounted(load)
useHead({ title: computed(() => `${run.value ? (run.value.initialPrompt.split('\n')[0] ?? '').slice(0, 40) : 'Run'} | Agent Manager`) })
const live = computed(() => !!run.value && isLiveStatus(run.value.status))
</script>

<template>
  <div class="h-full flex flex-col">
    <PageHeader :title="run ? (run.initialPrompt.split('\n')[0] ?? '').slice(0, 80) : 'Run'">
      <template #leading>
        <UButton to="/runs" icon="i-lucide-arrow-left" size="sm" variant="ghost" color="neutral" aria-label="All runs" />
      </template>
      <template #subtitle>
        <p v-if="run" class="t-small font-mono text-meta truncate">
          <span :style="{ color: RUN_STATUS_COLOR[run.status] }">{{ runStatusLabel(run.status) }}</span>
          · {{ run.workflowName }}{{ run.product ? ` · ${run.product.name}` : '' }}{{ run.startedBy ? ` · ${run.startedBy}` : '' }}{{ run.branch ? ` · ${run.branch}` : '' }}
        </p>
      </template>
      <template #right>
        <UButton v-if="can('configure')" :to="`/workflows/${run?.workflowSlug ?? ''}?run=${id}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-git-branch" label="Open in builder" :disabled="!run" />
        <UButton v-if="can('runEngine')" :to="`/workflows/${run?.workflowSlug ?? ''}?clone=${id}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-copy" label="Clone" :disabled="!run" />
      </template>
    </PageHeader>
    <!-- A missing or unreadable run used to render one bare red line of raw API
         text, with no heading and no way back except the browser button. -->
    <div v-if="error" class="page space-y-2">
      <p class="t-head" style="color: var(--text-primary);">This run could not be opened.</p>
      <p class="t-ui text-label">{{ error }}</p>
      <UButton to="/runs" size="sm" variant="soft" icon="i-lucide-arrow-left" label="All runs" />
    </div>
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
