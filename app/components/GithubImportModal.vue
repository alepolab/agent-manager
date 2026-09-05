<script setup lang="ts">
import type { SkillScanResult, AgentScanResult } from '~/types'

const props = defineProps<{
  type: 'skills' | 'agents'
}>()

const emit = defineEmits<{
  imported: []
}>()

const { scanSkills, scanAgents, importRepo, scanning } = useGithubImports()
const toast = useToast()

const step = ref<'url' | 'preview' | 'importing' | 'done'>('url')
const url = ref('')
const scanResult = ref<SkillScanResult | AgentScanResult | null>(null)
const selectedItems = ref<Set<string>>(new Set())
const importing = ref(false)
const error = ref('')

const typeLabel = computed(() => props.type === 'skills' ? 'Skills' : 'Agents')

const groupedItems = computed(() => {
  if (!scanResult.value) return {}
  const groups: Record<string, any[]> = {}
  
  const items = props.type === 'skills' 
    ? (scanResult.value as SkillScanResult).skills 
    : (scanResult.value as AgentScanResult).agents

  for (const item of items) {
    const cat = item.category || 'Other'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(item)
  }
  
  // Sort groups alphabetically
  return Object.keys(groups).sort().reduce((acc, key) => {
    acc[key] = groups[key] ?? []
    return acc
  }, {} as Record<string, any[]>)
})

async function doScan() {
  error.value = ''
  try {
    if (props.type === 'skills') {
      const result = await scanSkills(url.value)
      scanResult.value = result
      selectedItems.value = new Set(result.skills.map(s => s.slug))
    } else {
      const result = await scanAgents(url.value)
      scanResult.value = result
      selectedItems.value = new Set(result.agents.map(a => a.slug))
    }
    
    step.value = 'preview'
  } catch (e: any) {
    error.value = e.data?.data?.message || e.data?.message || e.message || 'Failed to scan repository'
  }
}

function toggleItem(slug: string) {
  if (selectedItems.value.has(slug)) {
    selectedItems.value.delete(slug)
  } else {
    selectedItems.value.add(slug)
  }
  selectedItems.value = new Set(selectedItems.value)
}

function toggleAll() {
  if (!scanResult.value) return
  if (props.type === 'skills') {
    const sr = scanResult.value as SkillScanResult
    if (selectedItems.value.size === sr.skills.length) {
      selectedItems.value = new Set()
    } else {
      selectedItems.value = new Set(sr.skills.map(s => s.slug))
    }
  } else {
    const sr = scanResult.value as AgentScanResult
    if (selectedItems.value.size === sr.agents.length) {
      selectedItems.value = new Set()
    } else {
      selectedItems.value = new Set(sr.agents.map(a => a.slug))
    }
  }
}

async function doImport() {
  const result = scanResult.value
  const currentUrl = url.value
  const currentType = props.type
  
  if (!result || !currentUrl) return
  
  if (selectedItems.value.size === 0) return

  importing.value = true
  step.value = 'importing'
  
  try {
    let totalItems = 0
    const selectedItemsList = [...selectedItems.value]
    
    if (currentType === 'skills') {
      totalItems = (result as SkillScanResult).totalSkills || 0
    } else {
      totalItems = (result as AgentScanResult).totalAgents || 0
    }

    const payload = {
      owner: result.owner,
      repo: result.repo,
      url: currentUrl,
      targetPath: result.targetPath || '',
      selectedItems: selectedItemsList,
      totalItems,
      type: currentType,
    }

    // Client-side validation
    if (!payload.owner || !payload.repo || !payload.url || !payload.type) {
      const missing = []
      if (!payload.owner) missing.push('owner')
      if (!payload.repo) missing.push('repo')
      if (!payload.url) missing.push('url')
      if (!payload.type) missing.push('type')
      
      throw new Error(`Validation failed: Missing ${missing.join(', ')}`)
    }

    await importRepo(payload)
    
    step.value = 'done'
    
    const count = selectedItems.value.size
    toast.add({ 
      title: `Import complete`, 
      description: `Imported ${count} ${currentType} from ${result.owner}/${result.repo}`,
      color: 'success' 
    })
  } catch (e: any) {
    error.value = e.data?.data?.message || e.data?.message || e.message || 'Import failed'
    step.value = 'preview'
    toast.add({
      title: 'Import failed',
      description: error.value,
      color: 'error'
    })
  } finally {
    importing.value = false
  }
}

function reset() {
  step.value = 'url'
  url.value = ''
  scanResult.value = null
  selectedItems.value = new Set()
  error.value = ''
}
</script>

<template>
  <div class="p-6 space-y-4 bg-overlay min-w-[520px]">
    <h3 class="text-page-title">Import {{ typeLabel }} from GitHub</h3>

    <!-- Step 1: URL input -->
    <template v-if="step === 'url'">
      <p class="text-[12px] text-label leading-relaxed">
        Paste a GitHub repository URL to scan for importable {{ typeLabel.toLowerCase() }}.
      </p>

      <div class="field-group">
        <label class="field-label">GitHub URL</label>
        <input
          v-model="url"
          class="field-input"
          placeholder="https://github.com/owner/repo"
          @keydown.enter="doScan"
        />
        <span class="field-hint">Supports repo URLs, subfolder URLs, and single file URLs</span>
      </div>

      <div
        v-if="error"
        class="rounded-lg px-3 py-2 text-[12px]"
        style="background: rgba(248, 113, 113, 0.06); color: var(--error); border: 1px solid rgba(248, 113, 113, 0.12);"
      >
        {{ error }}
      </div>

      <div class="flex justify-end gap-2">
        <UButton
          label="Scan"
          icon="i-lucide-search"
          size="sm"
          :loading="scanning"
          :disabled="!url.trim()"
          @click="doScan"
        />
      </div>
    </template>

    <!-- Step 2: Preview & select -->
    <template v-if="step === 'preview' && scanResult">
      <div class="flex items-center justify-between mb-2">
        <p class="text-[12px] text-label">
          Found <strong>{{ type === 'skills' ? (scanResult as SkillScanResult).totalSkills : (scanResult as AgentScanResult).totalAgents }}</strong> {{ typeLabel.toLowerCase() }} in
          <span class="font-mono">{{ scanResult.owner }}/{{ scanResult.repo }}</span>
        </p>
        <button class="text-[12px] text-meta hover:text-label" @click="toggleAll">
          {{ (type === 'skills' ? selectedItems.size === (scanResult as SkillScanResult).skills.length : selectedItems.size === (scanResult as AgentScanResult).agents.length) ? 'Deselect all' : 'Select all' }}
        </button>
      </div>

      <div class="max-h-80 overflow-y-auto space-y-4 rounded-lg p-1" style="background: var(--surface-base);">
        <div v-for="(items, category) in groupedItems" :key="category" class="space-y-1">
          <!-- Category Header -->
          <div class="px-3 py-1.5 sticky top-0 z-10 flex items-center gap-2" style="background: var(--surface-base);">
            <div class="h-px flex-1" style="background: var(--border-subtle);"></div>
            <span class="text-[10px] font-mono uppercase tracking-wider text-meta">{{ category }}</span>
            <div class="h-px flex-1" style="background: var(--border-subtle);"></div>
          </div>

          <label
            v-for="item in items"
            :key="item.slug"
            class="flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer hover-row"
          >
            <input
              type="checkbox"
              :checked="selectedItems.has(item.slug)"
              class="mt-0.5 shrink-0"
              @change="toggleItem(item.slug)"
            />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-[13px] font-medium truncate">{{ item.name }}</span>
                <span
                  v-if="item.conflict"
                  class="text-[9px] font-medium px-1.5 py-px rounded-full shrink-0"
                  style="background: rgba(234, 179, 8, 0.1); color: var(--warning, #eab308);"
                >
                  exists locally
                </span>
                <span
                  v-if="type === 'skills' && item.category"
                  class="text-[10px] font-mono px-1.5 py-px rounded-full shrink-0 badge badge-subtle"
                >
                  {{ item.category }}
                </span>
              </div>
              <p class="text-[11px] text-label mt-0.5 line-clamp-2">{{ item.description }}</p>
            </div>
          </label>
        </div>
      </div>

      <div
        v-if="error"
        class="rounded-lg px-3 py-2 text-[12px]"
        style="background: rgba(248, 113, 113, 0.06); color: var(--error); border: 1px solid rgba(248, 113, 113, 0.12);"
      >
        {{ error }}
      </div>

      <div class="flex justify-between mt-4">
        <UButton label="Back" variant="ghost" color="neutral" size="sm" @click="reset" />
        <UButton
          :label="`Import ${selectedItems.size} ${typeLabel.toLowerCase()}`"
          icon="i-lucide-download"
          size="sm"
          :disabled="selectedItems.size === 0"
          @click="doImport"
        />
      </div>
    </template>

    <!-- Step 3: Importing -->
    <template v-if="step === 'importing'">
      <div class="flex flex-col items-center py-8 space-y-3">
        <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-meta" />
        <p class="text-[13px] text-label">Cloning repository and linking {{ typeLabel.toLowerCase() }}...</p>
      </div>
    </template>

    <!-- Step 4: Done -->
    <template v-if="step === 'done'">
      <div class="flex flex-col items-center py-6 space-y-3">
        <div
          class="size-12 rounded-full flex items-center justify-center"
          style="background: rgba(34, 197, 94, 0.1);"
        >
          <UIcon name="i-lucide-check" class="size-6" style="color: var(--success, #22c55e);" />
        </div>
        <p class="text-[13px] font-medium">Import complete</p>
        <p class="text-[12px] text-label">
          {{ selectedItems.size }} {{ typeLabel.toLowerCase() }} imported from
          <span class="font-mono">{{ scanResult?.owner }}/{{ scanResult?.repo }}</span>
        </p>
        <UButton label="Close" size="sm" class="mt-4" @click="emit('imported')" />
      </div>
    </template>
  </div>
</template>
