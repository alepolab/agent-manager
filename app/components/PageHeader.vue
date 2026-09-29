<script setup lang="ts">
const props = defineProps<{
  title: string
  subtitle?: string
}>()
useHead({ title: computed(() => `${props.title} | Agent Manager`) })
</script>

<template>
  <!-- A toolbar, not a masthead: title, the section's tabs, then actions, in
       one 52px row. The old header stacked a 26px display title over a mono
       subtitle and pushed the first row of content 90-130px down the page. -->
  <div class="page-toolbar">
    <slot name="leading" />
    <div class="min-w-0 flex items-baseline gap-2">
      <h1 class="text-toolbar-title flex items-center gap-2 truncate">
        {{ title }}
        <slot name="trailing" />
      </h1>
      <slot name="subtitle">
        <p v-if="subtitle" class="t-small text-meta truncate hidden lg:block">{{ subtitle }}</p>
      </slot>
    </div>
    <SectionTabs class="shrink-0" />
    <div class="flex-1" />
    <div class="flex items-center gap-2">
      <slot name="right" />
    </div>
  </div>
</template>
