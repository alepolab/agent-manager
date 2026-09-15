<script setup lang="ts">
import type { Agent, Skill } from '~/types'

const route = useRoute()
const projectName = route.params.projectName as string

interface ProjectArtifactsResponse {
  project: { name: string; path: string; displayName: string }
  agents: Agent[]
  skills: Skill[]
}

const { data, pending, error } = useFetch<ProjectArtifactsResponse>(`/api/project-artifacts/${encodeURIComponent(projectName)}/local`)

useHead({
  title: computed(() => data.value ? `${data.value.project.displayName} Artifacts | Agent Manager` : 'Project Artifacts')
})
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader :title="data?.project?.displayName || projectName">
      <template #trailing>
        <span class="t-small text-meta">Project Artifacts</span>
      </template>
      <template #right>
        <div class="flex items-center gap-3">
          <NuxtLink
            :to="`/cli/project/${encodeURIComponent(projectName)}`"
            class="px-4 py-2 rounded-xl t-ui font-semibold transition-all flex items-center gap-2"
            style="background: var(--accent); color: white;"
          >
            <UIcon name="i-lucide-terminal-square" class="size-4" />
            Open in CLI
          </NuxtLink>
        </div>
      </template>
    </PageHeader>

    <div class="flex-1 overflow-y-auto custom-scrollbar p-6">
      <div v-if="pending" class="flex items-center justify-center py-20">
        <UIcon name="i-lucide-loader-2" class="size-8 animate-spin" style="color: var(--accent);" />
      </div>

      <div v-else-if="error" class="flex flex-col items-center justify-center py-20 text-center">
        <UIcon name="i-lucide-alert-triangle" class="size-10 mb-4" style="color: var(--error);" />
        <h2 class="t-head font-semibold mb-2" style="color: var(--text-primary);">Failed to load project</h2>
        <p class="t-body text-meta mb-6">{{ error.message || 'Project not found' }}</p>
        <NuxtLink to="/project-artifacts" class="t-ui font-semibold" style="color: var(--accent);">
          &larr; Back to Artifacts
        </NuxtLink>
      </div>

      <div v-else-if="data" class="space-y-12 max-w-6xl mx-auto">
        <div class="rounded-xl p-4 flex flex-col gap-1" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
          <span class="t-small font-mono uppercase tracking-wider" style="color: var(--text-tertiary);">Project Path</span>
          <code class="t-ui" style="color: var(--text-primary);">{{ data.project.path }}</code>
        </div>

        <!-- Local Skills -->
        <section>
          <div class="flex items-center gap-3 mb-6 border-b pb-3" style="border-color: var(--border-subtle);">
            <div class="p-2 rounded-lg" style="background: rgba(251, 191, 36, 0.1);">
              <UIcon name="i-lucide-sparkles" class="size-5" style="color: #fbbf24;" />
            </div>
            <div>
              <h3 class="t-head font-semibold" style="color: var(--text-primary);">Local Skills</h3>
              <p class="t-ui" style="color: var(--text-secondary);">Custom skills scanned by file name <code>SKILL.MD</code></p>
            </div>
            <div class="ml-auto px-2.5 py-1 rounded-full t-small font-medium" style="background: var(--surface-raised); color: var(--text-secondary); border: 1px solid var(--border-subtle);">
              {{ data.skills.length }}
            </div>
          </div>

          <div v-if="data.skills.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <NuxtLink
              v-for="skill in data.skills"
              :key="skill.slug"
              :to="`/skills/${skill.slug}?workingDir=${encodeURIComponent(data.project.path)}&filePath=${encodeURIComponent(skill.filePath)}`"
              class="rounded-xl p-4 transition-all duration-200 block cursor-pointer hover-surface"
              style="background: var(--surface-raised); border: 1px solid var(--border-subtle);"
            >
              <div class="flex items-center gap-3 mb-3">
                <UIcon name="i-lucide-sparkles" class="size-4" style="color: #fbbf24;" />
                <div class="font-medium t-body" style="color: var(--text-primary);">{{ skill.frontmatter.name }}</div>
              </div>
              <p class="t-small line-clamp-3" style="color: var(--text-secondary);">
                {{ skill.frontmatter.description || 'No description' }}
              </p>
              <div class="mt-4 pt-3 flex" style="border-top: 1px solid var(--border-subtle);">
                <span class="t-small font-mono" style="color: var(--text-tertiary);">{{ skill.filePath.split('/').pop() }}</span>
              </div>
            </NuxtLink>
          </div>

          <div v-else class="text-center py-10 rounded-xl border border-dashed" style="border-color: var(--border-subtle);">
            <UIcon name="i-lucide-sparkles" class="size-8 mx-auto mb-3 opacity-20" style="color: var(--text-primary);" />
            <p class="t-body" style="color: var(--text-secondary);">No local skills found in this project.</p>
          </div>
        </section>

        <!-- Local Agents -->
        <section>
          <div class="flex items-center gap-3 mb-6 border-b pb-3" style="border-color: var(--border-subtle);">
            <div class="p-2 rounded-lg" style="background: rgba(99, 102, 241, 0.1);">
              <UIcon name="i-lucide-cpu" class="size-5" style="color: #6366f1;" />
            </div>
            <div>
              <h3 class="t-head font-semibold" style="color: var(--text-primary);">Local Agents</h3>
              <p class="t-ui" style="color: var(--text-secondary);">Custom agents scanned in folder name <code>`agents`</code></p>
            </div>
            <div class="ml-auto px-2.5 py-1 rounded-full t-small font-medium" style="background: var(--surface-raised); color: var(--text-secondary); border: 1px solid var(--border-subtle);">
              {{ data.agents.length }}
            </div>
          </div>

          <div v-if="data.agents.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <NuxtLink
              v-for="agent in data.agents"
              :key="agent.slug"
              :to="`/agents/${agent.slug}?workingDir=${encodeURIComponent(data.project.path)}`"
              class="rounded-xl p-4 transition-all duration-200 block cursor-pointer hover-surface"
              style="background: var(--surface-raised); border: 1px solid var(--border-subtle);"
            >
              <div class="flex items-center gap-3 mb-3">
                <UIcon name="i-lucide-cpu" class="size-4" style="color: #6366f1;" />
                <div class="font-medium t-body" style="color: var(--text-primary);">{{ agent.frontmatter.name }}</div>
              </div>
              <p class="t-small line-clamp-3" style="color: var(--text-secondary);">
                {{ agent.frontmatter.description || 'No description' }}
              </p>
              <div class="mt-4 pt-3 flex" style="border-top: 1px solid var(--border-subtle);">
                <span class="t-small font-mono" style="color: var(--text-tertiary);">{{ agent.filePath.split('/').pop() }}</span>
              </div>
            </NuxtLink>
          </div>

          <div v-else class="text-center py-10 rounded-xl border border-dashed" style="border-color: var(--border-subtle);">
            <UIcon name="i-lucide-cpu" class="size-8 mx-auto mb-3 opacity-20" style="color: var(--text-primary);" />
            <p class="t-body" style="color: var(--text-secondary);">No local agents found in this project.</p>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>