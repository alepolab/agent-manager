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
/**
 * What this instance is configured to do, read-only. `pinned` is the part that
 * changes how the form behaves: a field an env var is overriding is disabled
 * and says so, because until now it accepted a number, toasted "Settings
 * saved", and then every run used the variable's value instead.
 */
interface InstanceInfo {
  pinned: Record<string, string>
  automations: { name: string, envVar: string, enabled: boolean, detail?: string }[]
  paths: { claudeDir: string, agentRunsDir: string, workspaceRoot: string, usersDir: string }
  secrets: { name: string, set: boolean }[]
  identity: { authDisabled: boolean, githubOrg: string | null, managerUrl: string | null, clientIdSet: boolean }
}
const instance = ref<InstanceInfo | null>(null)
onMounted(async () => {
  try { instance.value = await $fetch<InstanceInfo>('/api/instance') }
  catch { instance.value = null }
})
/** The value an env var is forcing on this field, or undefined when the saved setting wins. */
const pinnedBy = (envVar: string) => instance.value?.pinned?.[envVar]
const pinnedNote = (envVar: string) => {
  const value = pinnedBy(envVar)
  return value ? `Pinned by ${envVar}=${value} on this instance; the value here is ignored until that is unset.` : ''
}

const jiraSettings = computed(() => (settings.value as any)?.agentManager?.jira ?? {})
async function setJira(key: 'postEnabled' | 'baseUrl' | 'defaultProject' | 'forVisName', value: string | boolean) {
  const agentManager = (settings.value as any)?.agentManager ?? {}
  const next = typeof value === 'string' ? (value.trim() || undefined) : value || undefined
  // A base URL that is not a URL reaches every Jira call as a broken host, so
  // it is refused here the same silent way a bad tasks-picker window is.
  if (key === 'baseUrl' && typeof next === 'string') {
    try { if (new URL(next).protocol !== 'https:') return } catch { return }
  }
  await save({ ...(settings.value ?? {}), agentManager: { ...agentManager, jira: { ...agentManager.jira, [key]: next } } } as any)
  toast.add({ title: 'Jira settings saved', color: 'success' })
}

async function setRunBudget(key: 'maxTokens' | 'maxMinutes', raw: string) {
  const current = (settings.value as any)?.agentManager?.runBudget ?? {}
  const value = Number(raw)
  const runBudget = { ...current, [key]: raw.trim() && value > 0 ? Math.round(value) : undefined }
  await save({ ...(settings.value ?? {}), agentManager: { ...((settings.value as any)?.agentManager ?? {}), runBudget } } as any)
  toast.add({ title: 'Run budget saved for new runs', color: 'success' })
}
/**
 * Notification channels. Their own API, not part of settings.json: the webhook
 * is a secret and the config tree holds none (server/utils/channels.ts).
 */
type ChannelKind = 'teams' | 'slack' | 'email'
interface PublicChannel { name: string, kind: ChannelKind, hasUrl: boolean, host?: string, to?: string[], updatedAt: number, updatedBy?: string }
interface PublicSmtp { host: string, port: number, secure?: boolean, user?: string, from: string, hasPassword: boolean }
const channels = ref<PublicChannel[]>([])
const channelsError = ref('')
const newChannelName = ref('')
const newChannelKind = ref<ChannelKind>('teams')
const newChannelUrl = ref('')
const newChannelTo = ref('')
const savingChannel = ref(false)
const testing = ref('')

/** The one relay every email channel sends through. Shown only when an email
 *  channel exists or is being added - an instance that notifies over webhooks
 *  has no use for it. */
const smtp = ref<PublicSmtp>({ host: '', port: 587, secure: false, user: '', from: '', hasPassword: false })
const smtpPassword = ref('')
const savingSmtp = ref(false)
const needsSmtp = computed(() => newChannelKind.value === 'email' || channels.value.some(c => c.kind === 'email'))

/** What a row sends to: a webhook host, or the people on an email channel. */
function channelTarget(c: PublicChannel): string {
  if (c.kind === 'email') return (c.to ?? []).join(', ') || 'no recipients'
  return c.host ?? 'stored'
}

/** The relay as last loaded or saved, so a background refresh can tell whether the form holds edits. */
let loadedSmtp = JSON.stringify(smtp.value)
const smtpEdited = () => !!smtpPassword.value || JSON.stringify(smtp.value) !== loadedSmtp

async function loadChannels({ keepSmtpEdits = false } = {}) {
  try {
    channels.value = (await $fetch<{ channels: PublicChannel[] }>('/api/channels')).channels
    channelsError.value = ''
    const s = (await $fetch<{ smtp: PublicSmtp | null }>('/api/smtp')).smtp
    if (s && !(keepSmtpEdits && smtpEdited())) {
      smtp.value = s
      loadedSmtp = JSON.stringify(s)
    }
  } catch (e: unknown) {
    channelsError.value = e instanceof Error ? e.message : 'Could not load channels'
  }
}

async function saveSmtpSettings() {
  savingSmtp.value = true
  try {
    smtp.value = await $fetch<PublicSmtp>('/api/smtp', {
      method: 'PUT',
      body: { ...smtp.value, password: smtpPassword.value },
    })
    loadedSmtp = JSON.stringify(smtp.value)
    smtpPassword.value = ''
    toast.add({ title: 'SMTP relay saved', color: 'success' })
  } catch (e: unknown) {
    toast.add({ title: (e as { data?: { message?: string } })?.data?.message ?? 'Could not save the relay', color: 'error' })
  } finally {
    savingSmtp.value = false
  }
}

async function saveChannel() {
  savingChannel.value = true
  try {
    await $fetch(`/api/channels/${encodeURIComponent(newChannelName.value.trim())}`, {
      method: 'PUT',
      body: { kind: newChannelKind.value, url: newChannelUrl.value, to: newChannelTo.value },
    })
    newChannelUrl.value = ''
    newChannelTo.value = ''
    newChannelName.value = ''
    await loadChannels()
    toast.add({ title: 'Channel saved', color: 'success' })
  } catch (e: unknown) {
    toast.add({ title: (e as { data?: { message?: string } })?.data?.message ?? 'Could not save the channel', color: 'error' })
  } finally {
    savingChannel.value = false
  }
}

async function removeChannel(name: string) {
  try {
    await $fetch(`/api/channels/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await loadChannels()
    toast.add({ title: `Removed "${name}"`, color: 'success' })
  } catch (e: unknown) {
    toast.add({ title: (e as { data?: { message?: string } })?.data?.message ?? 'Could not remove the channel', color: 'error' })
  }
}

/** Proves a webhook works now, rather than on the escalation branch at 2am. */
async function testChannel(name: string) {
  testing.value = name
  try {
    const res = await $fetch<{ ok: boolean, message: string }>(`/api/channels/${encodeURIComponent(name)}/test`, { method: 'POST' })
    toast.add({ title: res.message, color: res.ok ? 'success' : 'error' })
  } catch (e: unknown) {
    toast.add({ title: (e as { data?: { message?: string } })?.data?.message ?? 'Could not reach the channel', color: 'error' })
  } finally {
    testing.value = ''
  }
}

onMounted(() => loadChannels())

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

// Assigning `settings` rewrites the raw JSON editor and the status-line inputs (see the watchers below),
// so a background load waits while either holds input that has not been saved.
const rawJsonEdited = () => !!settings.value && rawJson.value !== JSON.stringify(settings.value, null, 2)
const statusLineEdited = () => statusLineType.value !== (settings.value?.statusLine?.type || '')
  || statusLineCommand.value !== (settings.value?.statusLine?.command || '')
useAutoRefresh(() => Promise.all([
  saving.value || rawJsonEdited() || statusLineEdited() ? null : load({ silent: true }),
  loadChannels({ keepSmtpEdits: true }),
]))
useAutoRefresh(() => Promise.all([
  fetchGithubImports('skills', { silent: true }),
  fetchGithubImports('agents', { silent: true }),
]), { interval: 0 })

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
            <div class="min-w-0 flex-1 max-w-2xl">
              <div class="text-[13px] font-medium">Model for pipeline agents</div>
              <div class="text-[12px] mt-0.5 text-label leading-relaxed">
                Runs every pipeline agent, monitors included, on one model, overriding each agent's own choice. Default keeps those choices: Opus for the fix and test agents, Sonnet for the rest. Fable is the strongest; its steps show as unpriced, since it has no list price here.
              </div>
            </div>
            <!-- field-input is full-width by design; these controls sit beside their text, so the width is pinned here. -->
            <select
              class="field-input text-[12px]" style="width: 16rem; flex: none;" aria-label="Model for pipeline agents"
              :value="settings?.agentManager?.agentModel ?? ''"
              @change="setAgentModel(($event.target as HTMLSelectElement).value)"
            >
              <option value="">Default (each agent's own)</option>
              <option v-for="o in MODEL_OPTIONS.filter(o => o.value)" :key="o.value" :value="o.value">{{ o.label }} · {{ o.desc }}</option>
            </select>
          </div>
          <div class="flex items-start justify-between gap-4 py-3">
            <div class="min-w-0 flex-1 max-w-2xl">
              <div class="text-[13px] font-medium">Run budget</div>
              <div class="text-[12px] mt-0.5 text-label leading-relaxed">
                Caps for each new run; when one is reached the run pauses and asks whether to continue with a fresh allowance. Defaults are 8,000,000 tokens and 180 minutes.
              </div>
              <div v-if="pinnedBy('AGENT_RUN_MAX_TOKENS')" class="text-[12px] mt-1" style="color: var(--warning);">{{ pinnedNote('AGENT_RUN_MAX_TOKENS') }}</div>
              <div v-if="pinnedBy('AGENT_RUN_MAX_MINUTES')" class="text-[12px] mt-1" style="color: var(--warning);">{{ pinnedNote('AGENT_RUN_MAX_MINUTES') }}</div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <input
                type="number" min="1" step="100000" class="field-input text-[12px]" style="width: 9rem; flex: none;" placeholder="8000000" aria-label="Max tokens per run"
                :value="settings?.agentManager?.runBudget?.maxTokens ?? ''"
                :disabled="!!pinnedBy('AGENT_RUN_MAX_TOKENS')" :title="pinnedNote('AGENT_RUN_MAX_TOKENS')"
                @change="setRunBudget('maxTokens', ($event.target as HTMLInputElement).value)"
              />
              <span class="text-[11px] text-label">tokens</span>
              <input
                type="number" min="1" step="10" class="field-input text-[12px]" style="width: 6rem; flex: none;" placeholder="180" aria-label="Max minutes per run"
                :value="settings?.agentManager?.runBudget?.maxMinutes ?? ''"
                :disabled="!!pinnedBy('AGENT_RUN_MAX_MINUTES')" :title="pinnedNote('AGENT_RUN_MAX_MINUTES')"
                @change="setRunBudget('maxMinutes', ($event.target as HTMLInputElement).value)"
              />
              <span class="text-[11px] text-label">min</span>
            </div>
          </div>
          <div class="flex items-center justify-between gap-4">
            <div class="min-w-0 flex-1 max-w-2xl">
              <div class="text-[13px] font-medium">Always Thinking</div>
              <div class="text-[12px] mt-0.5 text-label leading-relaxed">
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
            <div class="min-w-0 flex-1 max-w-2xl">
              <div class="text-[13px] font-medium">Task picker window</div>
              <div class="text-[12px] mt-0.5 text-label leading-relaxed">
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

      <!-- Jira -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title">Jira</h3>
        <p class="text-[12px] text-meta">
          The host and the posting gate for this instance. The API token is not here and never will be: it is
          per-developer and stored encrypted outside the config tree — set yours on
          <NuxtLink to="/profile" class="underline focus-ring">your profile</NuxtLink>. An environment variable
          set on the instance overrides anything saved here.
        </p>

        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0 flex-1 max-w-2xl">
            <div class="text-[13px] font-medium">Post outcomes to Jira</div>
            <div class="text-[12px] mt-0.5 text-label leading-relaxed">
              Off by default. Every run writes the comment it would post to its own <code>jira-comment.json</code>
              artifact either way, so this decides where that comment goes, never whether one is produced.
              <code>JIRA_POST_ENABLED=0</code> on the instance pins it off for everyone.
            </div>
            <div v-if="pinnedBy('JIRA_POST_ENABLED')" class="text-[12px] mt-1" style="color: var(--warning);">{{ pinnedNote('JIRA_POST_ENABLED') }}</div>
          </div>
          <label class="field-toggle" :title="pinnedNote('JIRA_POST_ENABLED')">
            <input
              type="checkbox" :checked="jiraSettings.postEnabled === true" :disabled="!!pinnedBy('JIRA_POST_ENABLED')"
              @change="setJira('postEnabled', ($event.target as HTMLInputElement).checked)"
            />
            <span class="field-toggle__track"><span class="field-toggle__thumb" /></span>
          </label>
        </div>

        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0 flex-1 max-w-2xl">
            <div class="text-[13px] font-medium">Jira host</div>
            <div class="text-[12px] mt-0.5 text-label leading-relaxed">
              The site every Jira call goes to, as an https URL. If this was the missing credential, ticket
              polling starts at the next restart — the watcher chooses its ticket source once, at boot.
            </div>
            <div v-if="pinnedBy('JIRA_BASE_URL')" class="text-[12px] mt-1" style="color: var(--warning);">{{ pinnedNote('JIRA_BASE_URL') }}</div>
          </div>
          <input
            type="url" class="field-input text-[12px]" style="width: 20rem; flex: none;" placeholder="https://your-team.atlassian.net"
            aria-label="Jira host" :value="jiraSettings.baseUrl ?? ''"
            :disabled="!!pinnedBy('JIRA_BASE_URL')" :title="pinnedNote('JIRA_BASE_URL')"
            @change="setJira('baseUrl', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0 flex-1 max-w-2xl">
            <div class="text-[13px] font-medium">Default project key</div>
            <div class="text-[12px] mt-0.5 text-label leading-relaxed">
              Written into the generated jira-cli config for new runs. Leave empty and the agents name a project explicitly.
            </div>
            <div v-if="pinnedBy('JIRA_DEFAULT_PROJECT')" class="text-[12px] mt-1" style="color: var(--warning);">{{ pinnedNote('JIRA_DEFAULT_PROJECT') }}</div>
          </div>
          <input
            type="text" class="field-input text-[12px]" style="width: 10rem; flex: none;" placeholder="ASECRM"
            aria-label="Default Jira project key" :value="jiraSettings.defaultProject ?? ''"
            :disabled="!!pinnedBy('JIRA_DEFAULT_PROJECT')" :title="pinnedNote('JIRA_DEFAULT_PROJECT')"
            @change="setJira('defaultProject', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0 flex-1 max-w-2xl">
            <div class="text-[13px] font-medium">"For vis:" name</div>
            <div class="text-[12px] mt-0.5 text-label leading-relaxed">
              Appended as a last line on a posted or rendered comment. Left out entirely when empty — never filled with a placeholder.
            </div>
            <div v-if="pinnedBy('JIRA_COMMENT_FOR_VIS_NAME')" class="text-[12px] mt-1" style="color: var(--warning);">{{ pinnedNote('JIRA_COMMENT_FOR_VIS_NAME') }}</div>
          </div>
          <input
            type="text" class="field-input text-[12px]" style="width: 14rem; flex: none;" placeholder="Nobody by default"
            aria-label="For vis name" :value="jiraSettings.forVisName ?? ''"
            :disabled="!!pinnedBy('JIRA_COMMENT_FOR_VIS_NAME')" :title="pinnedNote('JIRA_COMMENT_FOR_VIS_NAME')"
            @change="setJira('forVisName', ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>

      <!-- Instance: read-only, because none of it can change without a restart -->
      <div v-if="instance" class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title">Instance</h3>
        <p class="text-[12px] text-meta">
          What this server is actually running, as it booted. None of it is editable here: every switch below is
          read once at startup, before the timer it controls exists, so a toggle would save cleanly and change
          nothing until a restart. Each row names the variable to set instead.
        </p>

        <div>
          <div class="text-[13px] font-medium mb-2">Automations</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            <div v-for="a in instance.automations" :key="a.envVar" class="flex items-center gap-2 text-[12px]">
              <span class="size-1.5 rounded-full shrink-0" :style="{ background: a.enabled ? 'var(--success)' : 'var(--text-disabled)' }" />
              <span>{{ a.name }}</span>
              <span class="text-label">{{ a.enabled ? (a.detail ?? 'on') : 'off' }}</span>
              <code class="text-[10px] text-label ml-auto">{{ a.envVar }}</code>
            </div>
          </div>
        </div>

        <div>
          <div class="text-[13px] font-medium mb-2">Paths</div>
          <div class="grid grid-cols-1 gap-y-1 text-[12px]">
            <div><span class="text-label">Config</span> <code class="ml-2">{{ instance.paths.claudeDir }}</code></div>
            <div><span class="text-label">Run evidence</span> <code class="ml-2">{{ instance.paths.agentRunsDir }}</code></div>
            <div><span class="text-label">Checkouts</span> <code class="ml-2">{{ instance.paths.workspaceRoot }}</code></div>
            <div><span class="text-label">Developer profiles</span> <code class="ml-2">{{ instance.paths.usersDir }}</code></div>
          </div>
        </div>

        <div>
          <div class="text-[13px] font-medium mb-2">Credentials</div>
          <div class="text-[12px] text-meta mb-2">Presence only — no value is ever sent to this page.</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            <div v-for="s in instance.secrets" :key="s.name" class="flex items-center gap-2 text-[12px]">
              <span class="size-1.5 rounded-full shrink-0" :style="{ background: s.set ? 'var(--success)' : 'var(--text-disabled)' }" />
              <code class="text-[11px]">{{ s.name }}</code>
              <span class="text-label ml-auto">{{ s.set ? 'set' : 'not set' }}</span>
            </div>
          </div>
        </div>

        <div class="text-[12px]">
          <span class="text-label">Sign-in</span>
          <span class="ml-2">{{ instance.identity.authDisabled ? 'disabled (every request is the local developer)' : `GitHub${instance.identity.githubOrg ? `, ${instance.identity.githubOrg}` : ''}` }}</span>
          <code class="text-[10px] text-label ml-2">AUTH_DISABLED, GITHUB_ORG</code>
        </div>
      </div>

      <!-- Notification channels -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title">Notification channels</h3>
        <p class="text-[12px] text-meta">
          Named Teams, Slack and email destinations a workflow refers to by name — from a notify step, or as a
          workflow's channel for run transitions. Stored encrypted on the server under
          <code>~/.agent-manager</code>, outside the Claude config directory: they are not part of
          settings.json and are never included in a config export or a built image. A channel called
          <code>default</code> receives run transitions from every workflow that names no channel of its own.
        </p>

        <div v-if="channelsError" class="text-[12px]" style="color: var(--error);">{{ channelsError }}</div>

        <table v-if="channels.length" class="w-full text-[12px]">
          <thead>
            <tr class="text-meta text-left">
              <th class="pb-2 font-medium">Name</th>
              <th class="pb-2 font-medium">Kind</th>
              <th class="pb-2 font-medium">Sends to</th>
              <th class="pb-2 font-medium">Last saved</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in channels" :key="c.name" class="border-t" style="border-color: var(--border);">
              <td class="py-2 font-medium text-primary">{{ c.name }}</td>
              <td class="py-2">{{ c.kind }}</td>
              <td class="py-2 font-mono text-meta">{{ channelTarget(c) }}</td>
              <td class="py-2 text-meta">
                {{ new Date(c.updatedAt).toLocaleDateString() }}{{ c.updatedBy ? ` · ${c.updatedBy}` : '' }}
              </td>
              <td class="py-2 text-right whitespace-nowrap">
                <UButton label="Send test" size="xs" variant="soft" :loading="testing === c.name" @click="testChannel(c.name)" />
                <UButton label="Remove" size="xs" variant="ghost" color="error" class="ml-1" @click="removeChannel(c.name)" />
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="!channelsError" class="text-[12px] text-meta">No channels configured yet.</p>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div class="field-group">
            <label class="field-label">Name</label>
            <input v-model="newChannelName" class="field-input" placeholder="reviewers" >
          </div>
          <div class="field-group">
            <label class="field-label">Kind</label>
            <select v-model="newChannelKind" class="field-input">
              <option value="teams">Teams</option>
              <option value="slack">Slack</option>
              <option value="email">Email</option>
            </select>
          </div>
          <div v-if="newChannelKind === 'email'" class="field-group">
            <label class="field-label">Recipients</label>
            <input v-model="newChannelTo" class="field-input" placeholder="dev-leads@alepo.com, qa@alepo.com" >
            <span class="field-hint">
              Comma- or newline-separated. Not a secret, so unlike a webhook these are shown back to you and
              saving replaces the whole list.
            </span>
          </div>
          <div v-else class="field-group">
            <label class="field-label">Webhook URL</label>
            <input v-model="newChannelUrl" type="password" class="field-input" placeholder="https://…" >
            <span class="field-hint">
              Write-only once saved. Editing an existing channel and leaving this blank keeps the stored URL.
            </span>
          </div>
        </div>

        <!-- The relay, shown only when something would actually use it. -->
        <div v-if="needsSmtp" class="rounded-lg p-4 space-y-3" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
          <h4 class="text-[13px] font-semibold text-primary">SMTP relay</h4>
          <p class="text-[12px] text-meta">
            One relay for every email channel: it is a property of this deployment, not of an audience.
            The password is sealed like a webhook URL, and leaving it blank keeps the stored one.
          </p>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div class="field-group">
              <label class="field-label">Host</label>
              <input v-model="smtp.host" class="field-input" placeholder="smtp.office365.com" >
            </div>
            <div class="field-group">
              <label class="field-label">Port</label>
              <input v-model.number="smtp.port" type="number" class="field-input" placeholder="587" >
            </div>
            <div class="field-group">
              <label class="field-label">From</label>
              <input v-model="smtp.from" class="field-input" placeholder="agent-manager@alepo.com" >
            </div>
            <div class="field-group">
              <label class="field-label">Username</label>
              <input v-model="smtp.user" class="field-input" placeholder="optional" >
            </div>
            <div class="field-group">
              <label class="field-label">Password</label>
              <input v-model="smtpPassword" type="password" class="field-input" :placeholder="smtp.hasPassword ? 'stored; paste a new one to replace it' : ''" >
            </div>
            <div class="field-group">
              <label class="flex items-center gap-2 cursor-pointer mt-5">
                <input v-model="smtp.secure" type="checkbox" >
                <span class="field-label mb-0">Implicit TLS (465)</span>
              </label>
            </div>
          </div>
          <div class="flex justify-end">
            <UButton label="Save relay" size="sm" variant="soft" :loading="savingSmtp" @click="saveSmtpSettings" />
          </div>
        </div>

        <div class="flex justify-end">
          <UButton label="Save channel" size="sm" variant="soft" :loading="savingChannel" @click="saveChannel" />
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
