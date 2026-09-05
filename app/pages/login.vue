<script setup lang="ts">
definePageMeta({ layout: false })
const route = useRoute()
const error = computed(() => typeof route.query.error === 'string' ? route.query.error : '')
onMounted(async () => {
  try { if ((await $fetch<{ authDisabled: boolean }>('/api/config')).authDisabled) await navigateTo(typeof route.query.next === 'string' ? route.query.next : '/') } catch { /* stay */ }
})
</script>

<template>
  <div class="min-h-screen flex items-center justify-center px-6" style="background: var(--surface-base);">
    <div class="w-full max-w-sm rounded-2xl p-8 space-y-5" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <div class="flex items-center gap-3">
        <div class="size-10 rounded-xl flex items-center justify-center" style="background: var(--accent-muted); border: 1px solid rgba(229, 169, 62, 0.15);">
          <UIcon name="i-lucide-bot" class="size-5" style="color: var(--accent);" />
        </div>
        <div>
          <div class="text-[15px] font-semibold" style="color: var(--text-primary);">Agent Manager</div>
          <div class="text-[12px] text-label">Alepo engineering</div>
        </div>
      </div>
      <p class="text-[13px] leading-relaxed text-label">
        Sign in with your GitHub account. Membership of the alepolab organisation is required, and runs you start push and open pull requests as you.
      </p>
      <p v-if="error" class="text-[12px] rounded-lg px-3 py-2" style="background: rgba(248, 113, 113, 0.08); color: var(--error);">{{ error }}</p>
      <UButton label="Sign in with GitHub" icon="i-lucide-github" block to="/api/auth/login" external />
    </div>
  </div>
</template>
