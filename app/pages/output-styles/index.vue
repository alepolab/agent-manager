<script setup lang="ts">
import type { OutputStyle, OutputStylePayload } from '~/types'

const { styles, loading, error, fetchStyles, saveStyle, removeStyle } = useOutputStyles()

const isModalOpen = ref(false)
const editingStyle = ref<OutputStyle | null>(null)
const saving = ref(false)

onMounted(() => fetchStyles())

function onNewStyle() {
  editingStyle.value = null
  isModalOpen.value = true
}

function onEditStyle(style: OutputStyle) {
  editingStyle.value = { ...style }
  isModalOpen.value = true
}

async function onSaveStyle(payload: OutputStylePayload) {
  saving.value = true
  try {
    await saveStyle(payload)
    isModalOpen.value = false
  } finally {
    saving.value = false
  }
}

async function onDeleteStyle(id: string, scope: 'global' | 'project') {
  if (!confirm('Are you sure you want to delete this output style?')) return
  await removeStyle(id, scope)
}
</script>

<template>
  <div class="flex flex-col">
    <PageHeader title="Output Styles">
      <template #trailing>
        <span class="font-mono text-[12px] text-meta mr-4">{{ styles.length }}</span>
      </template>
      <template #right>
        <UButton label="New Output Style" icon="i-lucide-plus" size="sm" @click="onNewStyle" />
      </template>
    </PageHeader>

    <div class="px-6 py-4 flex-1">
      <p class="text-[13px] mb-6 leading-relaxed text-label max-w-2xl">
        Output styles allow you to adapt Claude Code for different roles while maintaining its core capabilities. They modify the system prompt and define the fundamental behavior, tone, and formatting.
      </p>

      <div v-if="error" class="rounded-xl px-4 py-3 mb-6 flex items-start gap-3 border-error bg-error-subtle">
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0 mt-0.5 text-error" />
        <span class="text-[12px] text-error">{{ error }}</span>
      </div>

      <div v-if="loading" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <SkeletonCard v-for="i in 6" :key="i" />
      </div>
      <div v-else-if="styles.length === 0" class="flex flex-col items-center justify-center py-12 border border-dashed rounded-xl border-subtle">
        <UIcon name="i-lucide-palette" class="size-8 text-meta mb-3" />
        <p class="text-[13px] text-secondary">No custom output styles configured.</p>
        <UButton label="Create your first style" variant="link" color="primary" @click="onNewStyle" class="mt-2" />
      </div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div
          v-for="style in styles"
          :key="style.id"
          class="bg-card group relative p-4 rounded-xl flex flex-col gap-3 hover-lift border border-subtle"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 mb-1">
                <h3 class="text-[14px] font-semibold text-primary font-display truncate">{{ style.name }}</h3>
                <span
                  v-if="!style.path"
                  class="text-[10px] px-1.5 py-0.5 rounded font-medium tracking-wide uppercase bg-accent/10 text-accent border border-accent/20"
                >
                  Built-in
                </span>
                <span
                  v-else
                  class="text-[10px] px-1.5 py-0.5 rounded font-medium tracking-wide uppercase"
                  :class="style.scope === 'global' ? 'bg-accent-subtle text-accent border border-accent-subtle' : 'bg-surface-raised text-secondary border border-subtle'"
                >
                  {{ style.scope }}
                </span>
              </div>
              <p class="text-[12px] text-secondary line-clamp-2 min-h-[32px]">
                {{ style.description || 'No description provided.' }}
              </p>
            </div>
            
            <div v-if="style.path" class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <UButton
                icon="i-lucide-edit-2"
                variant="ghost"
                color="neutral"
                size="xs"
                @click="onEditStyle(style)"
              />
              <UButton
                icon="i-lucide-trash-2"
                variant="ghost"
                color="error"
                size="xs"
                @click="onDeleteStyle(style.id, style.scope)"
              />
            </div>
          </div>

          <div class="mt-auto pt-3 border-t border-subtle flex items-center justify-between">
            <div class="flex items-center gap-2">
              <UIcon :name="!style.path ? 'i-lucide-shield' : 'i-lucide-file-text'" class="size-3 text-meta" />
              <span class="text-[11px] text-meta font-mono">{{ !style.path ? 'System' : style.id + '.md' }}</span>
            </div>
            <div v-if="style.keepCodingInstructions" class="flex items-center gap-1 text-[10px] text-accent font-medium uppercase tracking-wider">
              <UIcon name="i-lucide-shield-check" class="size-3" />
              <span>Coding rules active</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Add/Edit Modal -->
    <UModal v-model:open="isModalOpen">
      <template #content>
        <AddOutputStyleModal
          :initial-data="editingStyle ?? undefined"
          @close="isModalOpen = false"
          @save="onSaveStyle"
        />
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.bg-overlay { background: var(--surface-raised); }
.border-subtle { border-color: var(--border-subtle); }
.text-primary { color: var(--text-primary); }
.text-secondary { color: var(--text-secondary); }
.text-meta { color: var(--text-meta); }
.text-accent { color: var(--accent); }
.bg-accent-subtle { background: rgba(229, 169, 62, 0.1); border-color: rgba(229, 169, 62, 0.2); }
.border-error { border-color: rgba(248, 113, 113, 0.2); }
.bg-error-subtle { background: rgba(248, 113, 113, 0.05); }
.text-error { color: var(--error); }
.font-display { font-family: var(--font-display); }
</style>
