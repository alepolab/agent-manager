<script setup lang="ts">
/**
 * The directory Claude works in. It used to sit at the bottom of the sidebar
 * on every route; it lives here because the chat is what reads it.
 */
const { workingDir, displayPath, setWorkingDir, clearWorkingDir } = useWorkingDir()
const showWorkingDirPopover = ref(false)
const workingDirInput = ref('')
const dirSuggestions = ref<{ name: string; path: string; hasChildren: boolean }[]>([])
const selectedSuggestionIdx = ref(-1)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function openWorkingDirPopover() {
  workingDirInput.value = workingDir.value
  dirSuggestions.value = []
  selectedSuggestionIdx.value = -1
  showWorkingDirPopover.value = true
  if (workingDirInput.value) fetchDirSuggestions(workingDirInput.value)
}

function saveWorkingDir() {
  setWorkingDir(workingDirInput.value)
  showWorkingDirPopover.value = false
  dirSuggestions.value = []
}

async function fetchDirSuggestions(path: string) {
  if (!path) { dirSuggestions.value = []; return }
  try {
    const data = await $fetch<{ directories: typeof dirSuggestions.value }>('/api/directories', { query: { path } })
    dirSuggestions.value = data.directories
    selectedSuggestionIdx.value = -1
  } catch {
    dirSuggestions.value = []
  }
}

function onDirInput() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => fetchDirSuggestions(workingDirInput.value), 150)
}

function selectSuggestion(suggestion: { name: string; path: string; hasChildren: boolean }) {
  workingDirInput.value = suggestion.path
  selectedSuggestionIdx.value = -1
  if (suggestion.hasChildren) {
    fetchDirSuggestions(suggestion.path)
  } else {
    dirSuggestions.value = []
  }
}

function onDirKeydown(e: KeyboardEvent) {
  if (!dirSuggestions.value.length) {
    if (e.key === 'Enter') { e.preventDefault(); saveWorkingDir() }
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedSuggestionIdx.value = Math.min(selectedSuggestionIdx.value + 1, dirSuggestions.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedSuggestionIdx.value = Math.max(selectedSuggestionIdx.value - 1, -1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (selectedSuggestionIdx.value >= 0) {
      selectSuggestion(dirSuggestions.value[selectedSuggestionIdx.value]!)
    } else {
      saveWorkingDir()
    }
  } else if (e.key === 'Escape') {
    dirSuggestions.value = []
    selectedSuggestionIdx.value = -1
  }
}
</script>

<template>
  <UPopover v-model:open="showWorkingDirPopover" :ui="{ content: 'w-[280px]' }">
    <button
      class="flex items-center gap-1 text-[10px] font-mono hover:text-accent transition-colors focus-ring min-w-0"
      style="color: var(--text-disabled);"
      :title="workingDir || 'Set project directory'"
      @click="openWorkingDirPopover"
    >
      <UIcon name="i-lucide-folder" class="size-3 shrink-0" :style="{ color: workingDir ? 'var(--accent)' : undefined }" />
      <span class="truncate max-w-[180px]">{{ workingDir ? displayPath : 'Set project directory' }}</span>
      <UIcon name="i-lucide-chevron-down" class="size-2.5 shrink-0" />
    </button>
            <template #content>
              <div class="p-3 space-y-3">
                <div class="text-[13px] font-semibold" style="color: var(--text-primary); font-family: var(--font-sans);">Working Directory</div>
                <p class="text-[11px] leading-relaxed" style="color: var(--text-secondary);">
                  Claude works in this directory for chats here and on the CLI page. Runs started from the workflow page default to it. Remembered in this browser only.
                </p>
                <div class="relative">
                  <input
                    v-model="workingDirInput"
                    class="field-input text-[12px] font-mono"
                    placeholder="/path/to/your/project"
                    autocomplete="off"
                    @input="onDirInput"
                    @keydown="onDirKeydown"
                  />
                  <!-- Directory suggestions -->
                  <div
                    v-if="dirSuggestions.length"
                    class="mt-1 rounded-lg overflow-hidden max-h-[200px] overflow-y-auto"
                    style="border: 1px solid var(--border-subtle); background: var(--surface-raised);"
                  >
                    <button
                      v-for="(suggestion, idx) in dirSuggestions"
                      :key="suggestion.path"
                      type="button"
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors duration-75"
                      :style="{
                        background: idx === selectedSuggestionIdx ? 'var(--accent-muted)' : 'transparent',
                        color: idx === selectedSuggestionIdx ? 'var(--text-primary)' : 'var(--text-secondary)',
                      }"
                      @click="selectSuggestion(suggestion)"
                      @mouseenter="selectedSuggestionIdx = idx"
                    >
                      <UIcon
                        :name="suggestion.hasChildren ? 'i-lucide-folder' : 'i-lucide-folder-dot'"
                        class="size-3.5 shrink-0"
                        :style="{ color: idx === selectedSuggestionIdx ? 'var(--accent)' : 'var(--text-disabled)' }"
                      />
                      <span class="text-[11px] font-mono truncate">{{ suggestion.name }}</span>
                      <UIcon
                        v-if="suggestion.hasChildren"
                        name="i-lucide-chevron-right"
                        class="size-3 shrink-0 ml-auto"
                        style="color: var(--text-disabled);"
                      />
                    </button>
                  </div>
                </div>
                <div class="flex items-center justify-between">
                  <button
                    v-if="workingDir"
                    class="text-[11px] font-medium px-2 py-1 rounded hover-bg"
                    style="color: var(--error);"
                    @click="clearWorkingDir(); showWorkingDirPopover = false"
                  >
                    Clear
                  </button>
                  <div v-else />
                  <UButton label="Save" size="xs" @click="saveWorkingDir" />
                </div>
              </div>
            </template>
  </UPopover>
</template>
