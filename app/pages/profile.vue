<script setup lang="ts">
import { errorToast } from '~/utils/errorToast'

const { me, load } = useUser()
const toast = useToast()
const jiraEmail = ref('')
const jiraToken = ref('')
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
          <div class="t-small text-label">@{{ me.login }} · GitHub token {{ me.profile.hasGithubToken ? 'stored' : (me.authDisabled ? 'not needed in local mode' : 'missing, sign in again') }}</div>
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
              Show Graph, Explore and Output styles in your sidebar. They work, but are not part of the daily
              set yet. This affects only your own view - nobody else's sidebar changes.
            </p>
          </div>
          <label class="field-toggle">
            <input
              type="checkbox"
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
