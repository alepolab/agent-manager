<script setup lang="ts">
import { getAgentColor } from '~/utils/colors'
import { getModelBadgeClasses } from '~/utils/models'
import { agentTemplates } from '~/utils/templates'

const { agents, loading, error, create, fetchAll: fetchAgents } = useAgents()
const router = useRouter()
const toast = useToast()

const showCreateModal = ref(false)
const showImportModal = ref(false)
const searchQuery = ref('')
const skillCounts = ref<Record<string, number>>({})
const creatingTemplate = ref<string | null>(null)

onMounted(async () => {
  try {
    skillCounts.value = await $fetch<Record<string, number>>('/api/agents/skill-counts')
  } catch {
    // Non-critical
  }
})

const filteredAgents = computed(() => {
  if (!searchQuery.value) return agents.value
  const q = searchQuery.value.toLowerCase()
  return agents.value.filter(a =>
    a.frontmatter.name.toLowerCase().includes(q) ||
    a.frontmatter.description?.toLowerCase().includes(q)
  )
})

const groupedAgents = computed(() => {
  const groups: Record<string, typeof agents.value> = {}
  for (const agent of filteredAgents.value) {
    const key = agent.directory || ''
    ;(groups[key] ??= []).push(agent)
  }
  // Named folders alphabetically, root ('') last
  return Object.entries(groups).sort(([a], [b]) => {
    if (!a) return 1
    if (!b) return -1
    return a.localeCompare(b)
  })
})

const hasGroups = computed(() =>
  groupedAgents.value.length > 1 ||
  (groupedAgents.value.length === 1 && groupedAgents.value[0]?.[0] !== '')
)

async function useTemplate(templateId: string) {
  const template = agentTemplates.find(t => t.id === templateId)
  if (!template) return
  creatingTemplate.value = templateId
  try {
    const agent = await create({ frontmatter: { ...template.frontmatter }, body: template.body })
    toast.add({ title: `${template.frontmatter.name} created`, color: 'success' })
    router.push(`/agents/${agent.slug}`)
  } catch (e: any) {
    toast.add({ title: 'Failed to create', description: e.data?.message || e.message, color: 'error' })
  } finally {
    creatingTemplate.value = null
  }
}
</script>

<template>
  <div>
    <PageHeader title="Agents">
      <template #trailing>
        <span class="text-[12px] text-meta">{{ agents.length }}</span>
      </template>
      <template #right>
        <UButton label="Import" icon="i-lucide-upload" size="sm" variant="soft" @click="() => { showImportModal = true }" />
        <UButton label="New Agent" icon="i-lucide-plus" size="sm" @click="() => { showCreateModal = true }" />
      </template>
    </PageHeader>

    <div class="px-6 py-4">
      <p class="text-[13px] mb-4 leading-relaxed text-label">
        Specialized AI assistants with custom instructions and behavior.
      </p>

      <!-- Search -->
      <div class="mb-5">
        <input
          v-model="searchQuery"
          placeholder="Search agents..."
          class="field-search max-w-xs"
        />
      </div>

      <!-- Error state -->
      <div
        v-if="error"
        class="rounded-xl px-4 py-3 mb-4 flex items-start gap-3"
        style="background: rgba(248, 113, 113, 0.06); border: 1px solid rgba(248, 113, 113, 0.12);"
      >
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0 mt-0.5" style="color: var(--error);" />
        <span class="text-[12px]" style="color: var(--error);">{{ error }}</span>
      </div>

      <div v-if="loading" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <SkeletonCard v-for="i in 6" :key="i" />
      </div>

      <!-- Agent groups -->
      <div v-else-if="filteredAgents.length" class="space-y-6">
        <div v-for="([directory, groupAgents]) in groupedAgents" :key="directory || '__root__'">
          <!-- Section header — only shown when there are multiple groups -->
          <div v-if="hasGroups" class="flex items-center gap-2 mb-3">
            <UIcon name="i-lucide-folder" class="size-3.5 shrink-0" style="color: var(--text-meta);" />
            <span class="text-[11px] font-semibold uppercase tracking-widest" style="color: var(--text-meta);">
              {{ directory || 'General' }}
            </span>
            <span class="text-[10px] px-1.5 py-0.5 rounded-full" style="background: var(--surface-raised); color: var(--text-disabled);">
              {{ groupAgents.length }}
            </span>
            <div class="flex-1 h-px" style="background: var(--border-subtle);" />
          </div>

          <!-- Card grid -->
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            <NuxtLink
              v-for="agent in groupAgents"
              :key="agent.slug"
              :to="`/agents/${agent.slug}`"
              class="rounded-xl p-4 focus-ring hover-lift border border-subtle relative overflow-hidden group bg-card"
            >
              <!-- Color accent bar -->
              <div
                class="absolute inset-x-0 top-0 h-[4px] transition-opacity duration-200"
                :style="{ background: getAgentColor(agent.frontmatter.color) }"
              />

              <!-- Hover glow in agent color -->
              <div
                class="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                :style="{ background: 'radial-gradient(ellipse at top, ' + getAgentColor(agent.frontmatter.color) + '08 0%, transparent 60%)' }"
              />

              <!-- Header: icon + name + model -->
              <div class="flex items-center gap-3 mb-2 relative">
                <div
                  class="size-8 rounded-lg flex items-center justify-center shrink-0 transition-transform duration-200 group-hover:scale-105"
                  :style="{ background: getAgentColor(agent.frontmatter.color) + '18', border: '1px solid ' + getAgentColor(agent.frontmatter.color) + '25' }"
                >
                  <UIcon name="i-lucide-cpu" class="size-3.5" :style="{ color: getAgentColor(agent.frontmatter.color) }" />
                </div>
                <span class="text-[13px] font-medium truncate flex-1">
                  {{ agent.frontmatter.name }}
                </span>
                <span
                  v-if="agent.frontmatter.model"
                  class="text-[10px] font-mono font-medium px-1.5 py-px rounded-full shrink-0"
                  :class="[getModelBadgeClasses(agent.frontmatter.model).bg, getModelBadgeClasses(agent.frontmatter.model).text]"
                >
                  {{ agent.frontmatter.model }}
                </span>
              </div>

              <!-- Description -->
              <p v-if="agent.frontmatter.description" class="text-[12px] leading-relaxed line-clamp-2 text-label relative">
                {{ agent.frontmatter.description }}
              </p>

              <!-- Attached skills, named -->
              <div v-if="agent.frontmatter.skills?.length" class="mt-3 pt-3 relative" style="border-top: 1px solid var(--border-subtle);">
                <div class="flex flex-wrap items-center gap-1">
                  <UIcon name="i-lucide-sparkles" class="size-3 shrink-0 mr-0.5" style="color: var(--accent);" />
                  <span
                    v-for="skill in agent.frontmatter.skills"
                    :key="skill"
                    class="text-[10px] font-mono px-1.5 py-px rounded-full"
                    style="background: var(--badge-subtle-bg); color: var(--text-secondary);"
                  >{{ skill }}</span>
                </div>
              </div>

              <!-- Fallback: skills that point back at this agent via their own frontmatter -->
              <div v-else-if="skillCounts[agent.slug]" class="mt-3 pt-3 relative" style="border-top: 1px solid var(--border-subtle);">
                <span class="text-[10px] text-meta flex items-center gap-1.5">
                  <UIcon name="i-lucide-sparkles" class="size-3" style="color: var(--accent);" />
                  {{ skillCounts[agent.slug] }} skill{{ skillCounts[agent.slug] === 1 ? '' : 's' }}
                </span>
              </div>
            </NuxtLink>
          </div>
        </div>
      </div>

      <!-- Empty state: search miss -->
      <div v-else-if="searchQuery" class="flex flex-col items-center justify-center py-16 space-y-3">
        <p class="text-[13px] text-label">No agents match your search.</p>
      </div>

      <!-- Empty state: no agents — show templates -->
      <div v-else class="space-y-5">
        <div class="text-center py-4">
          <p class="text-[13px] text-label">No agents yet. Start from a template or create your own.</p>
        </div>

        <ExampleBlock title="What does a good agent look like?" class="max-w-md mx-auto mb-6">
          <div class="space-y-2 text-[11px]" style="color: var(--text-secondary);">
            <div class="rounded-lg p-3" style="background: var(--surface-base); border: 1px solid var(--border-subtle);">
              <p><strong style="color: var(--text-primary);">code-reviewer</strong> <span class="text-[10px]" style="color: var(--text-disabled);">← This name is short and descriptive</span></p>
              <p class="mt-1">"Reviews pull requests for bugs, style, and security." <span class="text-[10px]" style="color: var(--text-disabled);">← Explains what it does in one sentence</span></p>
              <p class="mt-1 text-[10px]" style="color: var(--text-tertiary);">"Check for bugs, flag security issues, suggest improvements..." <span style="color: var(--text-disabled);">← Instructions are specific</span></p>
            </div>
          </div>
        </ExampleBlock>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <button
            v-for="template in agentTemplates"
            :key="template.id"
            class="rounded-lg p-4 text-left hover-lift border border-subtle focus-ring relative overflow-hidden group bg-card"
            :disabled="creatingTemplate !== null"
            @click="useTemplate(template.id)"
          >
            <div class="flex items-center gap-2.5 mb-2">
              <UIcon :name="template.icon" class="size-4 shrink-0 text-label" />
              <span class="text-[13px] font-medium">{{ template.frontmatter.name }}</span>
              <UIcon
                v-if="creatingTemplate === template.id"
                name="i-lucide-loader-2"
                class="size-3.5 ml-auto animate-spin text-meta"
              />
            </div>
            <p class="text-[12px] text-label leading-relaxed line-clamp-2">
              {{ template.frontmatter.description }}
            </p>
          </button>
        </div>

        <div class="text-center">
          <UButton label="Or create from scratch" variant="ghost" size="sm" @click="() => { showCreateModal = true }" />
        </div>
      </div>
    </div>

    <UModal v-model:open="showCreateModal">
      <template #content>
        <AgentWizard
          @saved="(a) => { showCreateModal = false; router.push(`/agents/${a.slug}`) }"
          @cancel="showCreateModal = false"
        />
      </template>
    </UModal>

    <UModal v-model:open="showImportModal">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">Import Agent</h3>
          <FileImport
            type="agents"
            @imported="(a) => { showImportModal = false; fetchAgents(); router.push(`/agents/${a.slug}`) }"
          />
          <div class="flex justify-end">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showImportModal = false }" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
