<script setup lang="ts">
import type { AgentModel } from '~/types'
import { MODEL_OPTIONS } from '~/utils/models'
import { errorToast } from '~/utils/errorToast'

/**
 * What the pipeline does: the model its agents run on, what a run may spend,
 * and where it reads and writes tickets.
 *
 * Readable by every role. The values are the content of this page - a manager
 * who cannot see the run budget cannot answer the one question they have - so
 * a viewer without `configure` gets the resolved value as text rather than an
 * empty page where the controls used to be.
 */
const { settings, loading, load, save } = useSettings()
const { load: loadInstance, pinnedBy, pinnedNote } = useInstanceInfo()
const { can } = useUser()
const toast = useToast()

const saving = ref(false)

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

async function updateSetting(patch: Record<string, unknown>) {
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

const budget = computed(() => (settings.value as any)?.agentManager?.runBudget ?? {})
const agentModelLabel = computed(() => {
  const v = (settings.value as any)?.agentManager?.agentModel
  return v ? (MODEL_OPTIONS.find(o => o.value === v)?.label ?? v) : "Default (each agent's own)"
})

onMounted(async () => {
  await Promise.all([load(), loadInstance()])
})
useAutoRefresh(() => (saving.value ? null : load({ silent: true })))
</script>

<template>
  <div>
    <PageHeader title="Settings">
      <template #right>
        <ReadOnlyBadge v-if="!can('configure')" reason="changing these settings" />
      </template>
    </PageHeader>
    <SettingsNav />

    <div v-if="loading && !settings" class="flex justify-center py-16">
      <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-meta" />
    </div>

    <div v-else class="px-6 py-4 space-y-6">
      <!-- General -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title flex items-center gap-2">General <ScopeChip scope="instance" /></h3>

        <div class="space-y-4">
          <div class="flex items-start justify-between gap-4 py-3">
            <div class="min-w-0 flex-1 max-w-2xl">
              <div class="t-ui font-medium">Model for pipeline agents</div>
              <div class="t-small mt-0.5 text-label leading-relaxed">
                Runs every pipeline agent, monitors included, on one model, overriding each agent's own choice. Default keeps those choices: Opus for the fix and test agents, Sonnet for the rest. Fable is the strongest; its steps show as unpriced, since it has no list price here.
              </div>
            </div>
            <!-- field-input is full-width by design; these controls sit beside their text, so the width is pinned here. -->
            <select
              v-if="can('configure')"
              class="field-input t-small" style="width: 16rem; flex: none;" aria-label="Model for pipeline agents"
              :value="settings?.agentManager?.agentModel ?? ''"
              @change="setAgentModel(($event.target as HTMLSelectElement).value)"
            >
              <option value="">Default (each agent's own)</option>
              <option v-for="o in MODEL_OPTIONS.filter(o => o.value)" :key="o.value" :value="o.value">{{ o.label }} · {{ o.desc }}</option>
            </select>
            <span v-else class="t-small shrink-0" style="color: var(--text-primary);">{{ agentModelLabel }}</span>
          </div>

          <div class="flex items-start justify-between gap-4 py-3">
            <div class="min-w-0 flex-1 max-w-2xl">
              <div class="t-ui font-medium">Run budget</div>
              <div class="t-small mt-0.5 text-label leading-relaxed">
                Caps for each new run; when one is reached the run pauses and asks whether to continue with a fresh allowance. Defaults are 8,000,000 tokens and 180 minutes, overridden by AGENT_RUN_MAX_TOKENS or AGENT_RUN_MAX_MINUTES on the instance.
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <template v-if="pinnedBy('AGENT_RUN_MAX_TOKENS')">
                <span class="t-small tabular-nums" style="color: var(--text-primary);">{{ pinnedBy('AGENT_RUN_MAX_TOKENS') }}</span>
                <span class="badge badge-warning" :title="pinnedNote('AGENT_RUN_MAX_TOKENS')">Pinned by AGENT_RUN_MAX_TOKENS</span>
              </template>
              <template v-else>
                <input
                  v-if="can('configure')"
                  type="number" min="1" step="100000" class="field-input t-small" style="width: 9rem; flex: none;" placeholder="8000000" aria-label="Max tokens per run"
                  :value="budget.maxTokens ?? ''"
                  @change="setRunBudget('maxTokens', ($event.target as HTMLInputElement).value)"
                />
                <!-- An explicit locale, not the ambient one: the server groups by its own
                     locale and the browser by the viewer's, so a bare toLocaleString()
                     rendered 80,00,000 server-side and 8,000,000 on the client and
                     Vue reported a hydration mismatch. -->
                <span v-else class="t-small tabular-nums" style="color: var(--text-primary);">{{ (budget.maxTokens ?? 8000000).toLocaleString('en-US') }}</span>
                <span class="t-small text-label">tokens</span>
              </template>

              <template v-if="pinnedBy('AGENT_RUN_MAX_MINUTES')">
                <span class="t-small tabular-nums" style="color: var(--text-primary);">{{ pinnedBy('AGENT_RUN_MAX_MINUTES') }}</span>
                <span class="badge badge-warning" :title="pinnedNote('AGENT_RUN_MAX_MINUTES')">Pinned by AGENT_RUN_MAX_MINUTES</span>
              </template>
              <template v-else>
                <input
                  v-if="can('configure')"
                  type="number" min="1" step="10" class="field-input t-small" style="width: 6rem; flex: none;" placeholder="180" aria-label="Max minutes per run"
                  :value="budget.maxMinutes ?? ''"
                  @change="setRunBudget('maxMinutes', ($event.target as HTMLInputElement).value)"
                />
                <span v-else class="t-small tabular-nums" style="color: var(--text-primary);">{{ budget.maxMinutes ?? 180 }}</span>
                <span class="t-small text-label">min</span>
              </template>
            </div>
          </div>

          <div class="flex items-center justify-between gap-4">
            <div class="min-w-0 flex-1 max-w-2xl">
              <div class="t-ui font-medium">Always Thinking</div>
              <div class="t-small mt-0.5 text-label leading-relaxed">
                When enabled, Claude takes more time to reason through complex problems before responding. Better answers, but slower and uses more resources.
              </div>
            </div>
            <label v-if="can('configure')" class="field-toggle">
              <input
                type="checkbox"
                :checked="settings?.alwaysThinkingEnabled"
                @change="toggleAlwaysThinking(($event.target as HTMLInputElement).checked)"
              />
              <span class="field-toggle__track">
                <span class="field-toggle__thumb" />
              </span>
            </label>
            <span v-else class="badge" :class="settings?.alwaysThinkingEnabled ? 'badge-success' : 'badge-subtle'">{{ settings?.alwaysThinkingEnabled ? 'On' : 'Off' }}</span>
          </div>

          <!-- /tasks-picker-infra lookback window -->
          <div class="flex items-center justify-between gap-4">
            <div class="min-w-0 flex-1 max-w-2xl">
              <div class="t-ui font-medium">Task picker window</div>
              <div class="t-small mt-0.5 text-label leading-relaxed">
                How far back <code>/tasks-picker-infra</code> looks for newly raised DEVOPS issues.
                Jira cannot filter below one minute, so the command queries the window rounded up to
                whole minutes and applies the exact seconds itself.
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <input
                v-if="can('configure')"
                type="number"
                min="1"
                class="w-24 t-ui px-2 py-1 rounded-md bg-card border border-subtle text-right tabular-nums"
                data-testid="tasks-picker-window"
                :value="settings?.tasksPickerWindowSeconds ?? TASKS_PICKER_DEFAULT_SECONDS"
                @change="updateTasksPickerWindow(($event.target as HTMLInputElement).value)"
              />
              <span v-else class="t-small tabular-nums" style="color: var(--text-primary);">{{ settings?.tasksPickerWindowSeconds ?? TASKS_PICKER_DEFAULT_SECONDS }}</span>
              <span class="t-small text-label">seconds</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Jira -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title flex items-center gap-2">Jira <ScopeChip scope="instance" /></h3>
        <p class="t-small text-meta">
          The host and the posting gate for this instance. The API token is not here and never will be: it is
          per-developer and stored encrypted outside the config tree — set yours on
          <NuxtLink to="/profile" class="underline focus-ring">your profile</NuxtLink>. An environment variable
          set on the instance overrides anything saved here.
        </p>

        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0 flex-1 max-w-2xl">
            <div class="t-ui font-medium">Post outcomes to Jira</div>
            <div class="t-small mt-0.5 text-label leading-relaxed">
              Off by default. Every run writes the comment it would post to its own <code>jira-comment.json</code>
              artifact either way, so this decides where that comment goes, never whether one is produced.
              <code>JIRA_POST_ENABLED=0</code> on the instance pins it off for everyone.
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <template v-if="pinnedBy('JIRA_POST_ENABLED')">
              <span class="badge" :class="pinnedBy('JIRA_POST_ENABLED') === '1' ? 'badge-success' : 'badge-subtle'">{{ pinnedBy('JIRA_POST_ENABLED') === '1' ? 'On' : 'Off' }}</span>
              <span class="badge badge-warning" :title="pinnedNote('JIRA_POST_ENABLED')">Pinned by JIRA_POST_ENABLED</span>
            </template>
            <label v-else-if="can('configure')" class="field-toggle">
              <input
                type="checkbox" :checked="jiraSettings.postEnabled === true"
                @change="setJira('postEnabled', ($event.target as HTMLInputElement).checked)"
              />
              <span class="field-toggle__track"><span class="field-toggle__thumb" /></span>
            </label>
            <span v-else class="badge" :class="jiraSettings.postEnabled ? 'badge-success' : 'badge-subtle'">{{ jiraSettings.postEnabled ? 'On' : 'Off' }}</span>
          </div>
        </div>

        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0 flex-1 max-w-2xl">
            <div class="t-ui font-medium">Jira host</div>
            <div class="t-small mt-0.5 text-label leading-relaxed">
              The site every Jira call goes to, as an https URL. If this was the missing credential, ticket
              polling starts at the next restart — the watcher chooses its ticket source once, at boot.
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <template v-if="pinnedBy('JIRA_BASE_URL')">
              <span class="t-small font-mono" style="color: var(--text-primary);">{{ pinnedBy('JIRA_BASE_URL') }}</span>
              <span class="badge badge-warning" :title="pinnedNote('JIRA_BASE_URL')">Pinned by JIRA_BASE_URL</span>
            </template>
            <input
              v-else-if="can('configure')"
              type="url" class="field-input t-small" style="width: 20rem; flex: none;" placeholder="https://your-team.atlassian.net"
              aria-label="Jira host" :value="jiraSettings.baseUrl ?? ''"
              @change="setJira('baseUrl', ($event.target as HTMLInputElement).value)"
            />
            <span v-else class="t-small font-mono" style="color: var(--text-primary);">{{ jiraSettings.baseUrl || '—' }}</span>
          </div>
        </div>

        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0 flex-1 max-w-2xl">
            <div class="t-ui font-medium">Default project key</div>
            <div class="t-small mt-0.5 text-label leading-relaxed">
              Written into the generated jira-cli config for new runs. Leave empty and the agents name a project explicitly.
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <template v-if="pinnedBy('JIRA_DEFAULT_PROJECT')">
              <span class="t-small font-mono" style="color: var(--text-primary);">{{ pinnedBy('JIRA_DEFAULT_PROJECT') }}</span>
              <span class="badge badge-warning" :title="pinnedNote('JIRA_DEFAULT_PROJECT')">Pinned by JIRA_DEFAULT_PROJECT</span>
            </template>
            <input
              v-else-if="can('configure')"
              type="text" class="field-input t-small" style="width: 10rem; flex: none;" placeholder="ASECRM"
              aria-label="Default Jira project key" :value="jiraSettings.defaultProject ?? ''"
              @change="setJira('defaultProject', ($event.target as HTMLInputElement).value)"
            />
            <span v-else class="t-small font-mono" style="color: var(--text-primary);">{{ jiraSettings.defaultProject || '—' }}</span>
          </div>
        </div>

        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0 flex-1 max-w-2xl">
            <div class="t-ui font-medium">"For vis:" name</div>
            <div class="t-small mt-0.5 text-label leading-relaxed">
              Appended as a last line on a posted or rendered comment. Left out entirely when empty — never filled with a placeholder.
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <template v-if="pinnedBy('JIRA_COMMENT_FOR_VIS_NAME')">
              <span class="t-small" style="color: var(--text-primary);">{{ pinnedBy('JIRA_COMMENT_FOR_VIS_NAME') }}</span>
              <span class="badge badge-warning" :title="pinnedNote('JIRA_COMMENT_FOR_VIS_NAME')">Pinned by JIRA_COMMENT_FOR_VIS_NAME</span>
            </template>
            <input
              v-else-if="can('configure')"
              type="text" class="field-input t-small" style="width: 14rem; flex: none;" placeholder="Nobody by default"
              aria-label="For vis name" :value="jiraSettings.forVisName ?? ''"
              @change="setJira('forVisName', ($event.target as HTMLInputElement).value)"
            />
            <span v-else class="t-small" style="color: var(--text-primary);">{{ jiraSettings.forVisName || '—' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
