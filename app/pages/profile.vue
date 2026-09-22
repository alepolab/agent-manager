<script setup lang="ts">
const { me, load } = useUser()
const toast = useToast()
const jiraEmail = ref('')
const jiraToken = ref('')
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean, message: string } | null>(null)

onMounted(async () => {
  if (!me.value) await load()
  jiraEmail.value = me.value?.profile.jiraEmail ?? ''
})

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
  } catch (e: any) {
    // With no catch the spinner simply stopped and nothing appeared, which
    // reads exactly like a test that passed quietly. A connection test whose
    // failure is silent is worse than no test: it is the one control on this
    // page whose whole job is to tell you the credential does not work.
    testResult.value = { ok: false, message: e.data?.message || e.message || 'Could not reach Jira' }
  } finally {
    testing.value = false
  }
}

/**
 * Forget the stored token.
 *
 * The server has supported this since it was written — me.put.ts says "an
 * empty token clears it" and saveProfile honours it — but `save()` only sends
 * the field when the box is non-empty, so nothing could ever reach it. A
 * person whose token was revoked at Atlassian, or who is leaving the team,
 * had no way to stop runs from continuing to act as them.
 */
async function clearJiraToken() {
  saving.value = true
  try {
    await $fetch('/api/me', { method: 'PUT', body: { jiraToken: '' } })
    jiraToken.value = ''
    testResult.value = null
    await load()
    toast.add({ title: 'Jira token removed', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Could not remove the token', description: e.data?.message || e.message, color: 'error' })
  } finally {
    saving.value = false
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
          <!-- Sits after the two routine actions, not between them: removing
               the credential is the rare act on this page. -->
          <UButton
            v-if="me?.profile.hasJiraToken"
            label="Remove stored token"
            size="sm"
            variant="ghost"
            color="error"
            :loading="saving"
            @click="clearJiraToken"
          />
          <span v-if="testResult" class="t-small" :style="{ color: testResult.ok ? 'var(--success)' : 'var(--error)' }">{{ testResult.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
