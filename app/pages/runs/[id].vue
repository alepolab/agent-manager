<script setup lang="ts">
/**
 * A run, full screen: steps and their live output on the left, the evidence
 * bundle on the right. /runs shows the same run beside the list; this is where
 * a developer reads what an agent actually did.
 */
const route = useRoute()
const id = route.params.id as string
// The builder and Clone are pipeline controls; a reviewer opening the run they
// hold a gate on has no use for either, and the API refuses them anyway.
const { can } = useUser()
const detail = ref<{ run: { initialPrompt: string, workflowSlug: string } | null } | null>(null)
const run = computed(() => detail.value?.run ?? null)
useHead({ title: computed(() => `${run.value ? (run.value.initialPrompt.split('\n')[0] ?? '').slice(0, 40) : 'Run'} | Agent Manager`) })
</script>

<template>
  <div class="h-full flex flex-col">
    <PageHeader title="Run">
      <template #leading>
        <UButton to="/runs" icon="i-lucide-arrow-left" size="sm" variant="ghost" color="neutral" aria-label="All runs" />
      </template>
      <template #right>
        <UButton v-if="can('configure')" :to="`/workflows/${run?.workflowSlug ?? ''}?run=${id}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-git-branch" label="Open in builder" :disabled="!run" />
        <UButton v-if="can('runEngine')" :to="`/workflows/${run?.workflowSlug ?? ''}?clone=${id}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-copy" label="Clone" :disabled="!run" />
      </template>
    </PageHeader>
    <div class="flex-1 min-h-0 page page--wide w-full">
      <RunDetail :id="id" ref="detail" />
    </div>
  </div>
</template>
