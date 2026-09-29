<script setup lang="ts">
import { tabsFor, routeIn } from '~/utils/navigation'

/**
 * The segmented control that switches between sibling pages — Watches and
 * Schedules, Plugins and MCP, the Settings tabs. Routes rather than tab state,
 * so a section can be linked to, bookmarked, and landed on by search. Renders
 * nothing on a page with no siblings.
 */
const route = useRoute()
const { me } = useUser()
// Unfinished pages (Graph, Explore, Output Styles) stay reachable by URL but
// are only offered with labs on. Per-developer, set on /profile: the
// instance-wide switch it replaced lived on a page three of the four roles
// could not open.
const labs = computed(() => me.value?.profile?.labs === true)
const tabs = computed(() => (tabsFor(route.path) ?? []).filter(t => labs.value || !t.labs))
</script>

<template>
  <nav v-if="tabs.length > 1" class="segmented" aria-label="Section">
    <NuxtLink
      v-for="tab in tabs"
      :key="tab.to"
      :to="tab.to"
      class="segmented__item focus-ring"
      :class="{ 'segmented__item--on': routeIn(route.path, tab.to) }"
      :aria-current="routeIn(route.path, tab.to) ? 'page' : undefined"
    >{{ tab.label }}</NuxtLink>
  </nav>
</template>
