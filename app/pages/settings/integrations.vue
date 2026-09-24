<script setup lang="ts">
import { errorToast } from '~/utils/errorToast'

/**
 * Where this instance sends things and where it pulls things from.
 *
 * Neither store is settings.json: channels and the relay live encrypted under
 * ~/.agent-manager because the config tree ships in images and is synced
 * across the team, and GitHub imports have their own registry. That is why
 * they are on their own route rather than under the raw settings.json editor.
 */
const { can } = useUser()
const toast = useToast()

const {
  skillImports,
  agentImports,
  fetchImports: fetchGithubImports,
  checkUpdates,
  updateImport,
  removeImport,
} = useGithubImports()

const githubImports = computed(() => [
  ...(skillImports?.value || []).map(i => ({ ...i, type: 'skills' as const })),
  ...(agentImports?.value || []).map(i => ({ ...i, type: 'agents' as const })),
])

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
    toast.add(errorToast('Could not save the relay', e))
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
    toast.add(errorToast('Could not save the channel', e))
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
    toast.add(errorToast('Could not remove the channel', e))
  }
}

/** Proves a webhook works now, rather than on the escalation branch at 2am. */
async function testChannel(name: string) {
  testing.value = name
  try {
    const res = await $fetch<{ ok: boolean, message: string }>(`/api/channels/${encodeURIComponent(name)}/test`, { method: 'POST' })
    toast.add({ title: res.message, color: res.ok ? 'success' : 'error' })
  } catch (e: unknown) {
    toast.add(errorToast('Could not reach the channel', e))
  } finally {
    testing.value = ''
  }
}

// ---- GitHub imports ----

const showRemoveConfirm = ref(false)
const repoToRemove = ref<{ owner: string, repo: string, type: 'skills' | 'agents', count: number } | null>(null)

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
  repoToRemove.value = { owner, repo, type, count: entry?.selectedItems?.length || 0 }
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
    await Promise.all([checkUpdates('skills'), checkUpdates('agents')])
    toast.add({ title: 'Update check complete', color: 'success' })
  } catch {
    toast.add({ title: 'Update check failed', color: 'error' })
  }
}

onMounted(async () => {
  await Promise.all([
    loadChannels(),
    fetchGithubImports('skills'),
    fetchGithubImports('agents'),
  ])
})
useAutoRefresh(() => loadChannels({ keepSmtpEdits: true }))
useAutoRefresh(() => Promise.all([
  fetchGithubImports('skills', { silent: true }),
  fetchGithubImports('agents', { silent: true }),
]), { interval: 0 })
</script>

<template>
  <div>
    <PageHeader title="Settings">
      <template #right>
        <ReadOnlyBadge v-if="!can('configure')" reason="changing these settings" />
      </template>
    </PageHeader>
    <SettingsNav />

    <div class="px-6 py-4 space-y-6">
      <!-- Notification channels -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title flex items-center gap-2">Notification channels <ScopeChip scope="instance" /></h3>
        <p class="t-small text-meta">
          Named Teams, Slack and email destinations a workflow refers to by name — from a notify step, or as a
          workflow's channel for run transitions. Stored encrypted on the server under
          <code>~/.agent-manager</code>, outside the Claude config directory: they are not part of
          settings.json and are never included in a config export or a built image. A channel called
          <code>default</code> receives run transitions from every workflow that names no channel of its own.
        </p>

        <div v-if="channelsError" class="t-small" style="color: var(--error);">{{ channelsError }}</div>

        <table v-if="channels.length" class="w-full t-small">
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
                <template v-if="can('configure')">
                  <UButton label="Send test" size="xs" variant="soft" :loading="testing === c.name" @click="testChannel(c.name)" />
                  <UButton label="Remove" size="xs" variant="ghost" color="error" class="ml-1" @click="removeChannel(c.name)" />
                </template>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="!channelsError" class="t-small text-meta">No channels configured yet.</p>

        <template v-if="can('configure')">
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
            <h4 class="t-ui font-semibold text-primary">SMTP relay</h4>
            <p class="t-small text-meta">
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
        </template>
      </div>

      <!-- GitHub Imports -->
      <div class="rounded-xl p-5 space-y-4 bg-card">
        <div class="flex items-center justify-between">
          <h3 class="text-section-title flex items-center gap-2">GitHub Imports <ScopeChip scope="instance" /></h3>
          <UButton
            v-if="githubImports.length > 0 && can('configure')"
            label="Check for updates"
            icon="i-lucide-refresh-cw"
            size="xs"
            variant="soft"
            @click="onCheckUpdates"
          />
        </div>
        <p class="t-small text-meta">
          Manage repositories imported from GitHub.
        </p>

        <div v-if="githubImports.length === 0" class="t-ui text-label">
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
              <span class="font-mono t-small text-body">{{ entry.owner }}/{{ entry.repo }}</span>
              <span
                class="t-small font-mono px-1.5 py-px rounded-full uppercase"
                style="background: var(--badge-subtle-bg); color: var(--text-tertiary); border: 1px solid var(--border-subtle);"
              >
                {{ entry.type }}
              </span>
              <span class="t-small text-meta ml-1">{{ entry.selectedItems?.length || 0 }} items</span>
            </div>
            <div class="flex items-center gap-2">
              <span
                v-if="entry.currentSha !== entry.remoteSha"
                class="t-small font-medium px-2 py-0.5 rounded-full"
                style="background: rgba(59, 130, 246, 0.1); color: var(--info, #3b82f6);"
              >
                Update available
              </span>
              <UButton
                v-if="entry.currentSha !== entry.remoteSha && can('configure')"
                label="Update"
                size="xs"
                variant="soft"
                @click="onUpdateImport(entry.owner, entry.repo, entry.type)"
              />
              <button
                v-if="can('configure')"
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
    </div>

    <!-- Delete Confirmation Modal -->
    <UModal v-model:open="showRemoveConfirm">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <div class="flex items-center gap-3">
            <div class="size-10 rounded-full flex items-center justify-center shrink-0" style="background: rgba(239, 68, 68, 0.1);">
              <UIcon name="i-lucide-alert-triangle" class="size-6 text-error" />
            </div>
            <div>
              <h3 class="t-body font-semibold text-primary">Remove Repository?</h3>
              <p class="t-small text-label mt-1">This action cannot be undone.</p>
            </div>
          </div>

          <div class="rounded-lg p-3 border" style="background: var(--surface-base); border-color: var(--border-subtle);">
            <p class="t-ui leading-relaxed">
              Removing <span class="font-mono font-bold">{{ repoToRemove?.owner }}/{{ repoToRemove?.repo }}</span> will delete the local clone and unlink
              <strong class="text-error">{{ repoToRemove?.count }} {{ repoToRemove?.type }}</strong> currently installed on your system.
            </p>
          </div>

          <div class="flex justify-end gap-3 pt-2">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showRemoveConfirm = false }" />
            <UButton label="Confirm Delete" color="error" size="sm" @click="confirmRemove" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
