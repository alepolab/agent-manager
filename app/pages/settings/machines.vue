<script setup lang="ts">
import type { Machine } from '~/types'
import { errorToast } from '~/utils/errorToast'

/**
 * Where a run's agents execute.
 *
 * By default every Claude Code process a run starts runs beside this server,
 * on whatever this container has. A machine registered here is somewhere
 * else it can run instead - a build box with the toolchain a product needs,
 * a host with the memory a stack needs, a developer's own workstation -
 * reached over ssh. The checkout and the run's evidence are carried there
 * before each step and back after it, so the rest of the pipeline reads this
 * server's copy as it always did.
 *
 * Readable by every role, for the reason the pipeline page is: anyone who can
 * start a run can pick a machine in the dialog, and the list is what makes
 * the names in it mean something. Only `configure` may change it.
 */
const { machines, defaultMachineId, loading, load, save, remove, check, setDefault } = useMachines()
const { can } = useUser()
const toast = useToast()

onMounted(load)
useAutoRefresh(() => (editing.value || busy.value ? null : load({ silent: true })))

const busy = ref<string | null>(null)

// ── the form ────────────────────────────────────────────────────────────────
interface Form {
  name: string
  host: string
  port: string
  user: string
  privateKey: string
  keyPath: string
  claudePath: string
  transport: 'sync' | 'shared'
  workspaceRoot: string
  runsRoot: string
  appRoot: string
  claudeDir: string
  env: string
  enabled: boolean
}
const blank = (): Form => ({
  name: '', host: '', port: '', user: '', privateKey: '', keyPath: '', claudePath: '', transport: 'sync',
  workspaceRoot: '', runsRoot: '', appRoot: '', claudeDir: '', env: '', enabled: true,
})
const form = ref<Form>(blank())
/** null: closed; '': adding; an id: editing that machine. */
const editing = ref<string | null>(null)
const editingMachine = computed(() => machines.value.find(m => m.id === editing.value))
const saving = ref(false)
const advanced = ref(false)

function openAdd() {
  form.value = blank()
  advanced.value = false
  editing.value = ''
}
function openEdit(m: Machine) {
  form.value = {
    name: m.name, host: m.host, port: m.port ? String(m.port) : '', user: m.user ?? '', privateKey: '', keyPath: m.keyPath ?? '',
    claudePath: m.claudePath ?? '', transport: m.transport, workspaceRoot: m.workspaceRoot ?? '', runsRoot: m.runsRoot ?? '',
    appRoot: m.appRoot ?? '', claudeDir: m.claudeDir ?? '',
    env: Object.entries(m.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    enabled: m.enabled,
  }
  advanced.value = !!(m.claudePath || m.workspaceRoot || m.runsRoot || m.appRoot || m.claudeDir || m.env || m.keyPath)
  editing.value = m.id
}
function closeForm() { editing.value = null }

/** `NAME=value` per line. A line without `=` is a mistake worth refusing, not a value worth guessing. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i < 1) throw new Error(`"${line}" is not NAME=value`)
    out[line.slice(0, i).trim()] = line.slice(i + 1)
  }
  return out
}

const canSave = computed(() => !!form.value.name.trim() && !!form.value.host.trim() && !saving.value)

async function submit() {
  if (!canSave.value) return
  saving.value = true
  try {
    const f = form.value
    const body: Record<string, unknown> = {
      name: f.name, host: f.host, port: f.port, user: f.user, keyPath: f.keyPath, claudePath: f.claudePath,
      transport: f.transport, workspaceRoot: f.workspaceRoot, runsRoot: f.runsRoot, appRoot: f.appRoot, claudeDir: f.claudeDir,
      env: parseEnv(f.env), enabled: f.enabled,
    }
    // Sent only when typed: absent keeps the stored key, '' would clear it.
    if (f.privateKey.trim()) body.privateKeyPlain = f.privateKey
    const saved = await save(body, editing.value || undefined)
    form.value.privateKey = ''
    editing.value = null
    toast.add({ title: `${saved.name} saved`, description: 'Test the connection to confirm claude, git and rsync are there.', color: 'success' })
  } catch (e) {
    toast.add(errorToast('Not saved', e))
  } finally {
    saving.value = false
  }
}

async function clearKey(m: Machine) {
  try {
    await save({ name: m.name, host: m.host, port: m.port ?? '', user: m.user ?? '', keyPath: m.keyPath ?? '', claudePath: m.claudePath ?? '', transport: m.transport, workspaceRoot: m.workspaceRoot ?? '', runsRoot: m.runsRoot ?? '', appRoot: m.appRoot ?? '', claudeDir: m.claudeDir ?? '', env: m.env ?? {}, enabled: m.enabled, privateKeyPlain: '' }, m.id)
    toast.add({ title: `Stored key removed from ${m.name}`, description: 'ssh will use its own agent and default keys, or the key path.', color: 'success' })
  } catch (e) {
    toast.add(errorToast('Key not removed', e))
  }
}

// ── row actions ─────────────────────────────────────────────────────────────
async function test(m: Machine) {
  busy.value = m.id
  try {
    const v = await check(m.id)
    toast.add(v.ok
      ? { title: `${m.name} is ready`, description: v.detail, color: 'success' }
      : { title: `${m.name} cannot run agents yet`, description: v.detail, color: 'warning', duration: 0 })
  } catch (e) {
    toast.add(errorToast('Connection test failed', e))
  } finally {
    busy.value = null
  }
}

async function toggleEnabled(m: Machine, enabled: boolean) {
  try {
    await save({ name: m.name, host: m.host, port: m.port ?? '', user: m.user ?? '', keyPath: m.keyPath ?? '', claudePath: m.claudePath ?? '', transport: m.transport, workspaceRoot: m.workspaceRoot ?? '', runsRoot: m.runsRoot ?? '', appRoot: m.appRoot ?? '', claudeDir: m.claudeDir ?? '', env: m.env ?? {}, enabled }, m.id)
    toast.add({ title: `${m.name} ${enabled ? 'enabled' : 'switched off'}`, description: enabled ? undefined : 'Runs already on it fail at their next step; new runs cannot pick it.', color: 'success' })
  } catch (e) {
    toast.add(errorToast('Not saved', e))
  }
}

async function makeDefault(id: string | null) {
  try {
    await setDefault(id)
    toast.add({ title: id ? `New runs execute on ${machines.value.find(m => m.id === id)?.name ?? 'that machine'}` : 'New runs execute on this server', description: 'Unless the workflow or the start says otherwise.', color: 'success' })
  } catch (e) {
    toast.add(errorToast('Default not saved', e))
  }
}

// Delete asks once, inline, then forgets - the same two-click confirm the run page uses for Stop.
const confirmingDelete = ref<string | null>(null)
let deleteTimer: ReturnType<typeof setTimeout> | null = null
async function del(m: Machine) {
  if (confirmingDelete.value !== m.id) {
    confirmingDelete.value = m.id
    if (deleteTimer) clearTimeout(deleteTimer)
    deleteTimer = setTimeout(() => { confirmingDelete.value = null }, 4000)
    return
  }
  confirmingDelete.value = null
  try {
    await remove(m.id)
    if (editing.value === m.id) editing.value = null
    toast.add({ title: `${m.name} removed`, color: 'success' })
  } catch (e) {
    toast.add(errorToast('Not removed', e))
  }
}
onUnmounted(() => { if (deleteTimer) clearTimeout(deleteTimer) })

const target = (m: Machine) => `${m.user ? `${m.user}@` : ''}${m.host}${m.port ? `:${m.port}` : ''}`
const checkColor = (m: Machine) => (!m.enabled ? 'var(--text-disabled)' : !m.lastCheck ? 'var(--text-tertiary)' : m.lastCheck.ok ? 'var(--success)' : 'var(--error)')
const checkLabel = (m: Machine) => (!m.enabled ? 'switched off' : !m.lastCheck ? 'not tested yet' : m.lastCheck.ok ? 'ready' : 'not ready')
const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}
</script>

<template>
  <div>
    <PageHeader title="Settings">
      <template #right>
        <ReadOnlyBadge v-if="!can('configure')" reason="changing machines" />
      </template>
    </PageHeader>

    <div v-if="loading && !machines.length" class="flex justify-center py-16">
      <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-meta" />
    </div>

    <div v-else class="px-6 py-4 space-y-6">
      <!-- Where runs go by default -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title flex items-center gap-2">Machines <ScopeChip scope="instance" /></h3>
        <p class="t-small text-meta max-w-3xl">
          Every step of a run is a Claude Code process working in the run's checkout. By default it runs here, beside
          this server. A machine registered below is somewhere else it can run instead, reached over ssh: the checkout
          and the run's evidence are carried there before each step and back after it, so gates, briefs and artifacts
          read this server's copy exactly as before. A run picks its machine once, at the start: the start dialog, then
          the workflow's own setting, then the default here.
        </p>

        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0 flex-1 max-w-2xl">
            <div class="t-ui font-medium">Run agents on</div>
            <div class="t-small mt-0.5 text-label leading-relaxed">
              Where every run executes unless its workflow or its start says otherwise. Applies to the next run; a
              run already going stays where it is, because the sessions its steps resume live there.
            </div>
          </div>
          <select
            v-if="can('configure')"
            class="field-input t-small" style="width: 18rem; flex: none;" aria-label="Default machine" data-testid="default-machine"
            :value="defaultMachineId ?? ''"
            @change="makeDefault(($event.target as HTMLSelectElement).value || null)"
          >
            <option value="">This server</option>
            <option v-for="m in machines" :key="m.id" :value="m.id" :disabled="!m.enabled">{{ m.name }} · {{ target(m) }}{{ m.enabled ? '' : ' (switched off)' }}</option>
          </select>
          <span v-else class="t-small shrink-0" style="color: var(--text-primary);">{{ defaultMachineId ? (machines.find(m => m.id === defaultMachineId)?.name ?? 'a removed machine') : 'This server' }}</span>
        </div>
      </div>

      <!-- The machines -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <div class="flex items-center justify-between gap-4">
          <h3 class="text-section-title">Registered machines</h3>
          <UButton v-if="can('configure') && editing === null" label="Add machine" icon="i-lucide-plus" size="sm" data-testid="add-machine" @click="openAdd" />
        </div>

        <div v-if="!machines.length && editing === null" class="t-small text-meta leading-relaxed max-w-3xl space-y-2" data-testid="machines-empty">
          <p>No machines yet; every run executes on this server.</p>
          <p>
            A machine needs: ssh access for a user this server can authenticate as (a pasted key, a key file on this
            server, or its ssh agent); <code>claude</code> on that user's login PATH, signed in or with
            <code>ANTHROPIC_API_KEY</code> forwarded from here; <code>git</code>; and <code>rsync</code> unless it
            shares this server's filesystem. The run's own credentials - GitHub, Jira, the model - travel with each
            call, so the machine keeps none of its own.
          </p>
        </div>

        <div v-for="m in machines" :key="m.id" class="rounded-lg p-4 space-y-2" style="border: 1px solid var(--border-subtle);" :data-testid="`machine-${m.id}`">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span class="size-2 rounded-full shrink-0" :style="{ background: checkColor(m) }" :title="checkLabel(m)" />
            <span class="t-ui font-medium">{{ m.name }}</span>
            <code class="t-small text-label">{{ target(m) }}</code>
            <span class="badge badge-subtle">{{ m.transport === 'shared' ? 'shared filesystem' : 'copied each step' }}</span>
            <span v-if="defaultMachineId === m.id" class="badge badge-success">default</span>
            <span v-if="!m.enabled" class="badge badge-warning">switched off</span>
            <span class="t-small text-label ml-auto">{{ checkLabel(m) }}<template v-if="m.lastCheck"> · {{ ago(m.lastCheck.at) }}</template></span>
          </div>
          <div class="t-small text-label leading-relaxed">
            <template v-if="m.lastCheck">{{ m.lastCheck.detail }}</template>
            <template v-else>Not tested yet: test the connection before a run depends on it.</template>
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 t-small text-label">
            <span>key: {{ m.hasPrivateKey ? 'stored' : m.keyPath ? m.keyPath : 'ssh agent / default keys' }}</span>
            <span v-if="m.claudePath">claude: <code>{{ m.claudePath }}</code></span>
            <span v-if="m.workspaceRoot">checkouts: <code>{{ m.workspaceRoot }}</code></span>
            <span v-if="m.runsRoot">evidence: <code>{{ m.runsRoot }}</code></span>
            <span v-if="m.appRoot">agent-manager: <code>{{ m.appRoot }}</code></span>
            <span v-if="m.env && Object.keys(m.env).length">env: {{ Object.keys(m.env).join(', ') }}</span>
          </div>
          <div v-if="can('configure')" class="flex flex-wrap items-center gap-2 pt-1">
            <UButton label="Test connection" icon="i-lucide-plug-zap" size="xs" variant="soft" color="neutral" :loading="busy === m.id" :data-testid="`check-${m.id}`" @click="test(m)" />
            <UButton label="Edit" icon="i-lucide-pencil" size="xs" variant="ghost" color="neutral" @click="openEdit(m)" />
            <UButton v-if="defaultMachineId !== m.id && m.enabled" label="Make default" icon="i-lucide-star" size="xs" variant="ghost" color="neutral" @click="makeDefault(m.id)" />
            <UButton :label="m.enabled ? 'Switch off' : 'Enable'" :icon="m.enabled ? 'i-lucide-power-off' : 'i-lucide-power'" size="xs" variant="ghost" color="neutral" @click="toggleEnabled(m, !m.enabled)" />
            <UButton v-if="m.hasPrivateKey" label="Remove stored key" icon="i-lucide-key-round" size="xs" variant="ghost" color="neutral" @click="clearKey(m)" />
            <UButton :label="confirmingDelete === m.id ? 'Confirm remove' : 'Remove'" icon="i-lucide-trash-2" size="xs" variant="ghost" :color="confirmingDelete === m.id ? 'error' : 'neutral'" class="ml-auto" @click="del(m)" />
          </div>
        </div>

        <!-- Add / edit -->
        <form v-if="editing !== null" class="rounded-lg p-4 space-y-4" style="border: 1px solid var(--border-subtle); background: var(--surface-raised);" data-testid="machine-form" @submit.prevent="submit">
          <div class="t-ui font-medium">{{ editing ? `Edit ${editingMachine?.name ?? 'machine'}` : 'New machine' }}</div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="field-group">
              <label class="field-label" for="machine-name">Name</label>
              <input id="machine-name" v-model="form.name" class="field-input w-full" placeholder="build-box" required>
              <span class="field-hint">How workflows and runs refer to it.</span>
            </div>
            <div class="field-group">
              <label class="field-label" for="machine-host">Host</label>
              <input id="machine-host" v-model="form.host" class="field-input w-full" placeholder="build.internal or 10.0.0.12" required>
            </div>
            <div class="field-group">
              <label class="field-label" for="machine-user">ssh user <span class="t-small font-normal ml-1" style="color: var(--text-disabled);">optional</span></label>
              <input id="machine-user" v-model="form.user" class="field-input w-full" placeholder="agent" autocomplete="off">
              <span class="field-hint">Empty uses this server's ssh config for the host.</span>
            </div>
            <div class="field-group">
              <label class="field-label" for="machine-port">Port <span class="t-small font-normal ml-1" style="color: var(--text-disabled);">optional</span></label>
              <input id="machine-port" v-model="form.port" type="number" min="1" max="65535" class="field-input w-full" placeholder="22">
            </div>
          </div>

          <div class="field-group">
            <label class="field-label" for="machine-key">Private key <span class="t-small font-normal ml-1" style="color: var(--text-disabled);">optional</span></label>
            <textarea id="machine-key" v-model="form.privateKey" rows="3" class="field-input w-full font-mono resize-y" :placeholder="editingMachine?.hasPrivateKey ? 'A key is stored; paste to replace it' : '-----BEGIN OPENSSH PRIVATE KEY----- … paste to set'" autocomplete="off" spellcheck="false" />
            <span class="field-hint">
              Sealed with AGENT_MANAGER_SECRET, outside the config tree, and written as a 0600 file only for ssh to read.
              Without one, ssh uses the key path below, else its agent and default keys.
            </span>
          </div>

          <div class="field-group">
            <label class="field-label" for="machine-transport">Files</label>
            <select id="machine-transport" v-model="form.transport" class="field-input w-full">
              <option value="sync">Copied each step - commits pushed, working tree and evidence rsync'd there and back</option>
              <option value="shared">Shared filesystem - the machine sees this server's paths; nothing is copied</option>
            </select>
          </div>

          <button type="button" class="t-small text-label underline focus-ring" @click="advanced = !advanced">
            {{ advanced ? 'Hide' : 'Show' }} paths and environment
          </button>

          <div v-if="advanced" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="field-group">
              <label class="field-label" for="machine-keypath">Key file on this server</label>
              <input id="machine-keypath" v-model="form.keyPath" class="field-input w-full" placeholder="/home/app/.ssh/id_ed25519">
              <span class="field-hint">Used when no key is pasted.</span>
            </div>
            <div class="field-group">
              <label class="field-label" for="machine-claude">claude executable</label>
              <input id="machine-claude" v-model="form.claudePath" class="field-input w-full" placeholder="claude">
              <span class="field-hint">A command on the login PATH, or a path.</span>
            </div>
            <div class="field-group">
              <label class="field-label" for="machine-ws">Checkouts root on the machine</label>
              <input id="machine-ws" v-model="form.workspaceRoot" class="field-input w-full" placeholder="same path as here">
              <span class="field-hint">This server's AGENT_WORKSPACE_ROOT is re-rooted here. Empty keeps the same path, right for a shared mount or an identical layout.</span>
            </div>
            <div class="field-group">
              <label class="field-label" for="machine-runs">Evidence root on the machine</label>
              <input id="machine-runs" v-model="form.runsRoot" class="field-input w-full" placeholder="same path as here">
              <span class="field-hint">Re-roots this server's run evidence directory.</span>
            </div>
            <div class="field-group">
              <label class="field-label" for="machine-app">Agent Manager checkout on the machine</label>
              <input id="machine-app" v-model="form.appRoot" class="field-input w-full" placeholder="same path as here">
              <span class="field-hint">Agents are handed the scripts and vendored skills by absolute path; this is where they are there.</span>
            </div>
            <div class="field-group">
              <label class="field-label" for="machine-claudedir">Claude config directory on the machine</label>
              <input id="machine-claudedir" v-model="form.claudeDir" class="field-input w-full" placeholder="same path as here">
              <span class="field-hint">For the seeded skills agents read at run time.</span>
            </div>
            <div class="field-group sm:col-span-2">
              <label class="field-label" for="machine-env">Environment for agents on this machine</label>
              <textarea id="machine-env" v-model="form.env" rows="3" class="field-input w-full font-mono resize-y" placeholder="JAVA_HOME=/opt/jdk-17&#10;DOCKER_HOST=unix:///run/user/1000/podman/podman.sock" spellcheck="false" />
              <span class="field-hint">One NAME=value per line, stored in clear: paths and switches, never a secret. The run's own credentials travel with every call.</span>
            </div>
          </div>

          <label class="flex items-center gap-2 cursor-pointer">
            <input v-model="form.enabled" type="checkbox" class="shrink-0">
            <span class="field-label mb-0">Enabled</span>
          </label>

          <div class="flex justify-end gap-2 pt-1">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="closeForm" />
            <UButton type="submit" :label="editing ? 'Save' : 'Add machine'" icon="i-lucide-check" size="sm" :disabled="!canSave" :loading="saving" data-testid="save-machine" />
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
