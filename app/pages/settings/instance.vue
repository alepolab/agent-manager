<script setup lang="ts">
/**
 * What this server is actually running, as it booted.
 *
 * Read-only for everyone, operators included, which is exactly why it is worth
 * showing to everyone: it is the page that answers "is the watcher on", "which
 * credentials are set", "where does my evidence land" without anyone needing
 * the power to change any of it.
 */
const { instance, load } = useInstanceInfo()
onMounted(load)
</script>

<template>
  <div>
    <PageHeader title="Settings" />
    <SettingsNav />

    <div class="px-6 py-4 space-y-6">
      <div v-if="!instance" class="flex justify-center py-16">
        <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-meta" />
      </div>

      <div v-else class="rounded-xl p-5 space-y-4 bg-card">
        <h3 class="text-section-title flex items-center gap-2">Instance <ScopeChip scope="server" /></h3>
        <p class="t-small text-meta">
          What this server is actually running, as it booted. None of it is editable here: every switch below is
          read once at startup, before the timer it controls exists, so a toggle would save cleanly and change
          nothing until a restart. Each row names the variable to set instead.
        </p>

        <div>
          <div class="t-ui font-medium mb-2">Automations</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            <div v-for="a in instance.automations" :key="a.envVar" class="flex items-center gap-2 t-small">
              <span class="size-1.5 rounded-full shrink-0" :style="{ background: a.enabled ? 'var(--success)' : 'var(--text-disabled)' }" />
              <span>{{ a.name }}</span>
              <span class="text-label">{{ a.enabled ? (a.detail ?? 'on') : 'off' }}</span>
              <code class="t-small text-label ml-auto">{{ a.envVar }}</code>
            </div>
          </div>
        </div>

        <div>
          <div class="t-ui font-medium mb-2">Paths</div>
          <div class="grid grid-cols-1 gap-y-1 t-small">
            <div><span class="text-label">Config</span> <code class="ml-2">{{ instance.paths.claudeDir }}</code></div>
            <div><span class="text-label">Run evidence</span> <code class="ml-2">{{ instance.paths.agentRunsDir }}</code></div>
            <div><span class="text-label">Checkouts</span> <code class="ml-2">{{ instance.paths.workspaceRoot }}</code></div>
            <div><span class="text-label">Developer profiles</span> <code class="ml-2">{{ instance.paths.usersDir }}</code></div>
          </div>
        </div>

        <div>
          <div class="t-ui font-medium mb-2">Credentials</div>
          <div class="t-small text-meta mb-2">Presence only — no value is ever sent to this page.</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            <div v-for="s in instance.secrets" :key="s.name" class="flex items-center gap-2 t-small">
              <span class="size-1.5 rounded-full shrink-0" :style="{ background: s.set ? 'var(--success)' : 'var(--text-disabled)' }" />
              <code class="t-small">{{ s.name }}</code>
              <span class="text-label ml-auto">{{ s.set ? 'set' : 'not set' }}</span>
            </div>
          </div>
        </div>

        <div class="t-small">
          <span class="text-label">Sign-in</span>
          <span class="ml-2">{{ instance.identity.authDisabled ? 'disabled (every request is the local developer)' : `GitHub${instance.identity.githubOrg ? `, ${instance.identity.githubOrg}` : ''}` }}</span>
          <code class="t-small text-label ml-2">AUTH_DISABLED, GITHUB_ORG</code>
          <NuxtLink to="/roles" class="text-label underline focus-ring ml-2">roles</NuxtLink>
        </div>
      </div>
    </div>
  </div>
</template>
