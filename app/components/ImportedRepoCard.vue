<script setup lang="ts">
import type { GithubImport } from '~/types'

const props = defineProps<{
  entry: GithubImport
  type: 'skills' | 'agents'
}>()

const emit = defineEmits<{
  update: [owner: string, repo: string]
  remove: [owner: string, repo: string]
  changed: []
}>()

const { getAvailableItems, updateSelectedItems } = useGithubImports()
const toast = useToast()

const hasUpdate = computed(() => props.entry.currentSha !== props.entry.remoteSha)

const editing = ref(false)
const loadingItems = ref(false)
const saving = ref(false)
const availableItems = ref<{ slug: string; name: string; description: string; category: string | null; selected: boolean }[]>([])
const selectedItems = ref<Set<string>>(new Set())

const groupedItems = computed(() => {
  const groups: Record<string, typeof availableItems.value> = {}
  for (const item of availableItems.value) {
    const cat = item.category || 'Other'
    const bucket = (groups[cat] ??= [])
    bucket.push(item)
  }
  return Object.keys(groups).sort().reduce((acc, key) => {
    acc[key] = groups[key] ?? []
    return acc
  }, {} as Record<string, typeof availableItems.value>)
})

const collapsedCategories = ref<Set<string>>(new Set())

function initCollapsed() {
  const collapsed = new Set<string>()
  for (const [cat, items] of Object.entries(groupedItems.value)) {
    const hasSelected = items.some(i => selectedItems.value.has(i.slug))
    if (!hasSelected) collapsed.add(cat)
  }
  collapsedCategories.value = collapsed
}

function toggleCategory(cat: string) {
  if (collapsedCategories.value.has(cat)) {
    collapsedCategories.value.delete(cat)
  } else {
    collapsedCategories.value.add(cat)
  }
  collapsedCategories.value = new Set(collapsedCategories.value)
}

const allSelected = computed(() =>
  availableItems.value.length > 0 && selectedItems.value.size === availableItems.value.length
)

const selectedCount = computed(() => selectedItems.value.size)

async function loadItems() {
  loadingItems.value = true
  try {
    const { skills, agents } = await getAvailableItems(props.entry.owner, props.entry.repo, props.type)
    const items = props.type === 'skills' ? skills : agents
    // `category` is optional on the wire; the grouping below requires it to
    // exist, and null is the honest "uncategorised" rather than a made-up name.
    availableItems.value = items.map(i => ({ ...i, category: i.category ?? null }))
    selectedItems.value = new Set(items.filter(i => i.selected).map(i => i.slug))
    initCollapsed()
  } catch {
    // Non-critical — show empty state
  } finally {
    loadingItems.value = false
  }
}

function toggleItem(slug: string) {
  if (!editing.value) return
  if (selectedItems.value.has(slug)) {
    selectedItems.value.delete(slug)
  } else {
    selectedItems.value.add(slug)
  }
  selectedItems.value = new Set(selectedItems.value)
}

function toggleAll() {
  if (!availableItems.value.length) return
  selectedItems.value = allSelected.value
    ? new Set()
    : new Set(availableItems.value.map(i => i.slug))
}

function cancelEditing() {
  editing.value = false
  // Restore original selection
  selectedItems.value = new Set(availableItems.value.filter(i => i.selected).map(i => i.slug))
}

async function saveSelection() {
  saving.value = true
  try {
    await updateSelectedItems(props.entry.owner, props.entry.repo, props.type, [...selectedItems.value])
    // Sync selected state on local items
    for (const item of availableItems.value) {
      item.selected = selectedItems.value.has(item.slug)
    }
    toast.add({ title: 'Selection updated', color: 'success' })
    editing.value = false
    emit('changed')
  } catch {
    toast.add({ title: 'Failed to update selection', color: 'error' })
  } finally {
    saving.value = false
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

onMounted(loadItems)
</script>

<template>
  <div class="space-y-4">
    <!-- Repo header -->
    <div
      class="rounded-xl p-4 flex items-center gap-3"
      style="background: var(--surface-raised); border: 1px solid var(--border-subtle);"
    >
      <!-- Left accent bar -->
      <div
        class="w-0.5 self-stretch rounded-full shrink-0"
        :style="{ background: type === 'agents' ? 'var(--accent)' : 'var(--info, #3b82f6)' }"
      />

      <!-- Icon -->
      <div
        class="size-8 rounded-lg flex items-center justify-center shrink-0"
        style="background: var(--surface-base); border: 1px solid var(--border-subtle);"
      >
        <UIcon :name="type === 'skills' ? 'i-lucide-sparkles' : 'i-lucide-cpu'" class="size-4 text-label" />
      </div>

      <!-- Repo name + meta -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-[13px] font-semibold truncate">{{ entry.owner }}/{{ entry.repo }}</span>
          <span
            v-if="hasUpdate"
            class="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0"
            style="background: rgba(59,130,246,0.1); color: var(--info, #3b82f6);"
          >
            Update available
          </span>
        </div>
        <div class="flex items-center gap-2.5 mt-0.5 text-[10px] text-meta font-mono flex-wrap">
          <span>
            <strong class="text-label">{{ entry.totalItems }}</strong> {{ type }} found
            &middot;
            <strong class="text-label">{{ entry.selectedItems?.length || 0 }}</strong> imported
          </span>
          <span style="color: var(--border-default);">·</span>
          <span>{{ formatDate(entry.importedAt) }}</span>
          <span style="color: var(--border-default);">·</span>
          <span>SHA {{ entry.currentSha.slice(0, 7) }}</span>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex items-center gap-1.5 shrink-0">
        <template v-if="editing">
          <UButton
            :label="allSelected ? 'Deselect all' : 'Select all'"
            size="xs"
            variant="ghost"
            color="neutral"
            @click="toggleAll"
          />
          <UButton label="Cancel" size="xs" variant="ghost" color="neutral" @click="cancelEditing" />
          <UButton
            :label="`Save (${selectedCount})`"
            size="xs"
            :loading="saving"
            @click="saveSelection"
          />
        </template>
        <template v-else>
          <UButton
            label="Edit"
            icon="i-lucide-settings-2"
            size="xs"
            variant="ghost"
            color="neutral"
            :disabled="loadingItems"
            @click="() => { editing = true }"
          />
          <UButton
            v-if="hasUpdate"
            label="Update"
            icon="i-lucide-download"
            size="xs"
            variant="soft"
            @click="emit('update', entry.owner, entry.repo)"
          />
          <a
            :href="entry.url"
            target="_blank"
            rel="noopener"
            class="inline-flex items-center gap-1 text-[11px] text-meta hover:text-label transition-colors px-2 py-1 rounded"
          >
            <UIcon name="i-lucide-external-link" class="size-3" />
            GitHub
          </a>
          <UButton
            icon="i-lucide-trash-2"
            size="xs"
            variant="ghost"
            color="error"
            @click="emit('remove', entry.owner, entry.repo)"
          />
        </template>
      </div>
    </div>

    <!-- Items area -->
    <div class="pl-4">
      <!-- Loading skeleton -->
      <div v-if="loadingItems" class="space-y-4">
        <div v-for="i in 2" :key="i" class="space-y-2">
          <div class="flex items-center gap-2 mb-2">
            <div class="h-px flex-1 rounded" style="background: var(--border-subtle);" />
            <div class="w-16 h-3 rounded" style="background: var(--surface-raised);" />
            <div class="h-px flex-1 rounded" style="background: var(--border-subtle);" />
          </div>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            <div
              v-for="j in 4"
              :key="j"
              class="rounded-lg h-16 animate-pulse"
              style="background: var(--surface-raised);"
            />
          </div>
        </div>
      </div>

      <!-- No items found -->
      <div
        v-else-if="!availableItems.length"
        class="rounded-lg px-4 py-6 text-center text-[12px] text-meta"
        style="border: 1px dashed var(--border-subtle);"
      >
        No {{ type }} found in this repository
      </div>

      <!-- Grouped items -->
      <div v-else class="space-y-5">
        <div v-for="(items, category) in groupedItems" :key="category" class="space-y-2">
          <!-- Category header (clickable to collapse) -->
          <button
            class="w-full flex items-center gap-2 group/cat"
            @click="toggleCategory(String(category))"
          >
            <UIcon
              name="i-lucide-chevron-right"
              class="size-3 shrink-0 text-meta transition-transform duration-150"
              :class="{ 'rotate-90': !collapsedCategories.has(String(category)) }"
            />
            <span class="text-[10px] font-mono uppercase tracking-widest text-meta shrink-0 group-hover/cat:text-label transition-colors">{{ category }}</span>
            <div class="flex-1 h-px" style="background: var(--border-subtle);" />
            <span class="text-[10px] text-meta shrink-0">{{ items.length }}</span>
          </button>

          <!-- Items grid -->
          <div v-if="!collapsedCategories.has(String(category))" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            <div
              v-for="item in items"
              :key="item.slug"
              class="relative rounded-lg p-2.5 transition-all duration-150 overflow-hidden"
              :class="[
                editing ? 'cursor-pointer' : 'cursor-default',
                !selectedItems.has(item.slug) ? 'opacity-40' : '',
              ]"
              :style="{
                background: 'var(--surface-raised)',
                border: selectedItems.has(item.slug)
                  ? '1px solid var(--border-default)'
                  : '1px dashed var(--border-subtle)',
                borderLeft: selectedItems.has(item.slug)
                  ? `3px solid ${type === 'agents' ? 'var(--accent)' : 'var(--info, #3b82f6)'}`
                  : '1px dashed var(--border-subtle)',
              }"
              @click="toggleItem(item.slug)"
            >
              <!-- Selected checkmark -->
              <div
                v-if="selectedItems.has(item.slug)"
                class="absolute top-2 right-2"
              >
                <UIcon name="i-lucide-check" class="size-3" style="color: var(--accent);" />
              </div>

              <div class="text-[11px] font-medium truncate pr-4" style="color: var(--text-primary);">
                {{ item.name }}
              </div>
              <div class="text-[10px] mt-0.5 line-clamp-2 leading-relaxed" style="color: var(--text-tertiary);">
                {{ item.description || '—' }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
