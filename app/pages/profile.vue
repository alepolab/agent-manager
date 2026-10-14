<script setup lang="ts">
import { errorToast } from '~/utils/errorToast'

const { me, load } = useUser()
const route = useRoute()
/** Arrived straight from sign-in with no Claude token: walk them through it. */
const setup = computed(() => route.query.setup === '1')
const setupSteps = computed(() => {
  const p = me.value?.profile
  return [
    { key: 'claude', done: !!p?.hasAnthropicToken, name: 'Claude token', why: 'Required: nothing that uses Claude runs without it.' },
    { key: 'github', done: !!p?.hasGithubToken, name: 'GitHub token', why: 'Needed for runs that push branches or open pull requests.' },
    { key: 'jira', done: !!p?.hasJiraToken, name: 'Jira', why: 'Optional: runs read and comment on tickets as you.' },
  ]
})
const toast = useToast()
const jiraEmail = ref('')
const jiraToken = ref('')
const claudeToken = ref('')
const savingClaude = ref(false)
const githubToken = ref('')
const savingGithub = ref(false)
const savingLabs = ref(false)
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean, message: string } | null>(null)

onMounted(async () => {
  if (!me.value) await load()
  jiraEmail.value = me.value?.profile.jiraEmail ?? ''
})

/** Yours, not the instance's: it only changes what your own sidebar offers. */
async function setLabs(on: boolean) {
  savingLabs.value = true
  try {
    await $fetch('/api/me', { method: 'PUT', body: { labs: on } })
    await load()
  } catch (e) {
    toast.add(errorToast('Could not save the preference', e))
  } finally {
    savingLabs.value = false
  }
}

async function save() {
  saving.value = true
  try {
    await $fetch('/api/me', { method: 'PUT', body: { jiraEmail: jiraEmail.value, ...(jiraToken.value ? { jiraToken: jiraToken.value } : {}) } })
    jiraToken.value = ''
    await load()
    toast.add({ title: 'Profile saved', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Could not save', description: e.data?.message || e.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

/** Every agent you start runs on this - pipeline steps, /cli chat, Studio. An
 *  empty save clears it, which stops your runs and chats from starting. */
async function saveClaude(clear = false) {
  savingClaude.value = true
  try {
    await $fetch('/api/me', { method: 'PUT', body: { anthropicToken: clear ? '' : claudeToken.value } })
    claudeToken.value = ''
    await load()
    toast.add({ title: clear ? 'Claude credential removed' : 'Claude credential saved', color: 'success' })
  } catch (e) {
    toast.add(errorToast('Could not save the Claude credential', e))
  } finally {
    savingClaude.value = false
  }
}

/** A token of their own for pushes and pull requests. GitHub is asked whose it
 *  is before anything is stored, and sign-in leaves it alone afterwards. */
async function saveGithub(remove = false) {
  savingGithub.value = true
  try {
    await $fetch('/api/me', { method: 'PUT', body: { githubToken: remove ? '' : githubToken.value } })
    githubToken.value = ''
    await load()
    toast.add({
      title: remove ? 'GitHub token removed' : `GitHub token saved - runs act as @${me.value?.profile.githubLogin}`,
      color: 'success',
    })
  } catch (e) {
    toast.add(errorToast('Could not save the GitHub token', e))
  } finally {
    savingGithub.value = false
  }
}

/** What the GitHub section says about the token in force now. */
const githubStatus = computed(() => {
  const p = me.value?.profile
  if (!p?.hasGithubToken) {
    if (me.value?.authDisabled) return 'not needed in local mode'
    // Sign-in here only proves who you are; nothing else will push for you.
    if (me.value?.githubSignIn === 'identity') return 'none - paste a token: signing in with GitHub here grants no repository access'
    return 'none - runs use the server\'s own GitHub login'
  }
  const who = p.githubLogin ? `@${p.githubLogin}` : 'your account'
  return p.githubTokenSource === 'pasted'
    ? `your own token for ${who}; kept when you sign in again`
    : `from GitHub sign-in, as ${who}; refreshed each time you sign in`
})

async function testJira() {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await $fetch<{ ok: boolean, message: string }>('/api/me/jira-test', { method: 'POST' })
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader title="Profile" />
    <div class="px-6 py-4 space-y-6 max-w-2xl">
      <div v-if="me" class="flex items-center gap-3">
        <img v-if="me.avatar" :src="me.avatar" alt="" class="size-10 rounded-full" />
        <div>
          <div class="t-body font-medium" style="color: var(--text-primary);">{{ me.name || me.login }}</div>
          <div class="t-small text-label">@{{ me.login }} · GitHub: {{ githubStatus }}</div>
        </div>
      </div>

      <div v-if="setup" class="rounded-xl p-4 space-y-3" style="background: var(--accent-muted); border: 1px solid var(--accent);">
        <div class="t-ui font-medium" style="color: var(--text-primary);">Finish setting up</div>
        <p class="t-small text-label">You are signed in. Add your tokens below once; they are stored encrypted and used only for runs you start.</p>
        <ul class="space-y-1.5">
          <li v-for="step in setupSteps" :key="step.key" class="flex items-start gap-2 t-small">
            <UIcon :name="step.done ? 'i-lucide-circle-check' : 'i-lucide-circle'" class="size-4 shrink-0 mt-0.5" :style="{ color: step.done ? 'var(--success)' : 'var(--text-disabled)' }" />
            <span style="color: var(--text-primary);"><span class="font-medium">{{ step.name }}</span> - <span class="text-label">{{ step.why }}</span></span>
          </li>
        </ul>
        <div class="flex items-center gap-3">
          <!-- Shown only once it can be used: a link button ignores `disabled`. -->
          <UButton v-if="me?.profile.hasAnthropicToken" label="Continue to the app" size="sm" to="/" />
          <span v-else class="t-small text-label">Add your Claude token below to continue.</span>
          <span v-if="me?.profile.hasAnthropicToken && !me?.profile.hasGithubToken" class="t-small text-label">You can add the GitHub token later.</span>
        </div>
      </div>

      <div class="rounded-xl p-4 space-y-3" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <div class="t-ui font-medium" style="color: var(--text-primary);">Claude</div>
        <p class="t-small text-label">
          Every agent you start - runs, watches and schedules you own, chat, Studio - runs on your own Claude credential; this instance does not lend one.
          Paste the token <code>claude setup-token</code> prints, or a workspace-scoped API key. It is stored encrypted and never shown again.
        </p>
        <div class="field-group">
          <label class="field-label">
            Token or API key
            <span class="t-small font-normal ml-1" style="color: var(--text-disabled);">
              {{ me?.authDisabled ? 'not needed in local mode' : me?.profile.hasAnthropicToken ? `${me.profile.anthropicKind === 'apikey' ? 'API key' : 'subscription token'} stored; paste a new one to replace it` : 'not stored - your runs and chats will not start' }}
            </span>
          </label>
          <input v-model="claudeToken" type="password" class="field-input w-full" placeholder="sk-ant-oat… or sk-ant-api…" autocomplete="off" />
        </div>
        <div class="flex items-center gap-2">
          <UButton label="Save" size="sm" :loading="savingClaude" :disabled="!claudeToken.trim()" @click="saveClaude()" />
          <UButton v-if="me?.profile.hasAnthropicToken" label="Remove" size="sm" variant="soft" color="error" :loading="savingClaude" @click="saveClaude(true)" />
        </div>
      </div>

      <div class="rounded-xl p-4 space-y-3" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <div class="t-ui font-medium" style="color: var(--text-primary);">GitHub</div>
        <p class="t-small text-label">
          Runs you start push and open pull requests with this token. Signing in with GitHub stores one for you; paste your own
          instead - a fine-grained token, or one for a password account - and it is kept when you sign in again. GitHub is asked
          whose it is before it is saved.
        </p>
        <div class="field-group">
          <label class="field-label">
            Personal access token
            <span class="t-small font-normal ml-1" style="color: var(--text-disabled);">{{ githubStatus }}</span>
          </label>
          <input v-model="githubToken" type="password" class="field-input w-full" placeholder="github_pat_… or ghp_…" autocomplete="off" />
        </div>
        <div class="flex items-center gap-2">
          <UButton label="Save" size="sm" :loading="savingGithub" :disabled="!githubToken.trim()" @click="saveGithub()" />
          <UButton v-if="me?.profile.githubTokenSource === 'pasted'" label="Remove" size="sm" variant="soft" color="error" :loading="savingGithub" @click="saveGithub(true)" />
        </div>
      </div>

      <div class="rounded-xl p-4 space-y-3" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <div class="t-ui font-medium" style="color: var(--text-primary);">Jira</div>
        <p class="t-small text-label">
          Runs you start read tickets and post their outcome as you. The token is stored encrypted on the server and never shown again.
          Create one at id.atlassian.com under Security, API tokens.
        </p>
        <div class="field-group">
          <label class="field-label">Atlassian email</label>
          <input v-model="jiraEmail" class="field-input w-full" placeholder="you@alepo.com" autocomplete="email" />
        </div>
        <div class="field-group">
          <label class="field-label">API token <span class="t-small font-normal ml-1" style="color: var(--text-disabled);">{{ me?.profile.hasJiraToken ? 'stored; paste a new one to replace it' : 'not stored' }}</span></label>
          <input v-model="jiraToken" type="password" class="field-input w-full" placeholder="paste to set or replace" autocomplete="off" />
        </div>
        <div class="flex items-center gap-2">
          <UButton label="Save" size="sm" :loading="saving" @click="save" />
          <UButton label="Test connection" size="sm" variant="soft" :loading="testing" :disabled="!me?.profile.hasJiraToken" @click="testJira" />
          <span v-if="testResult" class="t-small" :style="{ color: testResult.ok ? 'var(--success)' : 'var(--error)' }">{{ testResult.message }}</span>
        </div>
      </div>

      <div class="rounded-xl p-4 space-y-3" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <div class="t-ui font-medium flex items-center gap-2" style="color: var(--text-primary);">
          Preferences <ScopeChip scope="yours" />
        </div>
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="t-ui font-medium">Labs pages</div>
            <p class="t-small text-label mt-0.5">
              Show Graph beside Workflows, Explore beside Plugins, and Output Styles in Settings. They work, but are not part of the daily
              set yet. This affects only your own view - nobody else's changes.
            </p>
          </div>
          <label class="field-toggle">
            <input
              type="checkbox"
              aria-label="Labs features"
              :checked="me?.profile.labs === true"
              :disabled="savingLabs"
              @change="setLabs(($event.target as HTMLInputElement).checked)"
            />
            <span class="field-toggle__track"><span class="field-toggle__thumb" /></span>
          </label>
        </div>
      </div>
    </div>
  </div>
</template>
