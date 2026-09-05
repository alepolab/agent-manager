<script setup lang="ts">
const { skills, loading, error, fetchAll: fetchSkills } = useSkills()
const router = useRouter()
const { workingDir } = useWorkingDir()

const showCreateModal = ref(false)
const showImportModal = ref(false)
const searchQuery = ref('')

const filteredSkills = computed(() => {
  if (!searchQuery.value) return skills.value
  const q = searchQuery.value.toLowerCase()
  return skills.value.filter(s =>
    s.frontmatter.name.toLowerCase().includes(q) ||
    s.frontmatter.description?.toLowerCase().includes(q) ||
    s.frontmatter.agent?.toLowerCase().includes(q)
  )
})

onMounted(() => {
  fetchSkills({ workingDir: workingDir.value })
})
</script>

<template>
  <div>
    <PageHeader title="Skills">
      <template #trailing>
        <span class="font-mono text-[12px] text-meta">{{ skills.length }}</span>
      </template>
      <template #right>
        <UButton label="Import" icon="i-lucide-upload" size="sm" variant="soft" @click="() => { showImportModal = true }" />
        <UButton label="New Skill" icon="i-lucide-plus" size="sm" @click="() => { showCreateModal = true }" />
      </template>
    </PageHeader>

    <div class="px-6 py-4">
      <p class="text-[13px] mb-4 leading-relaxed text-label">
        Specific capabilities that can be added to agents and invoked as slash commands.
      </p>

      <!-- Search -->
      <div class="mb-4">
        <input
          v-model="searchQuery"
          placeholder="Search skills..."
          class="field-search max-w-xs"
        />
      </div>

      <div
        v-if="error"
        class="rounded-xl px-4 py-3 mb-4 flex items-start gap-3"
        style="background: rgba(248, 113, 113, 0.06); border: 1px solid rgba(248, 113, 113, 0.12);"
      >
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0 mt-0.5" style="color: var(--error);" />
        <span class="text-[12px]" style="color: var(--error);">{{ error }}</span>
      </div>

      <div v-if="loading" class="space-y-1">
        <SkeletonRow v-for="i in 5" :key="i" />
      </div>

      <!-- Skill list -->
      <div v-else-if="filteredSkills.length" class="space-y-1">
        <NuxtLink
          v-for="skill in filteredSkills"
          :key="skill.slug"
          :to="`/skills/${skill.slug}`"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg group focus-ring hover-row"
        >
          <!-- Icon -->
          <UIcon name="i-lucide-sparkles" class="size-3.5 shrink-0" style="color: var(--accent);" />

          <!-- Name -->
          <span class="text-[13px] font-medium w-44 shrink-0 truncate">
            {{ skill.frontmatter.name }}
          </span>

          <!-- Context badge -->
          <span
            v-if="skill.frontmatter.context"
            class="text-[10px] font-mono px-1.5 py-px rounded-full shrink-0 badge badge-subtle"
          >
            {{ skill.frontmatter.context }}
          </span>

          <!-- Plugin badge -->
          <span
            v-if="skill.source === 'plugin' && skill.pluginName"
            class="text-[10px] font-mono px-1.5 py-px rounded-full shrink-0 badge badge-accent"
          >
            plugin: {{ skill.pluginName }}
          </span>

          <!-- MCP badge -->
          <span
            v-if="skill.mcpServer"
            class="text-[10px] font-mono px-1.5 py-px rounded-full shrink-0 badge"
            style="background: rgba(99, 102, 241, 0.1); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.2);"
          >
            mcp: {{ skill.mcpServer.name }}
          </span>

          <!-- Agent badge -->
          <span
            v-else-if="skill.frontmatter.agent"
            class="text-[10px] font-mono px-1.5 py-px rounded-full shrink-0 badge badge-agent"
          >
            agent: {{ skill.frontmatter.agent }}
          </span>

          <!-- Preloaded by badge -->
          <div
            v-if="skill.agents?.length"
            class="flex items-center gap-1 shrink-0"
            :title="`Preloaded by: ${skill.agents.map(a => a.name).join(', ')}`"
          >
            <span
              class="text-[10px] font-mono px-1.5 py-px rounded-full badge badge-subtle flex items-center gap-1"
            >
              <UIcon name="i-lucide-user" class="size-2.5" />
              <span v-if="skill.agents.length > 1">({{ skill.agents.length }})</span>
            </span>
          </div>

          <!-- GitHub badge -->
          <ImportBadge
            v-if="skill.source === 'github' && skill.githubRepo"
            :repo="skill.githubRepo"
          />

          <!-- Description -->
          <span class="flex-1 text-[12px] truncate text-label">
            {{ skill.frontmatter.description }}
          </span>

          <!-- Metadata -->
          <div class="flex items-center gap-3 shrink-0">
            <UIcon
              name="i-lucide-chevron-right"
              class="size-3.5 opacity-0 group-hover:opacity-100 transition-opacity text-meta"
            />
          </div>
        </NuxtLink>
      </div>

      <!-- Empty state: search miss -->
      <div v-else-if="searchQuery" class="flex flex-col items-center justify-center py-16">
        <p class="text-[13px] text-label">No skills match your search.</p>
      </div>

      <!-- Empty state: no skills -->
      <div v-else class="flex flex-col items-center justify-center py-12 space-y-5">
        <div class="rounded-lg p-4 bg-card max-w-sm w-full text-[12px] text-label leading-relaxed space-y-1">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-cpu" class="size-3.5" style="color: var(--accent);" />
            <span>code-reviewer</span>
            <span class="text-meta">agent</span>
          </div>
          <div class="flex items-center gap-2 ml-5">
            <UIcon name="i-lucide-sparkles" class="size-3" style="color: var(--accent);" />
            <span>security-audit</span>
            <span class="text-meta">skill</span>
          </div>
          <div class="flex items-center gap-2 ml-5">
            <UIcon name="i-lucide-sparkles" class="size-3" style="color: var(--accent);" />
            <span>performance-check</span>
            <span class="text-meta">skill</span>
          </div>
        </div>
        <p class="text-[13px] text-label">Skills teach agents specific capabilities. Link a skill to an agent to extend what it can do.</p>
        <div class="flex items-center gap-2">
          <UButton label="Create a skill" size="sm" @click="() => { showCreateModal = true }" />
          <UButton label="Import from GitHub" size="sm" variant="outline" to="/explore?tab=imported" />
        </div>
      </div>
    </div>

    <UModal v-model:open="showCreateModal">
      <template #content>
        <SkillForm
          mode="create"
          @saved="(s) => { showCreateModal = false; router.push(`/skills/${s.slug}`) }"
          @cancel="showCreateModal = false"
        />
      </template>
    </UModal>

    <UModal v-model:open="showImportModal">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">Import Skill</h3>
          <FileImport
            type="skills"
            @imported="(s) => { showImportModal = false; fetchSkills(); router.push(`/skills/${s.slug}`) }"
          />
          <div class="flex justify-end">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showImportModal = false }" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
