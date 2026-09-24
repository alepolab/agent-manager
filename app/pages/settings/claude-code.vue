<script setup lang="ts">
import type { Settings } from '~/types'
import { errorToast } from '~/utils/errorToast'

/**
 * The keys Claude Code itself reads out of settings.json, plus the raw editor
 * over that file.
 *
 * The raw view lives here and only here. It edits the whole file, which is
 * what this route is already about; the channels and GitHub imports on
 * /settings/integrations are backed by other stores entirely and were never in
 * it, though the old single-page toggle hid them as though they were.
 */
const { settings, loading, load, save } = useSettings()
const { can } = useUser()
const toast = useToast()

const saving = ref(false)
const viewMode = ref<'structured' | 'raw'>('structured')
const rawJson = ref('')

function syncRawJson() {
  if (settings.value) rawJson.value = JSON.stringify(settings.value, null, 2)
}
watch(settings, () => syncRawJson())

async function updateSetting(patch: Partial<Settings>) {
  if (!settings.value) return
  saving.value = true
  try {
    await save({ ...settings.value, ...patch })
    toast.add({ title: 'Settings saved', color: 'success' })
  } catch (e) {
    toast.add(errorToast('Failed to save', e))
  } finally {
    saving.value = false
  }
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

// ---- Extensions ----

const plugins = computed(() => {
  if (!settings.value?.enabledPlugins) return []
  return Object.entries(settings.value.enabledPlugins).map(([name, enabled]) => ({
    name,
    enabled: Boolean(enabled),
  }))
})

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
  } catch (e) {
    toast.add(errorToast('Invalid JSON', e))
  } finally {
    saving.value = false
  }
}

// Cmd+S
if (import.meta.client) {
  const onKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      if (viewMode.value === 'raw' && can('configure')) saveRaw()
    }
  }
  onMounted(() => document.addEventListener('keydown', onKeydown))
  onUnmounted(() => document.removeEventListener('keydown', onKeydown))
}

const charCount = computed(() => rawJson.value.length)
const lineCount = computed(() => rawJson.value.split('\n').length)

// Assigning `settings` rewrites the raw editor and the status-line inputs, so a
// background load waits while either holds input that has not been saved.
const rawJsonEdited = () => !!settings.value && rawJson.value !== JSON.stringify(settings.value, null, 2)
const statusLineEdited = () => statusLineType.value !== (settings.value?.statusLine?.type || '')
  || statusLineCommand.value !== (settings.value?.statusLine?.command || '')

onMounted(async () => {
  await load()
  syncRawJson()
})
useAutoRefresh(() => (saving.value || rawJsonEdited() || statusLineEdited() ? null : load({ silent: true })))
</script>

<template>
  <div>
    <PageHeader title="Settings">
      <template #right>
        <ReadOnlyBadge v-if="!can('configure')" reason="changing these settings" />
        <button
          class="t-small px-2 py-1 rounded focus-ring text-label"
          style="background: var(--surface-raised); border: 1px solid var(--border-default);"
          @click="viewMode = viewMode === 'structured' ? 'raw' : 'structured'"
        >
          {{ viewMode === 'structured' ? 'Raw JSON' : 'Structured' }}
        </button>
        <UButton v-if="viewMode === 'raw' && can('configure')" label="Save" icon="i-lucide-save" size="sm" :loading="saving" @click="saveRaw" />
      </template>
    </PageHeader>
    <SettingsNav />

    <div v-if="loading && !settings" class="flex justify-center py-16">
      <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-meta" />
    </div>

    <!-- Structured view -->
    <div v-else-if="viewMode === 'structured'" class="px-6 py-4 space-y-6">
      <!-- Status Line -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title flex items-center gap-2">Status Line <ScopeChip scope="instance" /></h3>
        <p class="t-small text-meta">
          Shows custom information in Claude Code's interface. Use a bash command to display dynamic content.
        </p>

        <div v-if="can('configure')" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="field-group">
            <label class="field-label">Type</label>
            <USelectDropdown v-model="statusLineType" :options="statusLineOptions" />
          </div>
          <div class="field-group">
            <label class="field-label">Command</label>
            <input v-model="statusLineCommand" class="field-input" placeholder="echo 'status...'" />
          </div>
        </div>
        <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4 t-small">
          <div><span class="text-label">Type</span><div style="color: var(--text-primary);">{{ settings?.statusLine?.type || 'None' }}</div></div>
          <div><span class="text-label">Command</span><div class="font-mono" style="color: var(--text-primary);">{{ settings?.statusLine?.command || '—' }}</div></div>
        </div>

        <div v-if="can('configure')" class="flex justify-end">
          <UButton label="Save Status Line" size="sm" variant="soft" :loading="saving" @click="saveStatusLine" />
        </div>
      </div>

      <!-- Extensions -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-label flex items-center gap-2">
          Extensions
          <ScopeChip scope="instance" />
          <HelpTip title="Managing extensions" body="Enable or disable extensions here. Install new ones via the Claude Code CLI." />
        </h3>
        <div v-if="plugins.length === 0" class="t-ui text-label">
          No plugins configured.
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="plugin in plugins"
            :key="plugin.name"
            class="flex items-center justify-between py-2 px-3 rounded-lg"
            style="background: var(--input-bg);"
          >
            <span class="font-mono t-small text-body">{{ plugin.name }}</span>
            <div class="flex items-center gap-3">
              <label v-if="can('configure')" class="field-toggle">
                <input
                  type="checkbox"
                  :checked="plugin.enabled"
                  @change="togglePlugin(plugin.name, ($event.target as HTMLInputElement).checked)"
                />
                <span class="field-toggle__track">
                  <span class="field-toggle__thumb" />
                </span>
              </label>
              <span v-else class="badge" :class="plugin.enabled ? 'badge-success' : 'badge-subtle'">{{ plugin.enabled ? 'On' : 'Off' }}</span>
              <button
                v-if="can('configure')"
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

      <!-- Automations (hooks) -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <div class="flex items-center justify-between">
          <h3 class="text-section-title flex items-center gap-2">Automations <ScopeChip scope="instance" /></h3>
          <UButton v-if="can('configure')" label="Add Automation" icon="i-lucide-plus" size="xs" variant="soft" @click="() => { showAddHookModal = true }" />
        </div>
        <p class="t-small text-meta">
          Run shell commands automatically when certain events happen in Claude Code. Not to be confused with the
          Automations on the Instance tab, which are boot-time switches read from the environment.
        </p>

        <div v-if="hooks.length === 0" class="t-ui text-label">
          No automations configured.
        </div>

        <div v-else class="space-y-3">
          <div v-for="hook in hooks" :key="hook.event">
            <div class="flex items-center gap-2 mb-1.5">
              <UIcon name="i-lucide-webhook" class="size-3.5 text-meta" />
              <span class="t-small font-medium text-body">{{ hookEventLabels[hook.event] || hook.event }}</span>
              <span class="font-mono t-small text-meta">{{ hook.commands.length }}</span>
            </div>
            <div class="ml-5 space-y-1">
              <div
                v-for="(cmd, idx) in hook.commands"
                :key="idx"
                class="flex items-center justify-between py-1.5 px-3 rounded-lg group"
                style="background: var(--input-bg);"
              >
                <div class="flex-1 min-w-0">
                  <span class="font-mono t-small truncate block text-label">
                    {{ typeof cmd === 'string' ? cmd : (cmd as any).command || JSON.stringify(cmd) }}
                  </span>
                  <span
                    v-if="typeof cmd === 'object' && (cmd as any).matcher"
                    class="font-mono t-small block mt-0.5 text-meta"
                  >
                    matcher: {{ (cmd as any).matcher }}
                  </span>
                </div>
                <button
                  v-if="can('configure')"
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
      <div class="rounded-xl overflow-hidden" style="border: 1px solid var(--border-subtle);">
        <div class="flex items-center justify-between px-4 py-2.5" style="background: var(--surface-raised); border-bottom: 1px solid var(--border-subtle);">
          <h3 class="text-section-title">settings.json</h3>
          <div class="flex items-center gap-3">
            <span class="font-mono t-small text-meta">{{ lineCount }} lines</span>
            <span class="font-mono t-small text-meta">{{ charCount.toLocaleString('en-US') }} chars</span>
          </div>
        </div>
        <textarea
          v-model="rawJson"
          class="editor-textarea"
          style="min-height: 600px;"
          spellcheck="false"
          :readonly="!can('configure')"
        />
      </div>
    </div>

    <!-- Add Hook Modal -->
    <UModal v-model:open="showAddHookModal">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">Add Automation</h3>
          <p class="t-small leading-relaxed text-label">
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
  </div>
</template>
