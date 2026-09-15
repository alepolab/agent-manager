<script setup lang="ts">
const props = defineProps<{
  projectName: string
}>()

const { data: files, pending, refresh } = useFetch(`/api/projects/${encodeURIComponent(props.projectName)}/files`, {
  query: { maxDepth: 2 }
})

const expandedNodes = ref(new Set<string>())

function toggleNode(path: string) {
  if (expandedNodes.value.has(path)) {
    expandedNodes.value.delete(path)
  } else {
    expandedNodes.value.add(path)
  }
}

const emit = defineEmits<{
  'open-file': [path: string]
}>()
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div class="px-4 py-2 border-b flex items-center justify-between" style="border-color: var(--border-subtle); background: var(--surface-raised);">
      <span class="t-small font-bold uppercase tracking-wider text-meta">Files</span>
      <button @click="refresh()" class="p-1 hover-bg rounded transition-all" title="Refresh">
        <UIcon name="i-lucide-refresh-cw" class="size-3" :class="{ 'animate-spin': pending }" />
      </button>
    </div>
    
    <div class="flex-1 overflow-y-auto p-2 custom-scrollbar">
      <div v-if="pending && !files" class="flex items-center justify-center h-20">
        <UIcon name="i-lucide-loader-2" class="size-5 animate-spin text-tertiary" />
      </div>
      
      <div v-else-if="files" class="space-y-0.5">
        <div v-for="item in files" :key="item.path">
          <ChatV2FileTreeNode 
            :item="item" 
            :depth="0" 
            :expanded-nodes="expandedNodes"
            @toggle="toggleNode"
            @open-file="path => emit('open-file', path)"
          />
        </div>
      </div>
    </div>
  </div>
</template>
