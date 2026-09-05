<script setup lang="ts">
import type { Workflow } from '~/types'
import { getAgentColor } from '~/utils/colors'

const props = defineProps<{ workflow: Workflow }>()
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
