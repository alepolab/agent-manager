<script setup lang="ts">
// The chat runs against the global working directory; the removed terminal
// subsystem used to own this option object.
const { workingDir } = useWorkingDir()
const executionOptions = computed(() => ({ agentSlug: undefined as string | undefined, workingDir: workingDir.value || undefined }))

useHead({
  title: 'Claude Code',
})
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex-1 flex min-h-0 relative overflow-hidden">
      <div class="flex-1 flex flex-col">
        <ChatV2Interface :execution-options="executionOptions" />
      </div>
    </div>
    <!-- Hidden child route outlet — child page has no content, just registers route params -->
    <div class="hidden">
      <NuxtPage />
    </div>
  </div>
</template>
