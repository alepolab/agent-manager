<script setup lang="ts">
/**
 * A run, full screen: the stack of blocks — trigger, steps, gate — each with
 * its own evidence and live output. /runs shows the same stack beside the
 * list; this is where a developer reads what an agent actually did.
 */
const route = useRoute()
const id = route.params.id as string
const runApi = useRun(id)
const { run, logs, error, load, refresh } = runApi
const { onReject, onRework, onNote, onRestart, onStop, onContinue, onRespond } = useRunActionToasts(runApi)
useAutoRefresh(refresh)
// The builder is a pipeline control; a reviewer opening the run they hold a
// gate on has no use for it, and the API refuses it anyway. (Clone is
// RunHeader's "Clone run", gated the same way inside RunStack.)
const { can } = useUser()
onMounted(load)
useHead({ title: computed(() => `${run.value ? (run.value.initialPrompt.split('\n')[0] ?? '').slice(0, 40) : 'Run'} | Agent Manager`) })

/** The prompt's first line, without the ticket key the eyebrow above it already shows. */
const headline = computed(() => {
  const first = run.value?.initialPrompt.split('\n')[0] ?? ''
  const key = run.value?.ticketKey
  return key && first.startsWith(key) ? first.slice(key.length).replace(/^[:\s·-]+/, '') : first
})
</script>

<template>
  <div class="h-full flex flex-col">
    <PageHeader title="Run">
      <template #leading>
        <UButton to="/runs" icon="i-lucide-arrow-left" size="sm" variant="ghost" color="neutral" aria-label="All runs" />
      </template>
      <template #right>
        <UButton v-if="can('configure')" :to="`/workflows/${run?.workflowSlug ?? ''}?run=${id}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-git-branch" label="Open in builder" :disabled="!run" />
      </template>
    </PageHeader>
    <!-- A missing or unreadable run used to render one bare red line of raw API
         text, with no heading and no way back except the browser button. -->
    <div v-if="error" class="page space-y-2">
      <p class="t-head" style="color: var(--text-primary);">This run could not be opened.</p>
      <p class="t-ui text-label">{{ error }}</p>
      <UButton to="/runs" size="sm" variant="soft" icon="i-lucide-arrow-left" label="All runs" />
    </div>
    <div v-else-if="run" class="flex-1 min-h-0 overflow-y-auto page page--wide space-y-5">
      <header class="space-y-1.5">
        <TicketLink v-if="run.ticketKey" :ticket-key="run.ticketKey" class="t-small font-semibold" />
        <h2 class="text-page-title">{{ headline }}</h2>
        <p class="t-small text-label">
          {{ run.workflowName }}{{ run.product ? ` · ${run.product.name}` : '' }}{{ run.startedBy ? ` · started by ${run.startedBy}` : '' }}<template v-if="run.branch"> · <span class="font-mono">{{ run.branch }}</span></template>
        </p>
      </header>
      <RunStack
        :run="run" :logs="logs"
        @continue="onContinue" @respond="onRespond" @reject="onReject" @rework="onRework"
        @note="onNote" @stop="onStop" @restart="onRestart" @clone="navigateTo(`/workflows/${run.workflowSlug}?clone=${id}`)"
      />
    </div>
    <div v-else class="page"><SkeletonCard /></div>
  </div>
</template>
