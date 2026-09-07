<script setup lang="ts">
import type { Settings, AgentModel } from '~/types'
import { MODEL_OPTIONS } from '~/utils/models'

const { settings, loading, load, save } = useSettings()
const {
  skillImports,
  agentImports,
  loading: importsLoading,
  fetchImports: fetchGithubImports,
  checkUpdates,
  updateImport,
  removeImport,
} = useGithubImports()

const githubImports = computed(() => {
  return [
    ...(skillImports?.value || []).map(i => ({ ...i, type: 'skills' as const })),
    ...(agentImports?.value || []).map(i => ({ ...i, type: 'agents' as const }))
  ]
})

const toast = useToast()

const rawJson = ref('')
const saving = ref(false)
async function toggleLabs(on: boolean) {
  await save({ ...(settings.value ?? {}), agentManager: { ...((settings.value as any)?.agentManager ?? {}), labs: on } } as any)
}
/** The model every pipeline agent runs on; empty means each agent's own file decides. Applies to the next agent call. */
async function setAgentModel(value: string) {
  await save({ ...(settings.value ?? {}), agentManager: { ...((settings.value as any)?.agentManager ?? {}), agentModel: (value || undefined) as AgentModel | undefined } } as any)
  toast.add({ title: value ? `Pipeline agents will run on ${MODEL_OPTIONS.find(o => o.value === value)?.label ?? value}` : 'Each agent uses its own model again', color: 'success' })
}
/** Per-run caps for new runs. Blank returns to the default; a run that reaches its cap pauses and asks. */
async function setRunBudget(key: 'maxTokens' | 'maxMinutes', raw: string) {
  const current = (settings.value as any)?.agentManager?.runBudget ?? {}
  const value = Number(raw)
  const runBudget = { ...current, [key]: raw.trim() && value > 0 ? Math.round(value) : undefined }
  await save({ ...(settings.value ?? {}), agentManager: { ...((settings.value as any)?.agentManager ?? {}), runBudget } } as any)
  toast.add({ title: 'Run budget saved for new runs', color: 'success' })
}
const viewMode = ref<'structured' | 'raw'>('structured')
const showRemoveConfirm = ref(false)
const repoToRemove = ref<{ owner: string; repo: string; type: 'skills' | 'agents'; count: number } | null>(null)

onMounted(async () => {
  await load()
  syncRawJson()
})

onMounted(async () => {
  await Promise.all([
    fetchGithubImports('skills'),
    fetchGithubImports('agents')
  ])
})

async function onUpdateImport(owner: string, repo: string, type: 'skills' | 'agents') {
  try {
    await updateImport(owner, repo, type)
    toast.add({ title: 'Import updated', color: 'success' })
  } catch {
    toast.add({ title: 'Update failed', color: 'error' })
  }
}

async function onRemoveImport(owner: string, repo: string, type: 'skills' | 'agents') {
  const list = type === 'skills' ? skillImports : agentImports
  const entry = list.value.find(i => i.owner === owner && i.repo === repo)
  
  repoToRemove.value = {
    owner,
    repo,
    type,
    count: entry?.selectedItems?.length || 0
  }
  showRemoveConfirm.value = true
}

async function confirmRemove() {
  if (!repoToRemove.value) return
  const { owner, repo, type } = repoToRemove.value
  
  try {
    await removeImport(owner, repo, type)
    toast.add({ title: 'Import removed', color: 'success' })
  } catch {
    toast.add({ title: 'Remove failed', color: 'error' })
  } finally {
    showRemoveConfirm.value = false
    repoToRemove.value = null
  }
}

async function onCheckUpdates() {
  try {
    await Promise.all([
      checkUpdates('skills'),
      checkUpdates('agents')
    ])
    toast.add({ title: 'Update check complete', color: 'success' })
  } catch {
    toast.add({ title: 'Update check failed', color: 'error' })
  }
}

watch(settings, () => syncRawJson())

function syncRawJson() {
  if (settings.value) rawJson.value = JSON.stringify(settings.value, null, 2)
}

// ---- Structured field helpers ----

async function updateSetting(patch: Partial<Settings>) {
  if (!settings.value) return
  saving.value = true
  try {
    await save({ ...settings.value, ...patch })
    toast.add({ title: 'Settings saved', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Failed to save', description: e.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

async function toggleAlwaysThinking(enabled: boolean) {
  await updateSetting({ alwaysThinkingEnabled: enabled })
}

const TASKS_PICKER_DEFAULT_SECONDS = 60

/** Persist the /tasks-picker-infra lookback window. Rejects anything that is
 *  not a positive number rather than writing it: a window of 0 or NaN makes
 *  the command silently return nothing, which looks exactly like a quiet
 *  board. Clamped to a minimum of 1 second for the same reason. */
async function updateTasksPickerWindow(raw: string) {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1) return
  await updateSetting({ tasksPickerWindowSeconds: n })
}

async function togglePlugin(name: string, enabled: boolean) {
  if (!settings.value) return
  await updateSetting({
    enabledPlugins: {
      ...settings.value.enabledPlugins,
      [name]: enabled,
    },
  })
}

async function removePlugin(name: string) {
  if (!settings.value?.enabledPlugins) return
  const { [name]: _, ...rest } = settings.value.enabledPlugins as Record<string, boolean>
  await updateSetting({ enabledPlugins: rest })
}

// ---- Status line ----

const statusLineType = ref('')
const statusLineCommand = ref('')

const statusLineOptions = [
  { value: '', label: 'None', description: 'Disable the status line' },
  { value: 'command', label: 'Command', description: 'Run a bash command to get status' },
]

watch(settings, (val) => {
  if (val?.statusLine) {
    statusLineType.value = val.statusLine.type || ''
    statusLineCommand.value = val.statusLine.command || ''
  }
}, { immediate: true })

async function saveStatusLine() {
  if (!statusLineType.value && !statusLineCommand.value) {
    const { statusLine: _, ...rest } = settings.value || {}
    await updateSetting(rest as Settings)
  } else {
    await updateSetting({
      statusLine: {
        type: statusLineType.value,
        command: statusLineCommand.value,
      },
    })
  }
}

// ---- Hooks ----

const hooks = computed(() => {
  if (!settings.value?.hooks) return []
  return Object.entries(settings.value.hooks as Record<string, unknown[]>).map(([event, list]) => ({
    event,
    commands: Array.isArray(list) ? list : [],
  }))
})

const showAddHookModal = ref(false)
const newHookEvent = ref<string | undefined>('')
const newHookCommand = ref('')
const newHookMatcher = ref('')

const hookEventOptions = [
  { value: 'PreToolUse', label: 'Before Claude uses a tool', description: 'Triggered just before a tool is executed' },
  { value: 'PostToolUse', label: 'After Claude uses a tool', description: 'Triggered after a tool execution completes' },
  { value: 'Notification', label: 'When a notification is sent', description: 'Triggered when the system sends a notification' },
  { value: 'Stop', label: 'When Claude finishes', description: 'Triggered when the session finishes' },
  { value: 'SubagentStop', label: 'When a sub-agent finishes', description: 'Triggered when a background sub-agent finishes' },
]

const hookEventLabels: Record<string, string> = {
  PreToolUse: 'Before Claude uses a tool',
  PostToolUse: 'After Claude uses a tool',
  Notification: 'When a notification is sent',
  Stop: 'When Claude finishes',
  SubagentStop: 'When a sub-agent finishes',
}

async function addHook() {
  if (!newHookEvent.value || !newHookCommand.value) return
  const currentHooks = (settings.value?.hooks || {}) as Record<string, unknown[]>
  const eventHooks = [...(currentHooks[newHookEvent.value] || [])]

  const hookEntry: Record<string, string> = { command: newHookCommand.value }
  if (newHookMatcher.value) hookEntry.matcher = newHookMatcher.value

  eventHooks.push(hookEntry)

  await updateSetting({
    hooks: { ...currentHooks, [newHookEvent.value]: eventHooks },
  })

  newHookEvent.value = ''
  newHookCommand.value = ''
  newHookMatcher.value = ''
  showAddHookModal.value = false
}

async function removeHook(event: string, index: number) {
  const currentHooks = (settings.value?.hooks || {}) as Record<string, unknown[]>
  const eventHooks = [...(currentHooks[event] || [])]
  eventHooks.splice(index, 1)

  const updatedHooks = { ...currentHooks }
  if (eventHooks.length === 0) {
    delete updatedHooks[event]
  } else {
    updatedHooks[event] = eventHooks
  }

  await updateSetting({ hooks: Object.keys(updatedHooks).length > 0 ? updatedHooks : undefined })
}

// ---- Raw JSON ----

async function saveRaw() {
  saving.value = true
  try {
    const parsed = JSON.parse(rawJson.value)
    await save(parsed)
    toast.add({ title: 'Settings saved', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Invalid JSON', description: e.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

// Cmd+S
if (import.meta.client) {
  const onKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      if (viewMode.value === 'raw') saveRaw()
    }
  }
  onMounted(() => document.addEventListener('keydown', onKeydown))
  onUnmounted(() => document.removeEventListener('keydown', onKeydown))
}

const plugins = computed(() => {
  if (!settings.value?.enabledPlugins) return []
  return Object.entries(settings.value.enabledPlugins).map(([name, enabled]) => ({
    name,
    enabled: Boolean(enabled),
  }))
})

const charCount = computed(() => rawJson.value.length)
const lineCount = computed(() => rawJson.value.split('\n').length)
</script>

<template>
  <div>
    <PageHeader title="Settings">
      <template #right>
        <button
          class="text-[12px] px-2 py-1 rounded focus-ring text-label"
          style="background: var(--surface-raised); border: 1px solid var(--border-default);"
          @click="viewMode = viewMode === 'structured' ? 'raw' : 'structured'"
        >
          {{ viewMode === 'structured' ? 'Raw JSON' : 'Structured' }}
        </button>
        <UButton v-if="viewMode === 'raw'" label="Save" icon="i-lucide-save" size="sm" :loading="saving" @click="saveRaw" />
      </template>
    </PageHeader>

    <div v-if="loading" class="flex justify-center py-16">
      <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-meta" />
    </div>

    <!-- Structured view -->
    <div v-else-if="viewMode === 'structured'" class="px-6 py-4 space-y-6">

      <!-- General -->
      <div
        class="rounded-xl p-5 space-y-4 bg-card"
      >
        <h3 class="text-section-title">General</h3>

        <div class="space-y-4">
          <!-- Always Thinking toggle -->
          <div class="flex items-start justify-between gap-4 py-3">
            <div>
              <div class="text-[13px] font-medium">Labs pages</div>
              <div class="text-[12px] mt-0.5 text-label">
                Show Graph, Explore and Output styles in the sidebar. They work, but are not part of the daily set yet.
              </div>
            </div>
            <label class="field-toggle">
              <input
                type="checkbox"
                :checked="settings?.agentManager?.labs === true"
                @change="toggleLabs(($event.target as HTMLInputElement).checked)"
              />
              <span class="field-toggle__track">
                <span class="field-toggle__thumb" />
              </span>
            </label>
          </div>
          <div class="flex items-start justify-between gap-4 py-3">
            <div>
              <div class="text-[13px] font-medium">Model for pipeline agents</div>
              <div class="text-[12px] mt-0.5 text-label">
                Every agent call in a run uses this model when set, monitors included, whatever the agent's own file says. Default lets each agent decide: the fix and test agents ship on Opus, the rest on Sonnet. Fable is the strongest and carries no list price here, so its steps show as unpriced.
              </div>
            </div>
            <select
              class="field-input w-44 text-[12px] shrink-0" aria-label="Model for pipeline agents"
              :value="settings?.agentManager?.agentModel ?? ''"
              @change="setAgentModel(($event.target as HTMLSelectElement).value)"
            >
              <option value="">Default (each agent's own)</option>
              <option v-for="o in MODEL_OPTIONS.filter(o => o.value)" :key="o.value" :value="o.value">{{ o.label }} · {{ o.desc }}</option>
            </select>
          </div>
          <div class="flex items-start justify-between gap-4 py-3">
            <div>
              <div class="text-[13px] font-medium">Run budget</div>
              <div class="text-[12px] mt-0.5 text-label">
                Caps for each new run. When a run reaches one it pauses and asks whether to continue with another allowance. Defaults 8,000,000 tokens and 180 minutes; an AGENT_RUN_MAX_TOKENS or AGENT_RUN_MAX_MINUTES variable on the instance overrides these.
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <input
                type="number" min="1" step="100000" class="field-input w-36 text-[12px]" placeholder="8000000" aria-label="Max tokens per run"
                :value="settings?.agentManager?.runBudget?.maxTokens ?? ''"
                @change="setRunBudget('maxTokens', ($event.target as HTMLInputElement).value)"
              />
              <span class="text-[11px] text-label">tokens</span>
              <input
                type="number" min="1" step="10" class="field-input w-24 text-[12px]" placeholder="180" aria-label="Max minutes per run"
                :value="settings?.agentManager?.runBudget?.maxMinutes ?? ''"
                @change="setRunBudget('maxMinutes', ($event.target as HTMLInputElement).value)"
              />
              <span class="text-[11px] text-label">min</span>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <div>
              <div class="text-[13px] font-medium">Always Thinking</div>
              <div class="text-[12px] mt-0.5 text-label">
                When enabled, Claude takes more time to reason through complex problems before responding. Better answers, but slower and uses more resources.
              </div>
            </div>
            <label class="field-toggle">
              <input
                type="checkbox"
                :checked="settings?.alwaysThinkingEnabled"
                @change="toggleAlwaysThinking(($event.target as HTMLInputElement).checked)"
              />
              <span class="field-toggle__track">
                <span class="field-toggle__thumb" />
              </span>
            </label>
          </div>

          <!-- /tasks-picker-infra lookback window -->
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-[13px] font-medium">Task picker window</div>
              <div class="text-[12px] mt-0.5 text-label">
                How far back <code>/tasks-picker-infra</code> looks for newly raised DEVOPS issues.
                Jira cannot filter below one minute, so the command queries the window rounded up to
                whole minutes and applies the exact seconds itself.
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <input
                type="number"
                min="1"
                class="w-24 text-[13px] px-2 py-1 rounded-md bg-card border border-subtle text-right tabular-nums"
                data-testid="tasks-picker-window"
                :value="settings?.tasksPickerWindowSeconds ?? TASKS_PICKER_DEFAULT_SECONDS"
                @change="updateTasksPickerWindow(($event.target as HTMLInputElement).value)"
              />
              <span class="text-[12px] text-label">seconds</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Status Line -->
      <div
        class="rounded-xl p-5 space-y-4 bg-card"
      >
        <h3 class="text-section-title">Status Line</h3>
        <p class="text-[12px] text-meta">
          Shows custom information in Claude Code's interface. Use a bash command to display dynamic content.
        </p>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="field-group">
            <label class="field-label">Type</label>
            <USelectDropdown v-model="statusLineType" :options="statusLineOptions" />
          </div>
          <div class="field-group">
            <label class="field-label">Command</label>
            <input v-model="statusLineCommand" class="field-input" placeholder="echo 'status...'" />
          </div>
        </div>

        <div class="flex justify-end">
          <UButton label="Save Status Line" size="sm" variant="soft" :loading="saving" @click="saveStatusLine" />
        </div>
      </div>

      <!-- Plugins -->
      <div
        class="rounded-xl p-5 space-y-4 bg-card"
      >
        <h3 class="text-section-label flex items-center gap-2">
          Extensions
          <HelpTip title="Managing extensions" body="Enable or disable extensions here. Install new ones via the Claude Code CLI." />
        </h3>
        <div v-if="plugins.length === 0" class="text-[13px] text-label">
          No plugins configured.
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="plugin in plugins"
            :key="plugin.name"
            class="flex items-center justify-between py-2 px-3 rounded-lg"
            style="background: var(--input-bg);"
          >
            <span class="font-mono text-[12px] text-body">{{ plugin.name }}</span>
            <div class="flex items-center gap-3">
              <label class="field-toggle">
                <input
                  type="checkbox"
                  :checked="plugin.enabled"
                  @change="togglePlugin(plugin.name, ($event.target as HTMLInputElement).checked)"
                />
                <span class="field-toggle__track">
                  <span class="field-toggle__thumb" />
                </span>
              </label>
              <button
                class="p-1.5 -m-0.5 rounded focus-ring text-meta"
                aria-label="Remove plugin from settings"
                @click="removePlugin(plugin.name)"
              >
                <UIcon name="i-lucide-x" class="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- GitHub Imports -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <div class="flex items-center justify-between">
          <h3 class="text-section-title">GitHub Imports</h3>
          <UButton
            v-if="githubImports.length > 0"
            label="Check for updates"
            icon="i-lucide-refresh-cw"
            size="xs"
            variant="soft"
            @click="onCheckUpdates"
          />
        </div>
        <p class="text-[12px] text-meta">
          Manage repositories imported from GitHub.
        </p>

        <div v-if="githubImports.length === 0" class="text-[13px] text-label">
          No GitHub imports. Use the Explore page to import skills from GitHub.
        </div>

        <div v-else class="space-y-2">
          <div
            v-for="entry in githubImports"
            :key="`${entry.type}/${entry.owner}/${entry.repo}`"
            class="flex items-center justify-between py-2 px-3 rounded-lg"
            style="background: var(--input-bg);"
          >
            <div class="flex-1 min-w-0 flex items-center gap-2">
              <span class="font-mono text-[12px] text-body">{{ entry.owner }}/{{ entry.repo }}</span>
              <span 
                class="text-[9px] font-mono px-1.5 py-px rounded-full uppercase" 
                style="background: var(--badge-subtle-bg); color: var(--text-tertiary); border: 1px solid var(--border-subtle);"
              >
                {{ entry.type }}
              </span>
              <span class="text-[10px] text-meta ml-1">{{ entry.selectedItems?.length || 0 }} items</span>
            </div>
            <div class="flex items-center gap-2">
              <span
                v-if="entry.currentSha !== entry.remoteSha"
                class="text-[10px] font-medium px-2 py-0.5 rounded-full"
                style="background: rgba(59, 130, 246, 0.1); color: var(--info, #3b82f6);"
              >
                Update available
              </span>
              <UButton
                v-if="entry.currentSha !== entry.remoteSha"
                label="Update"
                size="xs"
                variant="soft"
                @click="onUpdateImport(entry.owner, entry.repo, entry.type)"
              />
              <button
                class="p-1.5 -m-0.5 rounded focus-ring text-meta hover:text-error transition-colors"
                aria-label="Remove import"
                @click="onRemoveImport(entry.owner, entry.repo, entry.type)"
              >
                <UIcon name="i-lucide-trash-2" class="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Hooks -->
      <div
        class="rounded-xl p-5 space-y-4 bg-card"
      >
        <div class="flex items-center justify-between">
          <h3 class="text-section-title">Automations</h3>
          <UButton label="Add Automation" icon="i-lucide-plus" size="xs" variant="soft" @click="() => { showAddHookModal = true }" />
        </div>
        <p class="text-[12px] text-meta">
          Run shell commands automatically when certain events happen in Claude Code.
        </p>

        <div v-if="hooks.length === 0" class="text-[13px] text-label">
          No automations configured.
        </div>

        <div v-else class="space-y-3">
          <div v-for="hook in hooks" :key="hook.event">
            <div class="flex items-center gap-2 mb-1.5">
              <UIcon name="i-lucide-webhook" class="size-3.5 text-meta" />
              <span class="text-[12px] font-medium text-body">{{ hookEventLabels[hook.event] || hook.event }}</span>
              <span class="font-mono text-[10px] text-meta">{{ hook.commands.length }}</span>
            </div>
            <div class="ml-5 space-y-1">
              <div
                v-for="(cmd, idx) in hook.commands"
                :key="idx"
                class="flex items-center justify-between py-1.5 px-3 rounded-lg group"
                style="background: var(--input-bg);"
              >
                <div class="flex-1 min-w-0">
                  <span class="font-mono text-[12px] truncate block text-label">
                    {{ typeof cmd === 'string' ? cmd : (cmd as any).command || JSON.stringify(cmd) }}
                  </span>
                  <span
                    v-if="typeof cmd === 'object' && (cmd as any).matcher"
                    class="font-mono text-[10px] block mt-0.5 text-meta"
                  >
                    matcher: {{ (cmd as any).matcher }}
                  </span>
                </div>
                <button
                  class="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-1.5 -m-0.5 rounded focus-ring"
                  style="color: var(--error);"
                  aria-label="Delete hook"
                  @click="removeHook(hook.event, idx)"
                >
                  <UIcon name="i-lucide-trash-2" class="size-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Raw JSON editor -->
    <div v-else class="px-6 py-4">
      <div
        class="rounded-xl overflow-hidden"
        style="border: 1px solid var(--border-subtle);"
      >
        <div class="flex items-center justify-between px-4 py-2.5" style="background: var(--surface-raised); border-bottom: 1px solid var(--border-subtle);">
          <h3 class="text-section-title">settings.json</h3>
          <div class="flex items-center gap-3">
            <span class="font-mono text-[10px] text-meta">
              {{ lineCount }} lines
            </span>
            <span class="font-mono text-[10px] text-meta">
              {{ charCount.toLocaleString() }} chars
            </span>
          </div>
        </div>
        <textarea
          v-model="rawJson"
          class="editor-textarea"
          style="min-height: 600px;"
          spellcheck="false"
        />
      </div>
    </div>

    <!-- Add Hook Modal -->
    <UModal v-model:open="showAddHookModal">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">Add Automation</h3>
          <p class="text-[12px] leading-relaxed text-label">
            Run a shell command automatically when a specific event happens.
          </p>

          <div class="field-group">
            <label class="field-label" data-required>When this happens</label>
            <USelectDropdown v-model="newHookEvent" :options="hookEventOptions" placeholder="Select an event..." />
          </div>

          <div class="field-group">
            <label class="field-label" data-required>Run this command</label>
            <input v-model="newHookCommand" class="field-input" placeholder="e.g., bash -c 'echo done'" />
            <span class="field-hint">The shell command that will be executed</span>
          </div>

          <div class="field-group">
            <label class="field-label">Only for specific tools</label>
            <input v-model="newHookMatcher" class="field-input" placeholder="Leave blank for all (optional)" />
            <span class="field-hint">Only trigger when a specific tool is used (e.g., "Write" or "Bash")</span>
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showAddHookModal = false }" />
            <UButton
              label="Add"
              size="sm"
              :disabled="!newHookEvent || !newHookCommand"
              @click="addHook"
            />
          </div>
        </div>
      </template>
    </UModal>

    <!-- Delete Confirmation Modal -->
    <UModal v-model:open="showRemoveConfirm">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <div class="flex items-center gap-3">
            <div class="size-10 rounded-full flex items-center justify-center shrink-0" style="background: rgba(239, 68, 68, 0.1);">
              <UIcon name="i-lucide-alert-triangle" class="size-6 text-error" />
            </div>
            <div>
              <h3 class="text-[15px] font-semibold text-primary">Remove Repository?</h3>
              <p class="text-[12px] text-label mt-1">This action cannot be undone.</p>
            </div>
          </div>

          <div class="rounded-lg p-3 border" style="background: var(--surface-base); border-color: var(--border-subtle);">
            <p class="text-[13px] leading-relaxed">
              Removing <span class="font-mono font-bold">{{ repoToRemove?.owner }}/{{ repoToRemove?.repo }}</span> will delete the local clone and unlink 
              <strong class="text-error">{{ repoToRemove?.count }} {{ repoToRemove?.type }}</strong> currently installed on your system.
            </p>
          </div>

          <div class="flex justify-end gap-3 pt-2">
            <UButton
              label="Cancel"
              variant="ghost"
              color="neutral"
              size="sm"
              @click="() => { showRemoveConfirm = false }"
            />
            <UButton
              label="Confirm Delete"
              color="error"
              size="sm"
              @click="confirmRemove"
            />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
