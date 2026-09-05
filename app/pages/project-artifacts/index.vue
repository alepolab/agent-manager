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

useHead({
  title: 'Project Artifacts | Agent Manager',
})
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader title="Project Artifacts">
      <template #trailing>
        <span class="text-[12px] text-meta">
          {{ projects.length }}
        </span>
      </template>
      <template #right>
        <div class="flex items-center gap-3">
          <button
            class="px-4 py-2 rounded-xl text-[13px] font-semibold transition-all flex items-center gap-2"
            style="background: var(--accent); color: white;"
            @click="openAddModal"
          >
            <UIcon name="i-lucide-folder-plus" class="size-4" />
            Add Project
          </button>
        </div>
      </template>
    </PageHeader>

    <div class="flex-1 overflow-y-auto custom-scrollbar p-6">
      <div v-if="isLoadingProjects && projects.length === 0" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        <div v-for="i in 8" :key="i" class="h-[140px] rounded-xl animate-pulse" style="background: var(--surface-raised);" />
      </div>

      <div v-else-if="projects.length > 0" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        <ProjectCard
          v-for="project in projects"
          :key="project.name"
          :project="project"
        />
      </div>

      <div v-else class="flex flex-col items-center justify-center py-20 text-center">
        <div class="size-20 rounded-3xl flex items-center justify-center mb-6" style="background: var(--surface-raised);">
          <UIcon name="i-lucide-folder-x" class="size-10 text-meta" />
        </div>
        <h2 class="text-[18px] font-semibold mb-2" style="color: var(--text-primary);">
          No Claude projects found
        </h2>
        <p class="text-[14px] text-meta max-w-sm mx-auto mb-8">
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
            <h2 class="text-[17px] font-semibold" style="color: var(--text-primary);">Add Project</h2>
            <button class="p-1.5 rounded-lg hover-bg" style="color: var(--text-secondary);" @click="showAddModal = false">
              <UIcon name="i-lucide-x" class="size-4" />
            </button>
          </div>

          <div class="flex flex-col gap-4">
            <div class="space-y-1">
              <label class="text-[11px] font-medium" style="color: var(--text-tertiary);">Directory Path <span style="color: var(--error);">*</span></label>
              <div class="flex gap-2">
                <input
                  v-model="newPath"
                  placeholder="/Users/you/my-project"
                  class="field-input flex-1 font-mono"
                  autofocus
                  @keydown.enter="addProject"
                />
                <button
                  class="px-3 py-2 rounded-xl text-[13px] font-medium transition-all flex items-center gap-1.5 shrink-0 disabled:opacity-50"
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
              <label class="text-[11px] font-medium" style="color: var(--text-tertiary);">Display Name <span style="color: var(--text-tertiary); font-weight: normal;">(optional)</span></label>
              <input
                v-model="newDisplayName"
                placeholder="My Project"
                class="field-input w-full"
                @keydown.enter="addProject"
              />
            </div>
          </div>

          <div class="flex items-center justify-end gap-3">
            <button
              class="px-4 py-2 rounded-xl text-[13px] font-medium transition-all hover-bg"
              style="color: var(--text-secondary);"
              @click="showAddModal = false"
            >
              Cancel
            </button>
            <button
              class="px-4 py-2 rounded-xl text-[13px] font-semibold transition-all flex items-center gap-2 disabled:opacity-50"
              style="background: var(--accent); color: white;"
              :disabled="!newPath.trim() || adding"
              @click="addProject"
            >
              <UIcon v-if="adding" name="i-lucide-loader-2" class="size-4 animate-spin" />
              <UIcon v-else name="i-lucide-folder-plus" class="size-4" />
              Add Project
            </button>
          </div>
        </div>
      </div>
    </Transition>
    </Teleport>
  </div>
</template>
