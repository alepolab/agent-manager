<script setup lang="ts">
const props = defineProps<{
  item: any
  depth: number
  expandedNodes: Set<string>
}>()

const isExpanded = computed(() => props.expandedNodes.has(props.item.path))

const emit = defineEmits<{
  'toggle': [path: string]
  'open-file': [path: string]
}>()

function handleClick() {
  if (props.item.type === 'directory') {
    emit('toggle', props.item.path)
  } else {
    emit('open-file', props.item.path)
  }
}

const fileIcon = computed(() => {
  if (props.item.type === 'directory') {
    return isExpanded.value ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'
  }
  
  const ext = props.item.extension?.toLowerCase()
  if (['vue', 'ts', 'js', 'tsx', 'jsx'].includes(ext)) return 'i-lucide-file-code'
  if (['md', 'txt'].includes(ext)) return 'i-lucide-file-text'
  if (['json', 'yaml', 'yml'].includes(ext)) return 'i-lucide-braces'
  if (['png', 'jpg', 'jpeg', 'svg', 'gif'].includes(ext)) return 'i-lucide-file-image'
  return 'i-lucide-file'
})

const folderIcon = computed(() => {
  return isExpanded.value ? 'i-lucide-folder-open' : 'i-lucide-folder'
})
</script>

<template>
  <div>
    <button 
      class="w-full flex items-center gap-2 px-2 py-1 hover-bg rounded transition-colors text-left group"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      @click="handleClick"
    >
      <UIcon v-if="item.type === 'directory'" :name="fileIcon" class="size-3 text-tertiary" />
      <div v-else class="size-3 shrink-0" />
      
      <UIcon 
        :name="item.type === 'directory' ? folderIcon : fileIcon" 
        class="size-3.5 shrink-0" 
        :style="{ color: item.type === 'directory' ? 'var(--accent)' : 'var(--text-tertiary)' }"
      />
      
      <span class="t-small truncate flex-1" :style="{ color: 'var(--text-secondary)' }">
        {{ item.name }}
      </span>
    </button>
    
    <div v-if="item.type === 'directory' && isExpanded && item.children" class="mt-0.5">
      <div v-for="child in item.children" :key="child.path">
        <ChatV2FileTreeNode 
          :item="child" 
          :depth="depth + 1" 
          :expanded-nodes="expandedNodes"
          @toggle="path => emit('toggle', path)"
          @open-file="path => emit('open-file', path)"
        />
      </div>
    </div>
  </div>
</template>
