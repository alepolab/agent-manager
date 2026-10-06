<script setup lang="ts">
definePageMeta({ layout: false })
const route = useRoute()
const next = computed(() => typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : '/')
const error = ref(typeof route.query.error === 'string' ? route.query.error : '')
const doors = ref<{ passwordLogin: boolean, githubLogin: boolean }>({ passwordLogin: false, githubLogin: true })

// Taken in setup: after an await the Nuxt context, and with it useState, is gone.
const { load } = useUser()

const username = ref('')
const password = ref('')
const signingIn = ref(false)

onMounted(async () => {
  try {
    const config = await $fetch<{ authDisabled: boolean, passwordLogin?: boolean, githubLogin?: boolean }>('/api/config')
    if (config.authDisabled) return navigateTo(next.value)
    doors.value = { passwordLogin: !!config.passwordLogin, githubLogin: config.githubLogin !== false }
  } catch { /* stay */ }
})

async function signIn() {
  if (signingIn.value) return
  error.value = ''
  signingIn.value = true
  try {
    await $fetch('/api/auth/password', { method: 'POST', body: { username: username.value, password: password.value } })
    // The route guard loaded the user while signed out; load it again.
    await load()
    await navigateTo(next.value)
  } catch (err: any) {
    error.value = err?.data?.message || err?.statusMessage || 'Sign-in failed'
    password.value = ''
  } finally {
    signingIn.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center px-6" style="background: var(--surface-base);">
    <div class="w-full max-w-sm rounded-2xl p-8 space-y-5" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <div class="flex items-center gap-3">
        <img src="/brand/alepo-logo-light.png" alt="Alepo" class="h-8 w-auto dark:hidden">
        <img src="/brand/alepo-logo-dark.png" alt="Alepo" class="h-8 w-auto hidden dark:block">
        <div class="pl-3" style="border-left: 1px solid var(--border-default);">
          <div class="t-body font-semibold" style="color: var(--text-primary);">Agent Manager</div>
          <div class="t-small text-label">Alepo engineering</div>
        </div>
      </div>

      <form v-if="doors.passwordLogin" class="space-y-3" @submit.prevent="signIn">
        <label class="block space-y-1">
          <span class="t-small text-label">Username</span>
          <UInput v-model="username" name="username" autocomplete="username" autofocus required class="w-full" />
        </label>
        <label class="block space-y-1">
          <span class="t-small text-label">Password</span>
          <UInput v-model="password" name="password" type="password" autocomplete="current-password" required class="w-full" />
        </label>
        <p v-if="error" role="alert" class="t-small rounded-lg px-3 py-2" style="background: rgba(248, 113, 113, 0.08); color: var(--error);">{{ error }}</p>
        <UButton type="submit" label="Sign in" block :loading="signingIn" :disabled="!username || !password" />
      </form>

      <template v-if="doors.githubLogin">
        <p v-if="!doors.passwordLogin" class="t-ui leading-relaxed text-label">
          Sign in with your GitHub account. Membership of the alepolab organisation is required, and runs you start push and open pull requests as you.
        </p>
        <p v-if="error && !doors.passwordLogin" role="alert" class="t-small rounded-lg px-3 py-2" style="background: rgba(248, 113, 113, 0.08); color: var(--error);">{{ error }}</p>
        <UButton label="Sign in with GitHub" icon="i-lucide-github" block :variant="doors.passwordLogin ? 'outline' : 'solid'" to="/api/auth/login" external />
      </template>
    </div>
  </div>
</template>
