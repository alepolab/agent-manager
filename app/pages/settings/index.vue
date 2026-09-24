<script setup lang="ts">
/** Bare /settings is not a page of its own: send it to the first tab. */
await navigateTo('/settings/pipeline', { replace: true })
</script>

<template>
  <div />
</template>
