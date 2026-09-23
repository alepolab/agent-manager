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

/**
 * The skills this person owns, apart from the ones a plugin brought.
 *
 * 190 skills rendered as one flat list is fifteen screens of scroll with no
 * heading in it, and the 34 you can actually edit or delete sit scattered
 * among 156 that arrive and leave with their plugin. Those are different
 * kinds of thing — one you maintain, the other you inherit — and the list
 * gave no way to tell them apart or to look at only one.
 *
 * Search deliberately stays flat: when you are looking for a known name, a
 * match is a match and which group it came from is not the question.
 */
const ownSkills = computed(() => filteredSkills.value.filter(s => s.source !== 'plugin'))

/** Plugin skills by the plugin that supplied them, so each collapses to a line. */
const pluginGroups = computed(() => {
  const groups = new Map<string, typeof skills.value>()
  for (const s of filteredSkills.value) {
    if (s.source !== 'plugin') continue
    const key = s.pluginName || 'plugin'
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})

const searching = computed(() => !!searchQuery.value.trim())

/**
 * The list as sections, so the row markup exists once.
 *
 * Yours is open; each plugin's is a closed line you can expand. Fifteen
 * screens becomes about three, and the group you can act on is the one you
 * land on.
 */
const sections = computed(() => {
  if (searching.value) {
    // The count is the badge's job; repeating it in the label reads as two
    // different numbers until you notice they are the same one.
    return [{ key: 'results', label: `matching “${searchQuery.value.trim()}”`, skills: filteredSkills.value, open: true }]
  }
  const out = [{ key: 'own', label: 'Yours', skills: ownSkills.value, open: true }]
  for (const [name, list] of pluginGroups.value) out.push({ key: `plugin:${name}`, label: name, skills: list, open: false })
  return out.filter(s => s.skills.length)
})

onMounted(() => {
  fetchSkills({ workingDir: workingDir.value })
})
</script>

<template>
  <div>
    <PageHeader title="Skills">
      <template #trailing>
        <span class="font-mono t-small text-meta">{{ skills.length }}</span>
      </template>
      <template #right>
        <UButton label="Import" icon="i-lucide-upload" size="sm" variant="soft" @click="() => { showImportModal = true }" />
        <UButton label="New Skill" icon="i-lucide-plus" size="sm" @click="() => { showCreateModal = true }" />
      </template>
    </PageHeader>

    <div class="px-6 py-4">
      <p class="t-ui mb-4 leading-relaxed text-label">
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
        <span class="t-small" style="color: var(--error);">{{ error }}</span>
      </div>

      <div v-if="loading" class="space-y-1">
        <SkeletonRow v-for="i in 5" :key="i" />
      </div>

      <!-- Skill list, in sections. One flat list of 190 was fifteen screens
           with no heading in it, and the 34 you maintain were scattered among
           156 that come and go with their plugin. -->
      <div v-else-if="filteredSkills.length" class="space-y-2">
        <details v-for="section in sections" :key="section.key" :open="section.open">
          <summary class="t-small cursor-pointer focus-ring rounded px-1 py-1 flex items-center gap-2">
            <span class="font-medium" style="color: var(--text-primary);">{{ section.label }}</span>
            <span class="font-mono text-meta">{{ section.skills.length }}</span>
          </summary>
          <div class="space-y-1 mt-1">
        <NuxtLink
          v-for="skill in section.skills"
          :key="skill.slug"
          :to="`/skills/${skill.slug}`"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg group focus-ring hover-row"
        >
          <!-- Icon -->
          <UIcon name="i-lucide-sparkles" class="size-3.5 shrink-0" style="color: var(--accent);" />

          <!-- Name -->
          <span class="t-ui font-medium w-44 shrink-0 truncate">
            {{ skill.frontmatter.name }}
          </span>

          <!-- Context badge -->
          <span
            v-if="skill.frontmatter.context"
            class="t-small font-mono px-1.5 py-px rounded-full shrink-0 badge badge-subtle"
          >
            {{ skill.frontmatter.context }}
          </span>

          <!-- Plugin badge -->
          <span
            v-if="skill.source === 'plugin' && skill.pluginName"
            class="t-small font-mono px-1.5 py-px rounded-full shrink-0 badge badge-accent"
          >
            plugin: {{ skill.pluginName }}
          </span>

          <!-- MCP badge -->
          <span
            v-if="skill.mcpServer"
            class="t-small font-mono px-1.5 py-px rounded-full shrink-0 badge"
            style="background: rgba(99, 102, 241, 0.1); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.2);"
          >
            mcp: {{ skill.mcpServer.name }}
          </span>

          <!-- Agent badge -->
          <span
            v-else-if="skill.frontmatter.agent"
            class="t-small font-mono px-1.5 py-px rounded-full shrink-0 badge badge-agent"
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
              class="t-small font-mono px-1.5 py-px rounded-full badge badge-subtle flex items-center gap-1"
            >
              <UIcon name="i-lucide-user" class="size-2.5" />
              <span v-if="skill.agents.length > 1">({{ skill.agents.length }})</span>
            </span>
          </div>

          <!-- Read at run time, not preloaded: the catalogue and ce skills -->
          <div
            v-if="skill.readBy?.length"
            class="flex items-center gap-1 shrink-0"
            :title="`Read at run time by: ${skill.readBy.map(a => a.name).join(', ')} (from disk, not inlined into the prompt)`"
          >
            <span
              class="t-small font-mono px-1.5 py-px rounded-full badge badge-subtle flex items-center gap-1"
            >
              <UIcon name="i-lucide-book-open" class="size-2.5" />
              <span>{{ skill.readBy.length }}</span>
            </span>
          </div>

          <!-- GitHub badge -->
          <ImportBadge
            v-if="skill.source === 'github' && skill.githubRepo"
            :repo="skill.githubRepo"
          />

          <!-- Description -->
          <span class="flex-1 t-small truncate text-label">
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
        </details>
      </div>

      <!-- Empty state: search miss -->
      <div v-else-if="searchQuery" class="flex flex-col items-center justify-center py-16">
        <p class="t-ui text-label">No skills match your search.</p>
      </div>

      <!-- Empty state: no skills -->
      <div v-else class="flex flex-col items-center justify-center py-12 space-y-5">
        <div class="rounded-lg p-4 bg-card max-w-sm w-full t-small text-label leading-relaxed space-y-1">
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
        <p class="t-ui text-label">Skills teach agents specific capabilities. Link a skill to an agent to extend what it can do.</p>
        <div class="flex items-center gap-2">
          <UButton label="Create a skill" size="sm" @click="() => { showCreateModal = true }" />
          <UButton label="Import from GitHub" size="sm" variant="outline" to="/explore?tab=imported" />
        </div>
      </div>
    </div>

    <UModal v-model:open="showCreateModal" title="New skill"
      description="Create a skill. It opens for editing once saved.">
      <template #content>
        <SkillForm
          mode="create"
          @saved="(s) => { showCreateModal = false; router.push(`/skills/${s.slug}`) }"
          @cancel="showCreateModal = false"
        />
      </template>
    </UModal>

    <UModal v-model:open="showImportModal" title="Import skill"
      description="Import skills from a GitHub repository.">
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
