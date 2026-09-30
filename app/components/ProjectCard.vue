<script setup lang="ts">
import { formatRelativeTime } from '~/utils/messageFormatting'

interface ClaudeCodeProject {
  name: string
  path: string
  displayName: string
  lastActivity?: string
  sessionCount: number
}

defineProps<{
  project: ClaudeCodeProject
}>()
</script>

<template>
  <!-- One row of the Artifacts list. The CLI link sits beside the row link
       rather than inside it: an anchor nested in an anchor is invalid HTML, and
       the browser's repair of it broke hydration on this page. -->
  <li class="inset-row">
    <NuxtLink
      :to="`/project-artifacts/${encodeURIComponent(project.name)}`"
      class="flex items-center gap-3 flex-1 min-w-0 focus-ring rounded"
    >
      <span class="inset-row__lead"><UIcon name="i-lucide-box" class="size-4 text-meta" /></span>
      <span class="inset-row__body">
        <span class="inset-row__title t-ui">{{ project.displayName }}</span>
        <span class="inset-row__sub font-mono" :title="project.path">{{ project.path }}</span>
      </span>
      <span class="inset-row__end">
        {{ project.sessionCount }} {{ project.sessionCount === 1 ? 'session' : 'sessions' }}
        · {{ formatRelativeTime(project.lastActivity) || 'No activity' }}
      </span>
    </NuxtLink>
    <UButton
      :to="`/cli/project/${encodeURIComponent(project.name)}`"
      icon="i-lucide-terminal-square"
      size="xs"
      variant="ghost"
      color="neutral"
      aria-label="Open in CLI"
      title="Open in CLI"
    />
  </li>
</template>
