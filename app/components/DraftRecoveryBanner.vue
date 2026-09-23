<script setup lang="ts">
defineProps<{ age: string }>()
defineEmits<{ restore: [], dismiss: [] }>()
</script>

<template>
  <div
    class="rounded-xl px-4 py-3 flex items-center gap-3"
    style="background: rgba(59, 130, 246, 0.06); border: 1px solid rgba(59, 130, 246, 0.12);"
  >
    <UIcon name="i-lucide-archive-restore" class="size-4 shrink-0" style="color: var(--info, #3b82f6);" />
    <span class="t-small flex-1" style="color: var(--text-secondary);">
      You have an unsaved draft from {{ age }}.
    </span>
    <button class="t-small font-medium px-2 py-1 rounded hover-bg" style="color: var(--info, #3b82f6);" @click="$emit('restore')">Restore</button>
    <button class="t-small px-2 py-1 rounded hover-bg text-meta" @click="$emit('dismiss')">Dismiss</button>
  </div>
</template>
