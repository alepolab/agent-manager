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
          <div class="text-[14px] font-medium" style="color: var(--text-primary);">{{ me.name || me.login }}</div>
          <div class="text-[12px] text-label">@{{ me.login }} · GitHub token {{ me.profile.hasGithubToken ? 'stored' : (me.authDisabled ? 'not needed in local mode' : 'missing, sign in again') }}</div>
        </div>
      </div>

      <div class="rounded-xl p-4 space-y-3" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <div class="text-[13px] font-medium" style="color: var(--text-primary);">Jira</div>
        <p class="text-[12px] text-label">
          Runs you start read tickets and post their outcome as you. The token is stored encrypted on the server and never shown again.
          Create one at id.atlassian.com under Security, API tokens.
        </p>
        <div class="field-group">
          <label class="field-label">Atlassian email</label>
          <input v-model="jiraEmail" class="field-input w-full" placeholder="you@alepo.com" autocomplete="email" />
        </div>
        <div class="field-group">
          <label class="field-label">API token <span class="text-[10px] font-normal ml-1" style="color: var(--text-disabled);">{{ me?.profile.hasJiraToken ? 'stored; paste a new one to replace it' : 'not stored' }}</span></label>
          <input v-model="jiraToken" type="password" class="field-input w-full" placeholder="paste to set or replace" autocomplete="off" />
        </div>
        <div class="flex items-center gap-2">
          <UButton label="Save" size="sm" :loading="saving" @click="save" />
          <UButton label="Test connection" size="sm" variant="soft" :loading="testing" :disabled="!me?.profile.hasJiraToken" @click="testJira" />
          <span v-if="testResult" class="text-[12px]" :style="{ color: testResult.ok ? 'var(--success)' : 'var(--error)' }">{{ testResult.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
