<script setup lang="ts">
import { highlightCode } from '~/utils/markdown'

const { state, closeEditor } = useFileEditor()
const { workingDir } = useWorkingDir()

const content = ref('')
const loading = ref(false)
const error = ref<string | null>(null)

const fileName = computed(() => state.value.filePath?.split('/').pop() || '')
const displayPath = computed(() => state.value.filePath || '')

async function fetchFileContent() {
  if (!state.value.filePath) return
  
  loading.value = true
  error.value = null
  
  try {
    const data = await $fetch<{ content: string }>('/api/files', {
      query: { 
        path: state.value.filePath,
        projectDir: workingDir.value
      }
    })
    content.value = data.content
  } catch (err: any) {
    error.value = err.data?.message || err.message || 'Failed to read file'
  } finally {
    loading.value = false
  }
}

watch(() => state.value.filePath, (newPath) => {
  if (newPath && !state.value.diffInfo) {
    fetchFileContent()
  } else if (state.value.diffInfo) {
    // If we have diff info, we can construct a diff view
    const diff = `--- a/${fileName.value}\n+++ b/${fileName.value}\n` + 
                 generateDiff(state.value.diffInfo.oldContent, state.value.diffInfo.newContent)
    content.value = diff
  }
}, { immediate: true })

function generateDiff(oldStr: string, newStr: string) {
  return newStr
}

const highlightedHtml = ref('')

async function updateHighlighting() {
  if (!content.value) {
    highlightedHtml.value = ''
    return
  }
  
  const lang = state.value.diffInfo ? 'diff' : (fileName.value.split('.').pop() || 'text')
  highlightedHtml.value = await highlightCode(content.value, lang)
}

watch(content, updateHighlighting, { immediate: true })
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0 overflow-hidden">
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
      <div class="flex items-center gap-3 min-w-0">
        <UIcon name="i-lucide-file-code" class="size-4 text-accent shrink-0" />
        <div class="flex flex-col min-w-0">
          <span class="t-ui font-semibold truncate">{{ fileName }}</span>
          <span class="t-small text-meta truncate">{{ displayPath }}</span>
        </div>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-hidden relative">
      <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-card/50 z-10">
        <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-accent" />
      </div>
      
      <div v-if="error" class="p-8 text-center space-y-3">
        <UIcon name="i-lucide-alert-circle" class="size-8 text-error mx-auto" />
        <p class="text-sm text-error">{{ error }}</p>
        <UButton label="Retry" size="sm" variant="soft" @click="fetchFileContent" />
      </div>

      <div v-else class="h-full overflow-auto p-4 custom-scrollbar">
        <div v-if="highlightedHtml" class="shiki-editor" v-html="highlightedHtml" />
        <pre v-else class="t-small font-mono whitespace-pre-wrap">{{ content }}</pre>
      </div>
    </div>
    
    <!-- Footer -->
    <div class="px-4 py-2 border-t border-border-subtle shrink-0 flex items-center justify-between">
      <span class="t-small text-meta font-mono">{{ content.split('\n').length }} lines</span>
      <div v-if="state.diffInfo" class="t-small px-2 py-0.5 rounded-full bg-accent-muted text-accent font-medium">
        Viewing Changes
      </div>
    </div>
  </div>
</template>

<style scoped>
.shiki-editor :deep(pre) {
  margin: 0;
  padding: 0;
  background: transparent !important;
  font-size: 12px;
  line-height: 1.6;
}

.shiki-editor :deep(.shiki-wrapper) {
  background: transparent !important;
}

.shiki-editor :deep(code) {
  background: transparent !important;
  padding: 0;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: var(--border-subtle);
  border-radius: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: var(--text-disabled);
}
</style>
