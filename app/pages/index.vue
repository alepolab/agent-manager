<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import { RUN_STATUS_COLOR } from '~/utils/runStatus'

/**
 * Home answers "what needs me" first, then "what did I run", then "how is
 * the team set up", and offers one primary action: start a run from a ticket.
 */
const { me } = useUser()
const { agents, fetchAll: fetchAgents } = useAgents()
const { commands, fetchAll: fetchCommands } = useCommands()
const { skills, fetchAll: fetchSkills } = useSkills()
const { workflows, fetchAll: fetchWorkflows } = useWorkflows()
const toast = useToast()

const runs = ref<WorkflowRun[]>([])
const escalated = ref<{ key: string, watchId: string, lastError?: string, updatedAt: number }[]>([])
const team = ref<{ pluginVersion: string | null, drifted: number, registry: { ok: boolean, products: number } } | null>(null)
const loaded = ref(false)

async function refresh() {
  const [r, t] = await Promise.allSettled([$fetch<WorkflowRun[]>('/api/runs'), $fetch<typeof team.value>('/api/team/status')])
  if (r.status === 'fulfilled') runs.value = r.value
  if (t.status === 'fulfilled') team.value = t.value
  try {
    const watches = await $fetch<{ id: string }[]>('/api/watches')
    const states = await Promise.all(watches.map(w => $fetch<Record<string, { key: string, watchId: string, disposition: string, lastError?: string, updatedAt: number }>>(`/api/watches/${w.id}/state`).catch(() => ({}))))
    escalated.value = states.flatMap(s => Object.values(s)).filter(t => t.disposition === 'escalated')
  } catch { escalated.value = [] }
  loaded.value = true
}
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  refresh()
  if (!agents.value.length) fetchAgents()
  if (!commands.value.length) fetchCommands()
  if (!skills.value.length) fetchSkills()
  if (!workflows.value.length) fetchWorkflows()
  timer = setInterval(() => { if (runs.value.some(r => r.status === 'running' || r.status === 'paused')) refresh() }, 10_000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })

const hasContent = computed(() => agents.value.length > 0 || commands.value.length > 0 || skills.value.length > 0)

const attention = computed(() => runs.value.filter(r =>
  ['paused', 'failed', 'interrupted'].includes(r.status) || r.ci?.status === 'failing'))
const mine = computed(() => runs.value.filter(r => r.startedBy && r.startedBy === me.value?.login).slice(0, 8))
const dayAgo = Date.now() - 86_400_000, weekAgo = Date.now() - 7 * 86_400_000
const cost = computed(() => ({
  today: runs.value.filter(r => r.startedAt >= dayAgo).reduce((a, r) => a + (r.usage?.usd ?? 0), 0),
  week: runs.value.filter(r => r.startedAt >= weekAgo).reduce((a, r) => a + (r.usage?.usd ?? 0), 0),
  runsWeek: runs.value.filter(r => r.startedAt >= weekAgo).length,
}))

const ticket = ref('')
const starting = ref(false)
/** Where the registry would route this ticket; shown before Start so the wrong stack is never a surprise. */
const routing = ref<{ name: string, suite: string | null, repos: string[], recipe: boolean } | null | undefined>(undefined)
let routeTimer: ReturnType<typeof setTimeout> | null = null
watch(ticket, (t) => {
  if (routeTimer) clearTimeout(routeTimer)
  if (!t.trim()) { routing.value = undefined; return }
  routeTimer = setTimeout(async () => {
    try { routing.value = (await $fetch<{ product: typeof routing.value }>('/api/registry/resolve', { query: { q: t.trim().slice(0, 2000) } })).product }
    catch { routing.value = undefined }
  }, 400)
})
const runbook = computed(() => workflows.value.find(w => w.slug.startsWith('runbook')) ?? workflows.value[0])
async function startFromTicket() {
  if (!ticket.value.trim() || !runbook.value) return
  starting.value = true
  try {
    const run = await $fetch<WorkflowRun>(`/api/workflows/${runbook.value.slug}/runs`, { method: 'POST', body: { initialPrompt: ticket.value.trim(), autoRun: false } })
    ticket.value = ''
    await navigateTo(`/workflows/${run.workflowSlug}?run=${run.id}`)
  } catch (e: any) {
    if (e?.statusCode === 409 && e?.data?.data?.runId) await navigateTo(`/workflows/${runbook.value.slug}?run=${e.data.data.runId}`)
    else toast.add({ title: 'Could not start the run', description: e.data?.message || e.message, color: 'error' })
  } finally {
    starting.value = false
  }
}

const why = (r: WorkflowRun) => r.status === 'paused' ? `paused before ${r.steps.find(s => r.nextStepIds.includes(s.stepId))?.label ?? 'the next step'}`
  : r.status === 'failed' ? (r.error || `failed at ${r.steps.find(s => s.status === 'failed')?.label ?? 'a step'}`)
  : r.status === 'interrupted' ? 'server restarted; resume it'
  : r.ci?.status === 'failing' ? 'CI failing on the PR' : r.status
const ago = (ms: number) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago` }
</script>

<template>
  <div>
    <PageHeader title="Dashboard" />
    <div class="px-6 py-4 space-y-6">
      <WelcomeOnboarding v-if="loaded && !hasContent" @created="(agent) => navigateTo(`/agents/${agent.slug}`)" />

      <!-- Primary action -->
      <form class="rounded-xl p-4 flex flex-wrap items-end gap-3" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);" @submit.prevent="startFromTicket">
        <div class="flex-1 min-w-[16rem]">
          <label class="field-label">Start a run from a ticket</label>
          <input v-model="ticket" class="field-input w-full" placeholder="SCN-402, or paste the ticket text" :disabled="!runbook" />
          <span class="field-hint">{{ runbook ? `Runs ${runbook.name}. A bare key is expanded from Jira when your profile has a token.` : 'Create a workflow first.' }}</span>
          <span v-if="routing" class="field-hint block" style="color: var(--success);">Routes to {{ routing.name }}{{ routing.suite ? ` (${routing.suite})` : '' }}: {{ routing.repos.join(', ') || 'no repos listed' }}{{ routing.recipe ? '' : ', no recipe yet' }}</span>
          <span v-else-if="routing === null" class="field-hint block" style="color: var(--warning);">No product in the registry matches this ticket. Intake will work from the text alone; add the project key or a product label to route it.</span>
        </div>
        <UButton type="submit" label="Start" icon="i-lucide-play" :loading="starting" :disabled="!ticket.trim() || !runbook" />
      </form>

      <!-- Needs attention -->
      <section>
        <h2 class="text-section-label mb-2">Needs attention <span class="text-meta font-normal">{{ attention.length + escalated.length }}</span></h2>
        <div v-if="!loaded" class="space-y-2"><SkeletonCard v-for="i in 2" :key="i" /></div>
        <p v-else-if="!attention.length && !escalated.length" class="text-[13px] text-label">Nothing waiting on you.</p>
        <div v-else class="space-y-1">
          <NuxtLink v-for="r in attention" :key="r.id" :to="`/workflows/${r.workflowSlug}?run=${r.id}`" class="flex items-center gap-3 rounded-lg px-3 py-2 text-[12px] focus-ring" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
            <span class="font-mono uppercase text-[11px] w-20 shrink-0" :style="{ color: RUN_STATUS_COLOR[r.status] }">{{ r.status }}</span>
            <span class="font-medium truncate" style="color: var(--text-primary);">{{ (r.initialPrompt.split('\n')[0] ?? '').slice(0, 60) }}</span>
            <span class="text-label truncate">{{ why(r) }}</span>
            <span class="ml-auto text-label whitespace-nowrap">{{ r.startedBy || '' }} · {{ ago(r.startedAt) }}</span>
          </NuxtLink>
          <NuxtLink v-for="t in escalated" :key="t.watchId + t.key" to="/watches" class="flex items-center gap-3 rounded-lg px-3 py-2 text-[12px] focus-ring" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
            <span class="font-mono uppercase text-[11px] w-20 shrink-0" style="color: var(--error);">escalated</span>
            <span class="font-medium truncate" style="color: var(--text-primary);">{{ t.key }}</span>
            <span class="text-label truncate">{{ t.lastError || 'attempts exhausted; clear the escalation on the watch to retry' }}</span>
            <span class="ml-auto text-label whitespace-nowrap">{{ t.watchId }} · {{ ago(t.updatedAt) }}</span>
          </NuxtLink>
        </div>
      </section>

      <div class="grid md:grid-cols-3 gap-4">
        <!-- My runs -->
        <section class="md:col-span-2">
          <h2 class="text-section-label mb-2">My recent runs</h2>
          <p v-if="loaded && !mine.length" class="text-[13px] text-label">No runs started by you yet.</p>
          <div v-else class="space-y-1">
            <NuxtLink v-for="r in mine" :key="r.id" :to="`/workflows/${r.workflowSlug}?run=${r.id}`" class="flex items-center gap-3 rounded-lg px-3 py-2 text-[12px] focus-ring" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
              <span class="font-mono uppercase text-[11px] w-20 shrink-0" :style="{ color: RUN_STATUS_COLOR[r.status] }">{{ r.status }}</span>
              <span class="truncate" style="color: var(--text-primary);">{{ (r.initialPrompt.split('\n')[0] ?? '').slice(0, 60) }}</span>
              <div class="w-24 shrink-0"><RunProgressBar :steps="r.steps" /></div>
              <span class="ml-auto text-label whitespace-nowrap">{{ r.usage ? '$' + r.usage.usd.toFixed(2) : '' }} · {{ ago(r.startedAt) }}</span>
            </NuxtLink>
          </div>
        </section>

        <!-- Team + cost -->
        <section class="space-y-3">
          <div class="rounded-xl p-4 text-[12px] space-y-1" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
            <div class="text-section-label mb-1">Cost</div>
            <div class="flex justify-between"><span class="text-label">Today</span><span class="font-mono tabular-nums">${{ cost.today.toFixed(2) }}</span></div>
            <div class="flex justify-between"><span class="text-label">This week</span><span class="font-mono tabular-nums">${{ cost.week.toFixed(2) }} · {{ cost.runsWeek }} runs</span></div>
          </div>
          <NuxtLink to="/team" class="block rounded-xl p-4 text-[12px] space-y-1 focus-ring" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
            <div class="text-section-label mb-1">Team standards</div>
            <template v-if="team">
              <div class="flex justify-between"><span class="text-label">Plugin</span><span>{{ team.pluginVersion ?? 'not installed' }}</span></div>
              <div class="flex justify-between"><span class="text-label">Registry</span><span>{{ team.registry.ok ? `${team.registry.products} products` : 'unreadable' }}</span></div>
              <div class="flex justify-between"><span class="text-label">Drift</span><span :style="{ color: team.drifted ? 'var(--warning)' : 'var(--success)' }">{{ team.drifted ? `${team.drifted} item(s)` : 'in sync' }}</span></div>
            </template>
            <span v-else class="text-label">Checking…</span>
          </NuxtLink>
          <div class="rounded-xl p-4 text-[12px]" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
            <div class="text-section-label mb-1">Setup</div>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1">
              <NuxtLink to="/agents" class="flex justify-between focus-ring"><span class="text-label">Agents</span><span>{{ agents.length }}</span></NuxtLink>
              <NuxtLink to="/commands" class="flex justify-between focus-ring"><span class="text-label">Commands</span><span>{{ commands.length }}</span></NuxtLink>
              <NuxtLink to="/skills" class="flex justify-between focus-ring"><span class="text-label">Skills</span><span>{{ skills.length }}</span></NuxtLink>
              <NuxtLink to="/workflows" class="flex justify-between focus-ring"><span class="text-label">Workflows</span><span>{{ workflows.length }}</span></NuxtLink>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
