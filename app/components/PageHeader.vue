<script setup lang="ts">
import { SETTINGS_TABS, routeIn } from '~/utils/navigation'

const props = defineProps<{
  title: string
  subtitle?: string
}>()
useHead({ title: computed(() => `${props.title} | Agent Manager`) })

/**
 * Inside Settings the toolbar title is "Settings" and the tab says which
 * pane: Products, Team and Roles used to title the toolbar with their own
 * name, so the heading changed on every tab while the tabs stayed put.
 */
const route = useRoute()
const inSettings = computed(() => SETTINGS_TABS.some(t => routeIn(route.path, t.to)))
const shownTitle = computed(() => (inSettings.value ? 'Settings' : props.title))
</script>

<template>
  <!-- A toolbar, not a masthead: title, the section's tabs, then actions, in
       one 52px row. The old header stacked a 26px display title over a mono
       subtitle and pushed the first row of content 90-130px down the page. -->
  <div class="page-toolbar">
    <slot name="leading" />
    <div class="shrink-0 max-w-full flex items-baseline gap-2">
      <h1 class="text-toolbar-title flex items-center gap-2 truncate">
        {{ shownTitle }}
        <slot v-if="!inSettings" name="trailing" />
      </h1>
      <!-- A subtitle only where there are no tabs: beside a tab strip it
           wrapped the toolbar onto a second line. -->
      <slot v-if="!inSettings" name="subtitle">
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
