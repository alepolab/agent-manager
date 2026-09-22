<script setup lang="ts">
const props = defineProps<{
  toolName: string
  toolInput: any
  toolResult?: any
  isError?: boolean
}>()

const { openFile } = useFileEditor()

const isDiffTool = computed(() => ['Edit', 'Write', 'ApplyPatch'].includes(props.toolName))
const isReadTool = computed(() => props.toolName === 'Read')

const filePath = computed(() => {
  if (props.toolName === 'Glob') return null // Glob input is a pattern, not a single file to open
  if (isReadTool.value) return props.toolInput.filePath || props.toolInput.path
  if (isDiffTool.value) return props.toolInput.filePath || props.toolInput.path
  return null
})

function handleFileClick() {
  if (!filePath.value) return
  
  if (props.toolName === 'Edit' && props.toolResult && !props.isError) {
    // For Edit, we might have old/new content in the result if we updated the backend to provide it
    // Or we just show the file as is for now.
    openFile(filePath.value)
  } else {
    openFile(filePath.value)
  }
}
</script>

<template>
  <div class="tool-renderer my-1">
    <!-- Tool Input/Header -->
    <div class="flex items-center gap-2 px-2 py-1 rounded bg-surface-base border border-border-subtle mb-1">
      <UIcon 
        :name="isDiffTool ? 'i-lucide-file-edit' : (isReadTool ? 'i-lucide-file-text' : 'i-lucide-wrench')" 
        class="size-3.5 text-meta"
      />
      <span class="t-small font-mono font-medium text-label">{{ toolName }}</span>
      <button 
        v-if="filePath"
        class="t-small font-mono text-accent hover:underline truncate flex-1 text-left"
        @click="handleFileClick"
      >
        {{ filePath }}
      </button>
      <span v-else-if="toolInput" class="t-small font-mono text-meta truncate flex-1">
        {{ typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput) }}
      </span>
    </div>

    <!-- Tool Result -->
    <template v-if="toolResult">
      <!-- Special rendering for Edit/Diff results -->
      <ToolDiffViewer 
        v-if="isDiffTool && !isError && filePath"
        :file-path="filePath"
        :old-content="toolInput.old_string"
        :new-content="toolInput.new_string"
        @file-click="handleFileClick"
      />
      
      <!-- General result display (if not already handled or if error) -->
      <div 
        v-else-if="isError"
        class="p-2 rounded bg-error/5 border border-error/20 t-small text-error font-mono whitespace-pre-wrap"
      >
        {{ typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2) }}
      </div>
      
      <!-- For Read tool, we could show a snippet or just the clickable header -->
      <div 
        v-else-if="isReadTool"
        class="p-2 rounded bg-surface-base border border-border-subtle t-small text-label font-mono max-h-32 overflow-hidden relative"
      >
        <div class="whitespace-pre-wrap">{{ typeof toolResult === 'string' ? toolResult : toolResult.content }}</div>
        <div class="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface-base to-transparent" />
      </div>
    </template>
  </div>
</template>
