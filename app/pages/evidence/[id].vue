<script setup lang="ts">
/**
 * One run's evidence on a page of its own, opened on the file a link names
 * (`?file=`). A gate's "Reports" links used to open the raw file in a new
 * tab: markdown as source text, which nobody deciding a gate should have to
 * read. The same viewer as the run's Evidence drawer; the raw file is still
 * one click away from it.
 */
const route = useRoute()
const id = route.params.id as string
const file = computed(() => (typeof route.query.file === 'string' ? route.query.file : undefined))
const runApi = useRun(id)
const { run, error, load } = runApi
onMounted(load)
useHead({ title: computed(() => `${file.value ?? 'Evidence'}${run.value?.ticketKey ? ` · ${run.value.ticketKey}` : ''} | Agent Manager`) })
</script>

<template>
  <div class="h-full flex flex-col">
    <PageHeader title="Evidence">
      <template #leading>
        <UButton :to="`/runs/${id}`" icon="i-lucide-arrow-left" size="sm" variant="ghost" color="neutral" aria-label="The run" />
      </template>
      <template #right>
        <UButton :to="`/runs/${id}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-list-tree" label="Full run" />
      </template>
    </PageHeader>
    <div v-if="error" class="page space-y-2">
      <p class="t-head" style="color: var(--text-primary);">This run could not be opened.</p>
      <p class="t-ui text-label">{{ error }}</p>
    </div>
    <div v-else class="flex-1 min-h-0 page page--wide flex flex-col gap-3">
      <header v-if="run" class="space-y-1">
        <TicketLink v-if="run.ticketKey" :ticket-key="run.ticketKey" class="t-small font-semibold" />
        <p class="t-small text-label m-0">{{ run.workflowName }}<template v-if="run.branch"> · <span class="font-mono">{{ run.branch }}</span></template></p>
      </header>
      <div class="flex-1 min-h-0">
        <RunArtifacts :run-id="id" :initial="file" />
      </div>
    </div>
  </div>
</template>
