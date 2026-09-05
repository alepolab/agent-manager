<script setup lang="ts">
import { ref, onMounted } from 'vue'

const route = useRoute()
const router = useRouter()
const { fetchServer, addServer, removeServer, fetchCapabilities } = useMCP()
const { clearChat: clearStudioChat, toolCalls, isStreaming: studioStreaming } = useStudioChat()
const toast = useToast()

const name = route.params.name as string
const scope = route.query.scope as 'global' | 'project'

const loading = ref(true)
const saving = ref(false)
const showDeleteConfirm = ref(false)

const capabilities = ref<{
  tools: any[]
  resources: any[]
  prompts: any[]
} | null>(null)
const loadingCapabilities = ref(false)
const isToolsCollapsed = ref(false)
const isResourcesCollapsed = ref(true)
const isPromptsCollapsed = ref(true)

function getToolCategory(tool: any) {
  const annotations = tool.annotations || {}
  if (annotations.readOnlyHint) return 'safe'
  if (annotations.destructiveHint) return 'risky'
  return 'unknown'
}

async function loadCapabilities() {
  loadingCapabilities.value = true
  try {
    capabilities.value = await fetchCapabilities(name, scope)
  } catch (e) {
    // Error handled by composable
  } finally {
    loadingCapabilities.value = false
  }
}

const form = ref({
  name: '',
  transport: 'stdio' as 'stdio' | 'sse' | 'http',
  command: '',
  argsString: '',
  url: '',
  scope: 'global' as 'global' | 'project',
  disabled: false,
  envPairs: [] as { key: string; value: string }[],
  headerPairs: [] as { key: string; value: string }[]
})

const initialForm = ref('')

const isDirty = computed(() => {
  return JSON.stringify(form.value) !== initialForm.value
})

onMounted(async () => {
  try {
    const data = await fetchServer(name, scope)
    form.value.name = data.name
    form.value.transport = data.transport
    form.value.command = data.command || ''
    form.value.argsString = data.args?.join(' ') || ''
    form.value.url = data.url || ''
    form.value.scope = data.scope
    form.value.disabled = !!data.disabled
    
    if (data.env) {
      form.value.envPairs = Object.entries(data.env).map(([key, value]) => ({ key, value }))
    }
    if (data.headers) {
      form.value.headerPairs = Object.entries(data.headers).map(([key, value]) => ({ key, value }))
    }
    initialForm.value = JSON.stringify(form.value)
  } catch (err) {
    router.push('/mcp')
  } finally {
    loading.value = false
  }
  clearStudioChat()
  loadCapabilities()
})

function addEnvRow() { form.value.envPairs.push({ key: '', value: '' }) }
function removeEnvRow(idx: number) { form.value.envPairs.splice(idx, 1) }

function addHeaderRow() { form.value.headerPairs.push({ key: '', value: '' }) }
function removeHeaderRow(idx: number) { form.value.headerPairs.splice(idx, 1) }

async function save() {
  if (!form.value.name.trim()) return
  saving.value = true
  
  const payload: any = {
    name: form.value.name.trim(),
    oldName: name,
    transport: form.value.transport,
    scope: form.value.scope,
    disabled: form.value.disabled
  }

  if (form.value.transport === 'stdio') {
    payload.command = form.value.command.trim()
    payload.args = form.value.argsString.split(' ').map(a => a.trim()).filter(a => a.length > 0)
    const env: Record<string, string> = {}
    for (const pair of form.value.envPairs) {
      if (pair.key.trim() && pair.value.trim()) env[pair.key.trim()] = pair.value.trim()
    }
    payload.env = env
  } else {
    payload.url = form.value.url.trim()
    const headers: Record<string, string> = {}
    for (const pair of form.value.headerPairs) {
      if (pair.key.trim() && pair.value.trim()) headers[pair.key.trim()] = pair.value.trim()
    }
    payload.headers = headers
  }

  try {
    await addServer(payload)
    initialForm.value = JSON.stringify(form.value)

    if (payload.name !== name) {
      router.push({ path: `/mcp/${encodeURIComponent(payload.name)}`, query: { scope: payload.scope } })
    }
  } catch (e: any) {
    // Error is already handled/toasted by useMCP
  } finally {
    saving.value = false
  }
}

async function handleDelete() {
  try {
    await removeServer(name, scope)
    router.push('/mcp')
  } catch (e: any) {
    // Error is already handled/toasted by useMCP
  }
}

function handleKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault()
    if (isDirty.value && !saving.value) save()
  }
}
onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))

useUnsavedChanges(isDirty)
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Top bar -->
    <div class="shrink-0 flex items-center justify-between px-6 py-3 border-b" style="border-color: var(--border-subtle);">
      <div class="flex items-center gap-3">
        <NuxtLink to="/mcp" class="p-1 rounded-md hover-bg" style="color: var(--text-tertiary);">
          <UIcon name="i-lucide-arrow-left" class="size-4" />
        </NuxtLink>
        <UIcon name="i-lucide-server" class="size-4" style="color: var(--accent);" />
        <h1 class="text-[16px] font-semibold tracking-tight" style="color: var(--text-primary); font-family: var(--font-display);">
          {{ loading ? 'Loading...' : name }}
        </h1>
        <span v-if="isDirty" class="text-[9px] font-mono px-1.5 py-px rounded-full" style="background: rgba(229, 169, 62, 0.1); color: var(--accent);">Unsaved</span>
      </div>
      <div class="flex items-center gap-2">
        <UButton
          :label="saving ? 'Saving...' : 'Save'"
          icon="i-lucide-save"
          size="sm"
          :variant="isDirty ? 'solid' : 'soft'"
          :color="isDirty ? 'primary' : 'neutral'"
          :disabled="!isDirty || saving"
          :loading="saving"
          @click="save"
        />
        <UButton
          label="Delete"
          icon="i-lucide-trash-2"
          size="sm"
          variant="ghost"
          color="error"
          title="Delete server"
          @click="() => { showDeleteConfirm = true }"
        />
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex-1 flex items-center justify-center">
      <UIcon name="i-lucide-loader-2" class="size-6 animate-spin" style="color: var(--text-disabled);" />
    </div>

    <!-- Main Content -->
    <div v-else class="flex-1 flex min-h-0">
      <!-- Left: Configuration -->
      <div class="w-[60%] flex flex-col border-r overflow-y-auto custom-scrollbar" style="border-color: var(--border-subtle);">
        <div class="px-8 py-6 space-y-8">
          <!-- Basic Info -->
          <section class="space-y-4">
            <h3 class="text-[13px] font-semibold tracking-wider uppercase opacity-50" style="color: var(--text-primary);">Basic Information</h3>
            <div class="grid grid-cols-2 gap-6">
              <div class="space-y-1.5">
                <label class="text-[11px] font-medium" style="color: var(--text-tertiary);">Server Name</label>
                <input v-model="form.name" type="text" class="field-input w-full" />
              </div>
              <div class="space-y-1.5">
                <label class="text-[11px] font-medium" style="color: var(--text-tertiary);">Scope</label>
                <select v-model="form.scope" class="field-input w-full" disabled>
                  <option value="global">Global (~/.claude.json)</option>
                  <option value="project">Project (.mcp.json)</option>
                </select>
                <p class="text-[10px] italic opacity-60" style="color: var(--text-tertiary);">Scope cannot be changed after creation.</p>
              </div>
            </div>
            <div class="flex items-center gap-2 pt-2">
              <label class="field-toggle">
                <input
                  type="checkbox"
                  :checked="!form.disabled"
                  @change="form.disabled = !($event.target as HTMLInputElement).checked"
                />
                <span class="field-toggle__track">
                  <span class="field-toggle__thumb" />
                </span>
              </label>
              <div class="flex flex-col">
                <span class="text-[13px] font-medium" :class="form.disabled ? 'text-secondary' : 'text-primary'">
                  {{ form.disabled ? 'Server Disabled' : 'Server Enabled' }}
                </span>
                <span class="text-[11px] text-tertiary opacity-60">
                  {{ form.disabled ? 'This server will not be loaded by Claude.' : 'This server is active and available for use.' }}
                </span>
              </div>
            </div>
          </section>

          <!-- Transport -->
          <section class="space-y-4">
            <h3 class="text-[13px] font-semibold tracking-wider uppercase opacity-50" style="color: var(--text-primary);">Transport Configuration</h3>
            <div class="space-y-4">
              <div class="space-y-1.5">
                <label class="text-[11px] font-medium" style="color: var(--text-tertiary);">Transport Type</label>
                <div class="flex gap-6 pt-1">
                  <label class="flex items-center gap-2 cursor-pointer group">
                    <input v-model="form.transport" type="radio" value="stdio" class="accent-accent" />
                    <span class="text-[13px] group-hover:opacity-100 transition-opacity" :class="form.transport === 'stdio' ? 'opacity-100 font-medium' : 'opacity-60'">stdio (Local)</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer group">
                    <input v-model="form.transport" type="radio" value="http" class="accent-accent" />
                    <span class="text-[13px] group-hover:opacity-100 transition-opacity" :class="form.transport === 'http' ? 'opacity-100 font-medium' : 'opacity-60'">http (Streamable)</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer group">
                    <input v-model="form.transport" type="radio" value="sse" class="accent-accent" />
                    <div class="flex items-center gap-1.5" :class="form.transport === 'sse' ? 'opacity-100' : 'opacity-60'">
                      <span class="text-[13px] group-hover:opacity-100 transition-opacity" :class="form.transport === 'sse' ? 'font-medium' : ''">sse (Classic)</span>
                      <span class="text-[9px] font-mono px-1 py-0.5 rounded bg-error/10 text-error uppercase leading-none border border-error/20">Deprecated</span>
                    </div>
                  </label>
                </div>
              </div>

              <template v-if="form.transport === 'stdio'">
                <div class="space-y-4">
                  <div class="space-y-1.5">
                    <label class="text-[11px] font-medium" style="color: var(--text-tertiary);">Command</label>
                    <input v-model="form.command" type="text" class="field-input w-full font-mono text-[13px]" placeholder="e.g. npx" />
                  </div>
                  <div class="space-y-1.5">
                    <label class="text-[11px] font-medium" style="color: var(--text-tertiary);">Arguments</label>
                    <input v-model="form.argsString" type="text" class="field-input w-full font-mono text-[13px]" placeholder="e.g. -y @modelcontextprotocol/server-github" />
                  </div>
                </div>
              </template>

              <template v-else-if="form.transport === 'sse' || form.transport === 'http'">
                <div class="space-y-1.5">
                  <label class="text-[11px] font-medium" style="color: var(--text-tertiary);">URL</label>
                  <input v-model="form.url" type="text" class="field-input w-full font-mono text-[13px]" placeholder="https://example.com/sse" />
                </div>
              </template>
            </div>
          </section>

          <!-- Dynamic Rows -->
          <section class="space-y-4">
            <div v-if="form.transport === 'stdio'">
              <div class="flex items-center justify-between mb-2">
                <h3 class="text-[13px] font-semibold tracking-wider uppercase opacity-50" style="color: var(--text-primary);">Environment Variables</h3>
                <button class="text-[11px] font-medium transition-colors" style="color: var(--accent);" @click="addEnvRow">
                  + Add Row
                </button>
              </div>
              <div class="space-y-2">
                <div v-for="(pair, idx) in form.envPairs" :key="idx" class="flex items-center gap-2 group">
                  <input v-model="pair.key" type="text" class="field-input flex-1 font-mono text-[12px]" placeholder="KEY" />
                  <span class="text-secondary opacity-40">=</span>
                  <input v-model="pair.value" type="text" class="field-input flex-1 font-mono text-[12px]" placeholder="VALUE" />
                  <button class="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all hover:bg-error/10 text-error/60 hover:text-error" @click="removeEnvRow(idx)">
                    <UIcon name="i-lucide-trash-2" class="size-3.5" />
                  </button>
                </div>
                <div v-if="!form.envPairs.length" class="py-4 border border-dashed rounded-xl flex flex-col items-center justify-center opacity-40" style="border-color: var(--border-subtle);">
                  <p class="text-[12px]">No environment variables configured</p>
                </div>
              </div>
            </div>

            <div v-else>
              <div class="flex items-center justify-between mb-2">
                <h3 class="text-[13px] font-semibold tracking-wider uppercase opacity-50" style="color: var(--text-primary);">Headers</h3>
                <button class="text-[11px] font-medium transition-colors" style="color: var(--accent);" @click="addHeaderRow">
                  + Add Row
                </button>
              </div>
              <div class="space-y-2">
                <div v-for="(pair, idx) in form.headerPairs" :key="idx" class="flex items-center gap-2 group">
                  <input v-model="pair.key" type="text" class="field-input flex-1 font-mono text-[12px]" placeholder="Header Name" />
                  <span class="text-secondary opacity-40">:</span>
                  <input v-model="pair.value" type="text" class="field-input flex-1 font-mono text-[12px]" placeholder="Value" />
                  <button class="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all hover:bg-error/10 text-error/60 hover:text-error" @click="removeHeaderRow(idx)">
                    <UIcon name="i-lucide-trash-2" class="size-3.5" />
                  </button>
                </div>
                <div v-if="!form.headerPairs.length" class="py-4 border border-dashed rounded-xl flex flex-col items-center justify-center opacity-40" style="border-color: var(--border-subtle);">
                  <p class="text-[12px]">No custom headers configured</p>
                </div>
              </div>
            </div>
          </section>

          <!-- Capabilities -->
          <section class="space-y-6 pt-8 border-t" style="border-color: var(--border-subtle);">
            <div class="flex items-center justify-between">
              <div class="space-y-1">
                <h3 class="text-[13px] font-semibold tracking-wider uppercase opacity-50" style="color: var(--text-primary);">Capabilities</h3>
                <p class="text-[11px] opacity-40">Discovered tools, resources, and prompts from this server.</p>
              </div>
              <UButton
                icon="i-lucide-refresh-cw"
                size="xs"
                variant="ghost"
                :loading="loadingCapabilities"
                @click="loadCapabilities"
                label="Refresh"
              />
            </div>

            <div v-if="loadingCapabilities" class="py-12 flex flex-col items-center justify-center gap-3">
              <UIcon name="i-lucide-loader-2" class="size-6 animate-spin" style="color: var(--accent);" />
              <span class="text-[12px] opacity-60">Connecting to server...</span>
            </div>

            <div v-else-if="capabilities" class="space-y-8">
              <!-- Tools -->
              <div class="space-y-4">
                <button 
                  class="flex items-center justify-between w-full px-1 group/header"
                  @click="isToolsCollapsed = !isToolsCollapsed"
                >
                  <div class="flex items-center gap-2">
                    <UIcon name="i-lucide-wrench" class="size-4 opacity-60 text-accent" />
                    <span class="text-[13px] font-semibold">Tools</span>
                    <span class="text-[11px] font-mono px-1.5 py-px rounded-full" style="background: var(--badge-subtle-bg); color: var(--text-tertiary);">{{ capabilities.tools.length }}</span>
                  </div>
                  <UIcon 
                    :name="isToolsCollapsed ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'" 
                    class="size-4 opacity-40 group-hover/header:opacity-100 transition-all" 
                  />
                </button>
                <div v-if="!isToolsCollapsed">
                  <div v-if="capabilities.tools.length" class="grid gap-3">
                    <div v-for="tool in (capabilities.tools as any[])" :key="tool.name" class="p-4 rounded-xl border group/tool hover:border-accent/40 transition-all min-w-0" style="background: var(--surface-base); border-color: var(--border-subtle);">
                      <div class="flex items-center justify-between mb-2 gap-4">
                        <div class="font-mono text-[13px] font-bold text-accent truncate min-w-0" :title="tool.name">{{ tool.name }}</div>
                        
                        <div v-if="getToolCategory(tool) !== 'unknown'" class="flex items-center gap-1 bg-surface-raised/50 p-0.5 rounded-lg border border-transparent group-hover/tool:border-border-subtle transition-all shrink-0">
                          <button 
                            class="p-1 rounded-md transition-colors" 
                            :class="getToolCategory(tool) === 'safe' ? 'text-success bg-success/10 border border-success/20' : 'text-text-tertiary hover:bg-success/10 hover:text-success'"
                            title="Always Allow"
                          >
                            <UIcon name="i-lucide-shield-check" class="size-3.5" />
                          </button>
                          <button 
                            class="p-1 rounded-md transition-colors" 
                            :class="getToolCategory(tool) === 'risky' ? 'text-accent bg-accent/10 border border-accent/20' : 'text-text-tertiary hover:bg-accent/10 hover:text-accent'"
                            title="Require Permission (Default)"
                          >
                            <UIcon name="i-lucide-fingerprint" class="size-3.5" />
                          </button>
                          <button 
                            class="p-1 rounded-md transition-colors text-text-tertiary hover:bg-error/10 hover:text-error" 
                            title="Block Tool"
                          >
                            <UIcon name="i-lucide-shield-x" class="size-3.5" />
                          </button>
                        </div>
                      </div>
                      <div class="text-[12px] leading-relaxed" style="color: var(--text-secondary);">{{ tool.description }}</div>
                      <div v-if="tool.inputSchema" class="mt-3 pt-3 border-t border-dashed" style="border-color: var(--border-subtle);">
                        <div class="text-[10px] uppercase tracking-wider font-semibold opacity-40 mb-2">Input Schema</div>
                        <pre class="text-[10px] p-2 rounded-lg font-mono overflow-x-auto" style="background: var(--surface-raised); color: var(--text-tertiary);">{{ JSON.stringify(tool.inputSchema.properties || {}, null, 2) }}</pre>
                      </div>
                    </div>
                  </div>
                  <div v-else class="py-8 border border-dashed rounded-xl flex flex-col items-center justify-center opacity-40" style="border-color: var(--border-subtle);">
                    <p class="text-[12px]">No tools discovered</p>
                  </div>
                </div>
              </div>

              <!-- Resources -->
              <div class="space-y-4">
                <button 
                  class="flex items-center justify-between w-full px-1 group/header"
                  @click="isResourcesCollapsed = !isResourcesCollapsed"
                >
                  <div class="flex items-center gap-2">
                    <UIcon name="i-lucide-database" class="size-4 opacity-60 text-success" />
                    <span class="text-[13px] font-semibold">Resources</span>
                    <span class="text-[11px] font-mono px-1.5 py-px rounded-full" style="background: var(--badge-subtle-bg); color: var(--text-tertiary);">{{ capabilities.resources.length }}</span>
                  </div>
                  <UIcon 
                    :name="isResourcesCollapsed ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'" 
                    class="size-4 opacity-40 group-hover/header:opacity-100 transition-all" 
                  />
                </button>
                <div v-if="!isResourcesCollapsed">
                  <div v-if="capabilities.resources.length" class="grid gap-3">
                    <div v-for="resource in (capabilities.resources as any[])" :key="resource.uri" class="p-4 rounded-xl border hover:border-success/40 transition-all" style="background: var(--surface-base); border-color: var(--border-subtle);">
                      <div class="font-mono text-[12px] font-bold text-success mb-1">{{ resource.name }}</div>
                      <div class="text-[11px] opacity-60 font-mono mb-2 truncate">{{ resource.uri }}</div>
                      <div class="text-[12px]" style="color: var(--text-secondary);">{{ resource.description }}</div>
                    </div>
                  </div>
                  <div v-else class="py-8 border border-dashed rounded-xl flex flex-col items-center justify-center opacity-40" style="border-color: var(--border-subtle);">
                    <p class="text-[12px]">No resources discovered</p>
                  </div>
                </div>
              </div>

              <!-- Prompts -->
              <div class="space-y-4">
                <button 
                  class="flex items-center justify-between w-full px-1 group/header"
                  @click="isPromptsCollapsed = !isPromptsCollapsed"
                >
                  <div class="flex items-center gap-2">
                    <UIcon name="i-lucide-terminal" class="size-4 opacity-60 text-primary" />
                    <span class="text-[13px] font-semibold">Prompts</span>
                    <span class="text-[11px] font-mono px-1.5 py-px rounded-full" style="background: var(--badge-subtle-bg); color: var(--text-tertiary);">{{ capabilities.prompts.length }}</span>
                  </div>
                  <UIcon 
                    :name="isPromptsCollapsed ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'" 
                    class="size-4 opacity-40 group-hover/header:opacity-100 transition-all" 
                  />
                </button>
                <div v-if="!isPromptsCollapsed">
                  <div v-if="capabilities.prompts.length" class="grid gap-3">
                    <div v-for="prompt in (capabilities.prompts as any[])" :key="prompt.name" class="p-4 rounded-xl border hover:border-primary/40 transition-all" style="background: var(--surface-base); border-color: var(--border-subtle);">
                      <div class="font-mono text-[12px] font-bold text-primary mb-1">{{ prompt.name }}</div>
                      <div class="text-[12px]" style="color: var(--text-secondary);">{{ prompt.description }}</div>
                      <div v-if="prompt.arguments?.length" class="mt-3 flex flex-wrap gap-2">
                        <span v-for="arg in prompt.arguments" :key="arg.name" class="text-[10px] font-mono px-1.5 py-px rounded-md border" :title="arg.description" style="background: var(--surface-raised); border-color: var(--border-subtle);">
                          {{ arg.name }}{{ arg.required ? '*' : '' }}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div v-else class="py-8 border border-dashed rounded-xl flex flex-col items-center justify-center opacity-40" style="border-color: var(--border-subtle);">
                    <p class="text-[12px]">No prompts discovered</p>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="py-12 border border-dashed rounded-2xl flex flex-col items-center justify-center gap-3 opacity-40" style="border-color: var(--border-subtle);">
              <UIcon name="i-lucide-alert-circle" class="size-6" />
              <p class="text-[12px] text-center max-w-[200px]">Failed to connect to server or no capabilities discovered.</p>
            </div>
          </section>
        </div>
      </div>

      <!-- Right: Test -->
      <div class="w-[40%] flex flex-col">
        <div class="flex-1 min-h-0">
          <TestPanel :agent-slug="`mcp-${name}`" :agent-name="name" :is-draft="isDirty" />
        </div>
        <ExecutionInspector :tool-calls="toolCalls" :is-streaming="studioStreaming" />
      </div>
    </div>

    <!-- Delete confirmation -->
    <Teleport to="body">
      <div v-if="showDeleteConfirm" class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(0,0,0,0.4); backdrop-filter: blur(2px);">
        <div class="rounded-2xl p-6 max-w-sm w-full mx-4 space-y-4 shadow-xl" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
          <h3 class="text-[15px] font-semibold" style="color: var(--text-primary);">Delete MCP Server?</h3>
          <p class="text-[13px]" style="color: var(--text-secondary);">This will permanently delete the configuration for <span class="font-mono font-bold">{{ name }}</span> and cannot be undone.</p>
          <div class="flex gap-2 justify-end pt-2">
            <button class="px-3 py-1.5 rounded-lg text-[12px] font-medium hover-bg" style="color: var(--text-tertiary);" @click="showDeleteConfirm = false">Cancel</button>
            <button class="px-3 py-1.5 rounded-lg text-[12px] font-medium" style="background: var(--error); color: white;" @click="handleDelete">Delete Forever</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.field-input {
  background: var(--surface-base);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  border-radius: 0.5rem;
  padding: 0.6rem 0.8rem;
  transition: all 0.2s ease;
}
.field-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(229, 169, 62, 0.1);
}
.field-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: var(--surface-raised);
}

.accent-accent { accent-color: var(--accent); }
.hover-bg:hover { background: var(--surface-raised); }

.custom-scrollbar::-webkit-scrollbar { width: 6px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb { background: var(--border-subtle); border-radius: 3px; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--text-disabled); }
</style>
