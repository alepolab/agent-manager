<script setup lang="ts">
interface Item { id?: string, name?: string, state: 'ok' | 'drifted' | 'missing' }
interface TeamStatus {
  pluginVersion: string | null
  pluginInstallPath: string | null
  agents: Item[]
  skills: Item[]
  commands: Item[]
  workflow: { slug: string, state: Item['state'], steps: number }
  registry: { ok: boolean, products: number, path: string | null }
  drifted: number
  checkedAt: number
}
const status = ref<TeamStatus | null>(null)
const loading = ref(true)
const syncing = ref(false)
const error = ref<string | null>(null)
const toast = useToast()

async function refresh() {
  loading.value = true
  try { status.value = await $fetch<TeamStatus>('/api/team/status'); error.value = null }
  catch (e: any) { error.value = e.data?.message || e.message }
  finally { loading.value = false }
}
async function sync() {
  syncing.value = true
  try {
    status.value = await $fetch<TeamStatus>('/api/team/sync', { method: 'POST' })
    toast.add({ title: 'Team standards applied', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Sync failed', description: e.data?.message || e.message, color: 'error' })
  } finally { syncing.value = false }
}
onMounted(refresh)
const color = (s: Item['state']) => s === 'ok' ? 'var(--success)' : s === 'missing' ? 'var(--error)' : 'var(--warning)'
</script>

<template>
  <div>
    <PageHeader title="Team">
      <template #right>
        <UButton label="Apply team standards" icon="i-lucide-refresh-cw" size="sm" :loading="syncing" :disabled="!status || status.drifted === 0" @click="sync" />
      </template>
    </PageHeader>
    <div class="px-6 py-4 space-y-5 max-w-3xl">
      <p class="text-[13px] leading-relaxed text-label">
        The team's agents, skills, workflow, registry and hooks ship in the alepo-engineering plugin and the app's templates. This page shows what on this instance differs from them. Applying rewrites only the team-owned files; everything else in the config directory is left alone.
      </p>
      <div v-if="error" class="text-[12px]" style="color: var(--error);">{{ error }}</div>
      <div v-else-if="loading && !status" class="space-y-2"><SkeletonCard v-for="i in 2" :key="i" /></div>
      <template v-else-if="status">
        <div class="rounded-xl p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-[12px]" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
          <div><div class="text-label">Plugin</div><div class="font-medium" style="color: var(--text-primary);">{{ status.pluginVersion ? `alepo-engineering ${status.pluginVersion}` : 'not installed' }}</div></div>
          <div><div class="text-label">Registry</div><div class="font-medium" :style="{ color: status.registry.ok ? 'var(--text-primary)' : 'var(--error)' }">{{ status.registry.ok ? `${status.registry.products} products` : 'not readable' }}</div></div>
          <div><div class="text-label">Workflow</div><div class="font-medium" :style="{ color: color(status.workflow.state) }">{{ status.workflow.state }} · {{ status.workflow.steps }} steps</div></div>
          <div><div class="text-label">Drift</div><div class="font-medium" :style="{ color: status.drifted ? 'var(--warning)' : 'var(--success)' }">{{ status.drifted ? `${status.drifted} item(s)` : 'in sync' }}</div></div>
        </div>
        <div class="grid md:grid-cols-3 gap-4">
          <div class="rounded-xl p-4" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
            <div class="text-[12px] font-medium mb-2" style="color: var(--text-primary);">Agents</div>
            <div v-for="a in status.agents" :key="a.id" class="flex items-center justify-between text-[12px] py-0.5">
              <span class="font-mono">{{ a.id }}</span><span :style="{ color: color(a.state) }">{{ a.state }}</span>
            </div>
          </div>
          <div class="rounded-xl p-4" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
            <div class="text-[12px] font-medium mb-2" style="color: var(--text-primary);">Skills</div>
            <p v-if="!status.skills.length" class="text-[12px] text-label">None shipped by the plugin.</p>
            <div v-for="s in status.skills" :key="s.name" class="flex items-center justify-between text-[12px] py-0.5">
              <span class="font-mono">{{ s.name }}</span><span :style="{ color: color(s.state) }">{{ s.state }}</span>
            </div>
          </div>
          <div class="rounded-xl p-4" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
            <div class="text-[12px] font-medium mb-2" style="color: var(--text-primary);">Commands</div>
            <p v-if="!status.commands.length" class="text-[12px] text-label">None shipped by the plugin.</p>
            <div v-for="c in status.commands" :key="c.name" class="flex items-center justify-between text-[12px] py-0.5">
              <span class="font-mono">/{{ c.name }}</span><span :style="{ color: color(c.state) }">{{ c.state }}</span>
            </div>
          </div>
        </div>
        <p class="text-[11px] text-label">Checked {{ new Date(status.checkedAt).toLocaleTimeString() }}. <button class="underline" @click="refresh">Check again</button></p>
      </template>
    </div>
  </div>
</template>
