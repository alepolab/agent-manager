<script setup lang="ts">
defineEmits<{ reload: [], keep: [] }>()
</script>

<template>
  <div
    class="rounded-xl px-4 py-3 flex items-center gap-3"
    style="background: rgba(245, 158, 11, 0.06); border: 1px solid rgba(245, 158, 11, 0.14);"
  >
    <UIcon name="i-lucide-file-warning" class="size-4 shrink-0" style="color: var(--warning);" />
    <span class="text-[12px] flex-1" style="color: var(--text-secondary);">
      This was changed elsewhere while you were editing.
    </span>
    <button class="text-[12px] font-medium px-2 py-1 rounded hover-bg" style="color: var(--warning);" @click="$emit('reload')">Reload theirs</button>
    <button class="text-[12px] px-2 py-1 rounded hover-bg text-meta" title="Your next save overwrites their version" @click="$emit('keep')">Keep mine</button>
  </div>
</template>
