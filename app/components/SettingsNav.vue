<script setup lang="ts">
/**
 * The four settings routes.
 *
 * A hand-rolled strip of links, matching the Canvas/Schedule strip on a
 * workflow: nothing in this app uses UTabs and its chrome would not match
 * these CSS-var styles. Routes rather than tab state, so a section can be
 * linked to, bookmarked, and landed on by search.
 */
const route = useRoute()

const TABS = [
  { to: '/settings/pipeline', label: 'Pipeline' },
  { to: '/settings/claude-code', label: 'Claude Code' },
  { to: '/settings/integrations', label: 'Integrations' },
  { to: '/settings/instance', label: 'Instance' },
]
</script>

<template>
  <div class="shrink-0 flex overflow-x-auto" style="border-bottom: 1px solid var(--border-subtle);">
    <NuxtLink
      v-for="tab in TABS"
      :key="tab.to"
      :to="tab.to"
      class="px-4 py-2.5 t-small font-medium transition-colors relative shrink-0 focus-ring"
      :style="{ color: route.path === tab.to ? 'var(--text-primary)' : 'var(--text-tertiary)' }"
    >
      {{ tab.label }}
      <span
        v-if="route.path === tab.to"
        class="absolute bottom-0 left-2 right-2 h-0.5 rounded-full"
        style="background: var(--accent);"
      />
    </NuxtLink>
  </div>
</template>
