<script setup lang="ts">
/**
 * Says why the controls that belong here are not on the screen.
 *
 * A control you were shown and then refused reads as a bug; a control that
 * silently is not there reads as a worse one. This is the span that already
 * sat inline in workflows/[slug].vue, promoted so every gated page can say the
 * same thing the same way.
 */
defineProps<{ reason: string }>()
</script>

<template>
  <span class="t-small text-label whitespace-nowrap">Read-only - {{ reason }} is an operator's job.</span>
</template>
