<script setup lang="ts">
import { useClaudeCodeHistory } from '~/composables/useClaudeCodeHistory'

const history = useClaudeCodeHistory()
const { projects, isLoadingProjects, fetchProjects } = history
const toast = useToast()

const showAddModal = ref(false)
const newPath = ref('')
const newDisplayName = ref('')
const adding = ref(false)
const browsing = ref(false)
const { localDesktop } = useClaudeDir()

async function browseFolder() {
  browsing.value = true
  try {
    const res = await $fetch<{ path: string | null }>('/api/utils/pick-folder', { method: 'POST' })
    if (res.path) newPath.value = res.path
  } catch (err: any) {
    toast.add({ title: err.data?.message || 'Could not open folder picker', color: 'error' })
  } finally {
    browsing.value = false
  }
}

function openAddModal() {
  newPath.value = ''
  newDisplayName.value = ''
  showAddModal.value = true
}

async function addProject() {
  if (!newPath.value.trim()) return
  adding.value = true
  try {
    await $fetch('/api/projects', {
      method: 'POST',
      body: { path: newPath.value.trim(), displayName: newDisplayName.value.trim() || undefined }
    })
    showAddModal.value = false
    toast.add({ title: 'Project added', color: 'success' })
    await fetchProjects()
  } catch (err: any) {
    toast.add({ title: err.data?.message || 'Failed to add project', color: 'error' })
  } finally {
    adding.value = false
  }
}

onMounted(async () => {
  await fetchProjects()
})
useAutoRefresh(() => fetchProjects({ silent: true }))

useHead({
  title: 'Project Artifacts | Agent Manager',
})
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader title="Project Artifacts">
      <template #trailing>
        <span class="t-small text-meta">
          {{ projects.length }}
        </span>
      </template>
      <template #right>
        <div class="flex items-center gap-3">
          <UButton label="Add Project" icon="i-lucide-folder-plus" size="sm" @click="openAddModal" />
        </div>
      </template>
    </PageHeader>

    <div class="flex-1 overflow-y-auto custom-scrollbar p-6">
      <ul v-if="isLoadingProjects && projects.length === 0" class="inset-list max-w-5xl">
        <li v-for="i in 8" :key="i" class="inset-row"><span class="h-4 w-full rounded animate-pulse" style="background: var(--surface-hover);" /></li>
      </ul>

      <ul v-else-if="projects.length > 0" class="inset-list max-w-5xl">
        <ProjectCard
          v-for="project in projects"
          :key="project.name"
          :project="project"
        />
      </ul>

      <div v-else class="flex flex-col items-center justify-center py-20 text-center">
        <UIcon name="i-lucide-folder-x" class="size-8 text-meta mb-4" />
        <h2 class="t-body font-semibold mb-1" style="color: var(--text-primary);">
          No Claude projects found
        </h2>
        <p class="t-body text-meta max-w-sm mx-auto mb-8">
          Projects will appear here after you start a chat in a specific directory using Claude Code CLI.
        </p>
      </div>
    </div>

    <!-- Add Project Modal -->
    <Teleport to="body">
    <Transition name="modal">
      <div v-if="showAddModal" class="fixed inset-0 z-50 flex items-center justify-center p-4" style="background: rgba(0,0,0,0.5);" @click.self="showAddModal = false">
        <div class="w-full max-w-md rounded-2xl p-6 flex flex-col gap-5" style="background: var(--surface-base); border: 1px solid var(--border-subtle);">
          <div class="flex items-center justify-between">
            <h2 class="t-head font-semibold" style="color: var(--text-primary);">Add Project</h2>
            <button class="p-1.5 rounded-lg hover-bg" style="color: var(--text-secondary);" @click="showAddModal = false">
              <UIcon name="i-lucide-x" class="size-4" />
            </button>
          </div>

          <div class="flex flex-col gap-4">
            <div class="space-y-1">
              <label class="field-label">Directory path</label>
              <div class="flex gap-2">
                <input
                  v-model="newPath"
                  placeholder="/Users/you/my-project"
                  class="field-input flex-1 font-mono"
                  autofocus
                  @keydown.enter="addProject"
                />
                <button
                  class="px-3 py-2 rounded-xl t-ui font-medium transition-all flex items-center gap-1.5 shrink-0 disabled:opacity-50"
                  style="background: var(--surface-raised); border: 1px solid var(--border-subtle); color: var(--text-secondary);"
                  :disabled="browsing"
                  v-if="localDesktop"
                  @click="browseFolder"
                >
                  <UIcon v-if="browsing" name="i-lucide-loader-2" class="size-4 animate-spin" />
                  <UIcon v-else name="i-lucide-folder-open" class="size-4" />
                  Browse
                </button>
              </div>
            </div>

            <div class="space-y-1">
              <label class="field-label">Display name <span class="text-meta font-normal">(optional)</span></label>
              <input
                v-model="newDisplayName"
                placeholder="My Project"
                class="field-input w-full"
                @keydown.enter="addProject"
              />
            </div>
          </div>

          <div class="flex items-center justify-end gap-3">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showAddModal = false }" />
            <UButton label="Add Project" size="sm" :loading="adding" :disabled="!newPath.trim()" @click="addProject" />
          </div>
        </div>
      </div>
    </Transition>
    </Teleport>
  </div>
</template>
