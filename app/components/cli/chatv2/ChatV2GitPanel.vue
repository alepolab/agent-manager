<script setup lang="ts">
const props = defineProps<{
  projectName: string
}>()

const { data: status, pending, refresh } = useFetch(`/api/projects/${encodeURIComponent(props.projectName)}/git/status`)

const emit = defineEmits<{
  'open-file': [path: string]
}>()
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div class="px-4 py-2 border-b flex items-center justify-between" style="border-color: var(--border-subtle); background: var(--surface-raised);">
      <div class="flex items-center gap-2">
        <span class="t-small font-bold uppercase tracking-wider text-meta">Git</span>
        <span v-if="status?.branch" class="t-small font-mono px-1.5 py-0.5 rounded-full" style="background: var(--accent-muted); color: var(--accent);">
          <UIcon name="i-lucide-git-branch" class="size-2.5 inline mr-1" />
          {{ status.branch }}
        </span>
      </div>
      <button @click="refresh()" class="p-1 hover-bg rounded transition-all" title="Refresh">
        <UIcon name="i-lucide-refresh-cw" class="size-3" :class="{ 'animate-spin': pending }" />
      </button>
    </div>
    
    <div class="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
      <div v-if="pending && !status" class="flex items-center justify-center h-20">
        <UIcon name="i-lucide-loader-2" class="size-5 animate-spin text-tertiary" />
      </div>
      
      <div v-else-if="status?.error" class="text-center py-8 px-4">
        <UIcon name="i-lucide-alert-circle" class="size-8 mx-auto mb-3 text-tertiary opacity-40" />
        <p class="t-ui font-medium mb-1" style="color: var(--text-primary);">Not a Git Repository</p>
        <p class="t-small" style="color: var(--text-tertiary);">{{ status.error }}</p>
      </div>
      
      <div v-else-if="status" class="space-y-6">
        <!-- Staged Changes -->
        <div v-if="status.staged?.length" class="space-y-2">
          <div class="flex items-center justify-between">
            <h4 class="t-small font-bold uppercase tracking-wider text-meta">Staged Changes</h4>
            <span class="t-small font-mono" style="color: var(--text-tertiary);">{{ status.staged.length }}</span>
          </div>
          <div class="space-y-1">
            <button 
              v-for="file in status.staged" :key="file"
              class="w-full flex items-center gap-2 px-2 py-1.5 hover-bg rounded text-left group transition-colors"
              @click="emit('open-file', file)"
            >
              <UIcon name="i-lucide-check-circle-2" class="size-3.5 text-success" />
              <span class="t-small truncate flex-1" style="color: var(--text-secondary);">{{ file }}</span>
            </button>
          </div>
        </div>

        <!-- Modified -->
        <div v-if="status.modified?.length" class="space-y-2">
          <div class="flex items-center justify-between">
            <h4 class="t-small font-bold uppercase tracking-wider text-meta">Modified</h4>
            <span class="t-small font-mono" style="color: var(--text-tertiary);">{{ status.modified.length }}</span>
          </div>
          <div class="space-y-1">
            <button 
              v-for="file in status.modified" :key="file"
              class="w-full flex items-center gap-2 px-2 py-1.5 hover-bg rounded text-left group transition-colors"
              @click="emit('open-file', file)"
            >
              <UIcon name="i-lucide-file-edit" class="size-3.5 text-accent" />
              <span class="t-small truncate flex-1" style="color: var(--text-secondary);">{{ file }}</span>
            </button>
          </div>
        </div>

        <!-- Untracked -->
        <div v-if="status.untracked?.length" class="space-y-2">
          <div class="flex items-center justify-between">
            <h4 class="t-small font-bold uppercase tracking-wider text-meta">Untracked</h4>
            <span class="t-small font-mono" style="color: var(--text-tertiary);">{{ status.untracked.length }}</span>
          </div>
          <div class="space-y-1">
            <button 
              v-for="file in status.untracked" :key="file"
              class="w-full flex items-center gap-2 px-2 py-1.5 hover-bg rounded text-left group transition-colors"
              @click="emit('open-file', file)"
            >
              <UIcon name="i-lucide-file-plus" class="size-3.5 text-tertiary" />
              <span class="t-small truncate flex-1" style="color: var(--text-secondary);">{{ file }}</span>
            </button>
          </div>
        </div>

        <!-- Deleted -->
        <div v-if="status.deleted?.length" class="space-y-2">
          <div class="flex items-center justify-between">
            <h4 class="t-small font-bold uppercase tracking-wider text-meta">Deleted</h4>
            <span class="t-small font-mono" style="color: var(--text-tertiary);">{{ status.deleted.length }}</span>
          </div>
          <div class="space-y-1">
            <div 
              v-for="file in status.deleted" :key="file"
              class="w-full flex items-center gap-2 px-2 py-1.5 opacity-60 grayscale"
            >
              <UIcon name="i-lucide-file-minus" class="size-3.5 text-error" />
              <span class="t-small truncate flex-1 line-through" style="color: var(--text-tertiary);">{{ file }}</span>
            </div>
          </div>
        </div>
        
        <div v-if="!status.modified?.length && !status.untracked?.length && !status.staged?.length && !status.deleted?.length" class="text-center py-12 px-4">
          <UIcon name="i-lucide-check-circle" class="size-10 mx-auto mb-3 text-success opacity-30" />
          <p class="t-ui font-medium" style="color: var(--text-secondary);">Working tree clean</p>
        </div>
      </div>
    </div>
  </div>
</template>
