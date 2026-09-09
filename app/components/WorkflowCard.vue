<script setup lang="ts">
import type { Workflow } from '~/types'
import { getAgentColor } from '~/utils/colors'

const props = defineProps<{
  workflow: Workflow
  /**
   * This workflow's schedule counts, from the parent.
   *
   * Passed in rather than read from useSchedules() here: schedules are not
   * fetched app-wide the way agents are, so a card calling the composable
   * would render 0 unless it also triggered the fetch - which would be N
   * cards each firing one on mount.
   */
  schedules?: { total: number, enabled: number }
}>()
const { agents } = useAgents()

const stepAgents = computed(() => {
  return props.workflow.steps.map(s => agents.value.find(a => a.slug === s.agentSlug))
})

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
</script>

<template>
  <!-- The link wraps only the content; the footer with its own button sits
       beside it, so no interactive element is nested inside the anchor. -->
  <div
    class="rounded-xl transition-all duration-150 group"
    style="background: var(--surface-raised); border: 1px solid var(--border-subtle);"
    @mouseenter="($event.currentTarget as HTMLElement).style.borderColor = 'var(--border-default)'"
    @mouseleave="($event.currentTarget as HTMLElement).style.borderColor = 'var(--border-subtle)'"
  >
    <NuxtLink :to="`/workflows/${workflow.slug}`" class="block p-4 pb-3 focus-ring rounded-t-xl">
      <div class="flex items-start gap-3">
        <div
          class="size-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
          style="background: var(--accent-muted); border: 1px solid rgba(229, 169, 62, 0.15);"
        >
          <UIcon name="i-lucide-git-branch" class="size-4" style="color: var(--accent);" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-medium truncate" style="color: var(--text-primary);">{{ workflow.name }}</div>
          <div class="text-[11px] mt-0.5 line-clamp-2" style="color: var(--text-tertiary);">
            {{ workflow.description || 'No description' }}
          </div>
        </div>
      </div>
    </NuxtLink>
    <div class="flex items-center gap-2 mx-4 pt-3 pb-4" style="border-top: 1px solid var(--border-subtle);">
      <div class="flex -space-x-1">
        <div
          v-for="(agent, idx) in stepAgents.slice(0, 4)"
          :key="idx"
          class="size-5 rounded-full flex items-center justify-center text-[8px] font-bold"
          :style="{ background: agent ? getAgentColor(agent.frontmatter.color) + '30' : 'var(--badge-subtle-bg)', color: agent ? getAgentColor(agent.frontmatter.color) : 'var(--text-disabled)', border: '2px solid var(--surface-raised)', zIndex: 10 - idx }"
        >
          {{ idx + 1 }}
        </div>
      </div>
      <span class="text-[10px]" style="color: var(--text-disabled);">{{ workflow.steps.length }} step{{ workflow.steps.length === 1 ? '' : 's' }}</span>
      <ClientOnly>
        <span v-if="workflow.lastRunAt" class="text-[10px] ml-2" style="color: var(--text-disabled);">{{ timeAgo(workflow.lastRunAt) }}</span>
      </ClientOnly>
      <!-- Outside the NuxtLink wrapper above, so a link here is legal. The
           colour carries the distinction somebody scanning the list cares
           about - scheduled and live, versus scheduled and all switched off -
           while the exact split stays in the title. -->
      <NuxtLink
        v-if="schedules?.total"
        :to="`/workflows/${workflow.slug}?tab=schedule`"
        class="text-[10px] ml-2 flex items-center gap-1 focus-ring rounded"
        :style="{ color: schedules.enabled ? 'var(--text-tertiary)' : 'var(--text-disabled)' }"
        :title="`${schedules.total} schedule${schedules.total === 1 ? '' : 's'}, ${schedules.enabled} enabled`"
      >
        <UIcon name="i-lucide-calendar-clock" class="size-3" />{{ schedules.total }}
      </NuxtLink>
      <UButton
        size="xs" variant="soft" icon="i-lucide-play" label="Run"
        class="ml-auto"
        :disabled="workflow.steps.length === 0"
        :title="workflow.steps.length === 0 ? 'Add a step before running' : 'Run this workflow'"
        :to="workflow.steps.length ? `/workflows/${workflow.slug}?start=1` : undefined"
      />
    </div>
  </div>
</template>
