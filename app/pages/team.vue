<script setup lang="ts">
type State = 'ok' | 'drifted' | 'missing'
type Source = 'plugin' | 'shipped' | 'other' | null
interface Item { id?: string, name?: string, state: State, diff?: string }
interface TeamStatus {
  pluginVersion: string | null
  pluginInstallPath: string | null
  shippedVersion: string | null
  sources: { skills: Source, commands: Source, watches: Source, registry: Source }
  agents: Item[]
  skills: Item[]
  commands: Item[]
  workflow: { slug: string, state: State, steps: number, diff?: string }
  watches: Item[]
  registry: { ok: boolean, products: number, path: string | null, items: { key: string, suite?: string, repos: string[], recipe: boolean }[] }
  unresolvedSkills: string[]
  enforcement: { ok: boolean, checks: { name: string, armed: boolean, source?: string }[], error?: string }
  lastApplied: { by: string, at: number, items: number } | null
  instance: { claudeDir: string, runsDir: string, workspaceRoot: string, auth: string, githubOrg: string, jiraRead: boolean, jiraPost: boolean, slack: boolean, ciPoller: boolean, budget: { maxMinutes: number, maxTokens: number } }
  drifted: number
  checkedAt: number
}
const status = ref<TeamStatus | null>(null)
interface Checkout { path: string, name: string, owner?: string, exists: boolean, git: boolean, branch?: string, head?: string, dirty: number, dirtyFiles: string[] }
const checkouts = ref<Checkout[]>([])
const checkoutsError = ref<string | null>(null)
const stashing = ref<string | null>(null)
async function loadCheckouts() {
  try { checkouts.value = await $fetch<Checkout[]>('/api/workspace'); checkoutsError.value = null }
  catch (e: any) { checkouts.value = []; checkoutsError.value = e.data?.message || e.message }
}
async function stash(c: Checkout) {
  if (!confirm(`Park ${c.dirty} uncommitted change(s) in ${c.name}?\n\nThey go into a git stash; restore with: git -C ${c.path} stash pop`)) return
  stashing.value = c.path
  try {
    const r = await $fetch<{ stashed: boolean, message: string }>('/api/workspace/stash', { method: 'POST', body: { path: c.path } })
    toast.add({ title: r.stashed ? `Parked ${c.dirty} change(s) in ${c.name}` : `${c.name} was already clean`, description: r.stashed ? `Restore with: git -C ${c.path} stash pop` : undefined, color: 'success' })
    await loadCheckouts()
  } catch (e: any) {
    toast.add({ title: 'Could not park changes', description: e.data?.message || e.message, color: 'error' })
  } finally { stashing.value = null }
}
const loading = ref(true)
/** 'all' while the global apply runs, else the key of the one item being applied. */
const syncing = ref<string | null>(null)
const error = ref<string | null>(null)
const toast = useToast()

async function refresh() {
  loading.value = true
  try { status.value = await $fetch<TeamStatus>('/api/team/status'); error.value = null }
  catch (e: any) { error.value = e.data?.message || e.message }
  finally { loading.value = false }
}

/** Every item that is not in sync, flattened so one list can carry the diff and the per-item action. */
interface Attention { key: string, kind: string, label: string, state: State, diff?: string, to?: string }
const attention = computed<Attention[]>(() => {
  const s = status.value
  if (!s) return []
  const rows: Attention[] = []
  const editable = (state: State, to: string) => state === 'drifted' ? to : undefined
  for (const a of s.agents) if (a.state !== 'ok') rows.push({ key: `agent:${a.id}`, kind: 'agent', label: a.id!, state: a.state, diff: a.diff, to: editable(a.state, `/agents/${a.id}`) })
  for (const x of s.skills) if (x.state !== 'ok') rows.push({ key: `skill:${x.name}`, kind: 'skill', label: x.name!, state: x.state, diff: x.diff, to: editable(x.state, `/skills/${x.name}`) })
  for (const c of s.commands) if (c.state !== 'ok') rows.push({ key: `command:${c.name}`, kind: 'command', label: `/${c.name}`, state: c.state, diff: c.diff, to: editable(c.state, `/commands/${c.name}`) })
  if (s.workflow.state !== 'ok') rows.push({ key: 'workflow', kind: 'workflow', label: s.workflow.slug, state: s.workflow.state, diff: s.workflow.diff, to: editable(s.workflow.state, `/workflows/${s.workflow.slug}`) })
  for (const w of s.watches) if (w.state !== 'ok') rows.push({ key: `watch:${w.id}`, kind: 'watch', label: w.id!, state: w.state, diff: w.diff, to: editable(w.state, '/watches') })
  return rows
})

async function apply(only?: string[]) {
  const rows = only ? attention.value.filter(r => only.includes(r.key)) : attention.value
  const drifted = rows.filter(r => r.state === 'drifted').length
  const missing = rows.length - drifted
  const what = [drifted ? `overwrite ${drifted} locally changed item(s)` : '', missing ? `add ${missing} missing item(s)` : ''].filter(Boolean).join(' and ')
  if (!confirm(`This will ${what} on this shared instance.${drifted ? '\n\nLocal edits are lost. Promote them to the team first if they should be kept.' : ''}`)) return
  syncing.value = only?.[0] ?? 'all'
  try {
    status.value = await $fetch<TeamStatus>('/api/team/sync', { method: 'POST', body: only ? { only } : {} })
    toast.add({ title: only ? `Applied ${rows[0]?.label ?? only[0]}` : 'Team standards applied', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Apply failed', description: e.data?.message || e.message, color: 'error' })
  } finally { syncing.value = null }
}
onMounted(() => { refresh(); loadCheckouts() })
const color = (s: State) => s === 'ok' ? 'var(--success)' : s === 'missing' ? 'var(--error)' : 'var(--warning)'
const byState = (items: Item[]) => [...items].sort((a, b) => Number(a.state === 'ok') - Number(b.state === 'ok'))
const sourceLabel = (s: Source) => s === 'plugin' ? 'from the installed plugin' : s === 'shipped' ? 'from the copy shipped in the app' : s === 'other' ? 'from an override path' : 'no source found'
const lineColor = (l: string) => l.startsWith('+') ? 'var(--success)' : l.startsWith('-') ? 'var(--error)' : l.startsWith('@@') ? 'var(--text-tertiary)' : undefined
const enforcementText = computed(() => {
  const e = status.value?.enforcement
  if (!e) return ''
  if (e.error) return 'could not verify'
  const armed = e.checks.filter(c => c.armed).length
  return e.checks.length ? `${armed} of ${e.checks.length} hooks armed` : 'no hooks found'
})
const enforcementTitle = computed(() => {
  const e = status.value?.enforcement
  if (!e) return ''
  return e.error ?? e.checks.map(c => `${c.name}: ${c.armed ? 'armed' : 'NOT armed'}${c.source ? ` (${c.source})` : ''}`).join('\n')
})
const card = 'rounded-xl p-4'
const cardStyle = 'background: var(--surface-raised); border: 1px solid var(--border-subtle);'
</script>

<template>
  <div>
    <PageHeader title="Team">
      <template #right>
        <UButton label="Apply team standards" icon="i-lucide-refresh-cw" size="sm" :loading="syncing === 'all'" :disabled="!status || status.drifted === 0 || !!syncing" @click="apply()" />
      </template>
    </PageHeader>
    <div class="px-6 py-4 space-y-5 max-w-5xl">
      <p class="text-[13px] leading-relaxed text-label">
        The team's agents, skills, commands, workflow, watches, registry and hooks ship in the alepo-engineering plugin and the app's templates. This page shows what on this instance differs from them, and whether the plugin's hooks are actually armed. Applying rewrites only the team-owned files; everything else in the config directory is left alone.
      </p>

      <div v-if="error" class="rounded-xl px-4 py-3 flex items-center gap-3" style="background: rgba(248, 113, 113, 0.06); border: 1px solid rgba(248, 113, 113, 0.12);">
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" style="color: var(--error);" />
        <span class="text-[12px] flex-1" style="color: var(--error);">{{ error }}</span>
        <NuxtLink v-if="/sign in/i.test(error)" to="/login" class="text-[12px] underline focus-ring">Sign in</NuxtLink>
        <UButton v-else size="xs" variant="ghost" color="neutral" label="Try again" :loading="loading" @click="refresh" />
      </div>
      <div v-else-if="loading && !status" class="space-y-2"><SkeletonCard v-for="i in 2" :key="i" /></div>
      <template v-else-if="status">
        <div :class="[card, 'grid grid-cols-2 md:grid-cols-5 gap-4 text-[12px]']" :style="cardStyle">
          <div>
            <div class="text-label">Drift</div>
            <div class="font-medium" :style="{ color: status.drifted ? 'var(--warning)' : 'var(--success)' }">{{ status.drifted ? `${status.drifted} item(s) need attention` : 'in sync' }}</div>
            <div v-if="status.lastApplied" class="text-[11px] text-label mt-0.5" :title="new Date(status.lastApplied.at).toLocaleString()">applied by {{ status.lastApplied.by }}, {{ status.lastApplied.items }} item(s)</div>
          </div>
          <div>
            <div class="text-label">Enforcement</div>
            <div class="font-medium" :style="{ color: status.enforcement.ok ? 'var(--success)' : 'var(--error)' }" :title="enforcementTitle">{{ enforcementText }}</div>
            <div class="text-[11px] text-label mt-0.5">plan gate, test lock, on this instance</div>
          </div>
          <div>
            <div class="text-label">Plugin</div>
            <div class="font-medium" style="color: var(--text-primary);">{{ status.pluginVersion ? `alepo-engineering ${status.pluginVersion}` : 'not installed' }}</div>
            <div v-if="status.shippedVersion && status.pluginVersion && status.shippedVersion !== status.pluginVersion" class="text-[11px] mt-0.5" style="color: var(--warning);">this build ships {{ status.shippedVersion }}; reinstall the plugin</div>
            <div v-else-if="!status.pluginVersion && status.shippedVersion" class="text-[11px] text-label mt-0.5">using the copy shipped in the app, {{ status.shippedVersion }}</div>
          </div>
          <div>
            <div class="text-label">Registry</div>
            <div class="font-medium" :style="{ color: status.registry.ok ? 'var(--text-primary)' : 'var(--error)' }" :title="status.registry.path ?? undefined">{{ status.registry.ok ? `${status.registry.products} products` : 'not readable' }}</div>
            <div class="text-[11px] text-label mt-0.5">{{ sourceLabel(status.sources.registry) }}</div>
          </div>
          <div>
            <div class="text-label">Workflow</div>
            <div class="font-medium" :style="{ color: color(status.workflow.state) }">{{ status.workflow.state }} · {{ status.workflow.steps }} steps</div>
            <NuxtLink :to="`/workflows/${status.workflow.slug}`" class="text-[11px] text-label underline focus-ring">open</NuxtLink>
          </div>
        </div>

        <div v-if="status.unresolvedSkills.length" class="rounded-xl px-4 py-3 text-[12px]" style="background: rgba(217, 119, 6, 0.06); border: 1px solid rgba(217, 119, 6, 0.2);">
          <span class="font-medium" style="color: var(--warning);">{{ status.unresolvedSkills.length }} declared skill(s) do not resolve on this instance:</span>
          <span class="font-mono ml-1">{{ status.unresolvedSkills.join(', ') }}</span>.
          <span class="text-label">The agents that declare them run without those instructions, silently. Applying team standards seeds every skill the plugin ships.</span>
        </div>

        <div v-if="attention.length" :class="card" :style="cardStyle" data-testid="attention">
          <div class="text-[12px] font-medium mb-1" style="color: var(--text-primary);">Needs attention</div>
          <p class="text-[11px] text-label mb-2">A drifted item was changed on this instance. Open it to keep or promote the local version, or apply the team version. A missing item is safe to add.</p>
          <div v-for="r in attention" :key="r.key" class="py-1.5 text-[12px]" style="border-top: 1px solid var(--border-subtle);">
            <div class="flex items-center gap-3">
              <span class="text-[10px] uppercase tracking-wide text-label w-16">{{ r.kind }}</span>
              <NuxtLink v-if="r.to" :to="r.to" class="font-mono truncate focus-ring underline" :title="`Open ${r.label}`">{{ r.label }}</NuxtLink>
              <span v-else class="font-mono truncate">{{ r.label }}</span>
              <span :style="{ color: color(r.state) }">{{ r.state }}</span>
              <UButton size="xs" variant="ghost" color="neutral" class="ml-auto" :label="r.state === 'drifted' ? 'Apply team version' : 'Add'" :loading="syncing === r.key" :disabled="!!syncing" @click="apply([r.key])" />
            </div>
            <details v-if="r.diff" class="mt-1 ml-[4.75rem]">
              <summary class="text-[11px] text-label cursor-pointer focus-ring">What differs</summary>
              <pre class="mt-1 p-2 rounded text-[11px] leading-snug overflow-x-auto font-mono" style="background: var(--surface-base);"><div v-for="(l, i) in r.diff.split('\n')" :key="i" :style="{ color: lineColor(l) }">{{ l }}</div></pre>
            </details>
            <p v-else-if="r.state === 'missing'" class="text-[11px] text-label mt-0.5 ml-[4.75rem]">Not on this instance yet.</p>
          </div>
        </div>

        <div class="grid md:grid-cols-3 gap-4">
          <div :class="card" :style="cardStyle">
            <div class="text-[12px] font-medium mb-2" style="color: var(--text-primary);">Agents</div>
            <div v-for="a in byState(status.agents)" :key="a.id" class="flex items-center justify-between gap-2 text-[12px] py-0.5">
              <NuxtLink v-if="a.state !== 'missing'" :to="`/agents/${a.id}`" class="font-mono truncate focus-ring" :title="a.id">{{ a.id }}</NuxtLink>
              <span v-else class="font-mono truncate" :title="a.id">{{ a.id }}</span>
              <span :style="{ color: color(a.state) }">{{ a.state }}</span>
            </div>
          </div>
          <div :class="card" :style="cardStyle">
            <div class="text-[12px] font-medium mb-0.5" style="color: var(--text-primary);">Skills</div>
            <p class="text-[11px] text-label mb-2">{{ sourceLabel(status.sources.skills) }}</p>
            <p v-if="!status.skills.length" class="text-[12px] text-label">None shipped.</p>
            <div v-for="s in byState(status.skills)" :key="s.name" class="flex items-center justify-between gap-2 text-[12px] py-0.5">
              <NuxtLink v-if="s.state !== 'missing'" :to="`/skills/${s.name}`" class="font-mono truncate focus-ring" :title="s.name">{{ s.name }}</NuxtLink>
              <span v-else class="font-mono truncate" :title="s.name">{{ s.name }}</span>
              <span :style="{ color: color(s.state) }">{{ s.state }}</span>
            </div>
          </div>
          <div :class="card" :style="cardStyle">
            <div class="text-[12px] font-medium mb-0.5" style="color: var(--text-primary);">Commands</div>
            <p class="text-[11px] text-label mb-2">{{ sourceLabel(status.sources.commands) }}</p>
            <p v-if="!status.commands.length" class="text-[12px] text-label">None shipped.</p>
            <div v-for="c in byState(status.commands)" :key="c.name" class="flex items-center justify-between gap-2 text-[12px] py-0.5">
              <NuxtLink v-if="c.state !== 'missing'" :to="`/commands/${c.name}`" class="font-mono truncate focus-ring" :title="c.name">/{{ c.name }}</NuxtLink>
              <span v-else class="font-mono truncate">/{{ c.name }}</span>
              <span :style="{ color: color(c.state) }">{{ c.state }}</span>
            </div>
          </div>
        </div>
        <div class="grid md:grid-cols-2 gap-4">
          <div :class="card" :style="cardStyle">
            <div class="text-[12px] font-medium mb-0.5" style="color: var(--text-primary);">Watches</div>
            <p class="text-[11px] text-label mb-2">{{ sourceLabel(status.sources.watches) }}</p>
            <p v-if="!status.watches.length" class="text-[12px] text-label">None defined in the registry.</p>
            <div v-for="w in byState(status.watches)" :key="w.id" class="flex items-center justify-between text-[12px] py-0.5">
              <NuxtLink to="/watches" class="font-mono focus-ring">{{ w.id }}</NuxtLink><span :style="{ color: color(w.state) }">{{ w.state }}</span>
            </div>
            <p class="text-[11px] text-label mt-2">Seeded disabled. Enable one on the Watches page once its query has been checked against real tickets.</p>
          </div>
          <div :class="card" :style="cardStyle">
            <div class="text-[12px] font-medium mb-2" style="color: var(--text-primary);">Products</div>
            <p v-if="!status.registry.items.length" class="text-[12px] text-label">Registry not readable{{ status.registry.path ? ` at ${status.registry.path}` : '' }}.</p>
            <div v-for="p in status.registry.items" :key="p.key" class="flex items-center gap-2 text-[12px] py-0.5">
              <span class="font-mono">{{ p.key }}</span>
              <span v-if="p.suite" class="text-label">{{ p.suite }}</span>
              <span class="text-label truncate ml-auto" :title="p.repos.join(', ')">{{ p.repos.length }} repo{{ p.repos.length === 1 ? '' : 's' }}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded" :style="{ color: p.recipe ? 'var(--success)' : 'var(--warning)', background: 'var(--surface-base)' }" :title="p.recipe ? `recipes/${p.key}.md in the plugin tells the stack step how to bring this product up` : `No recipes/${p.key}.md in the plugin; the stack step improvises for this product`">{{ p.recipe ? 'recipe' : 'no recipe' }}</span>
            </div>
          </div>
        </div>
      </template>

      <div :class="[card, 'text-[12px]']" :style="cardStyle">
        <div class="font-medium mb-1" style="color: var(--text-primary);">Checkouts</div>
        <p class="text-label mb-2">Product repositories under the workspace root. A run branches from the checkout's HEAD and carries any uncommitted change with it, so park changes that are not meant to travel.</p>
        <p v-if="checkoutsError" style="color: var(--error);">{{ checkoutsError }}</p>
        <p v-else-if="!checkouts.length" class="text-label">No checkouts yet; the stack step clones a product the first time it is needed.</p>
        <div v-for="c in checkouts" :key="c.path" class="py-1" style="border-top: 1px solid var(--border-subtle);">
          <div class="flex items-center gap-3">
            <span class="font-mono w-48 truncate" :title="c.path">{{ c.owner ? `${c.owner}/` : '' }}{{ c.name }}</span>
            <span v-if="c.git" class="text-label font-mono truncate">{{ c.branch }} @ {{ c.head }}</span>
            <span v-else class="text-label">not a git checkout</span>
            <span class="ml-auto whitespace-nowrap" :style="{ color: c.dirty ? 'var(--warning)' : 'var(--success)' }">{{ c.dirty ? `${c.dirty} uncommitted` : 'clean' }}</span>
            <UButton v-if="c.git && c.dirty" size="xs" variant="ghost" color="neutral" :loading="stashing === c.path" label="Park changes" @click="stash(c)" />
          </div>
          <details v-if="c.dirty" class="mt-0.5">
            <summary class="text-[11px] text-label cursor-pointer focus-ring">Changed files</summary>
            <ul class="font-mono text-[11px] text-label mt-0.5 ml-4 list-disc"><li v-for="f in c.dirtyFiles" :key="f">{{ f }}</li></ul>
          </details>
        </div>
      </div>

      <div v-if="status" :class="[card, 'text-[12px]']" :style="cardStyle">
        <div class="font-medium mb-2" style="color: var(--text-primary);">This instance</div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
          <div><span class="text-label">Sign-in</span><div>{{ status.instance.auth === 'github' ? `GitHub, ${status.instance.githubOrg}` : 'disabled (local)' }}</div></div>
          <div><span class="text-label">Jira</span><div>{{ status.instance.jiraRead ? 'reads tickets' : 'not configured' }}{{ status.instance.jiraPost ? ', posts outcomes' : '' }} <NuxtLink to="/profile" class="text-label underline focus-ring">your credentials</NuxtLink></div></div>
          <div><span class="text-label">Slack</span><div>{{ status.instance.slack ? 'notifies' : 'off' }}</div></div>
          <div><span class="text-label">CI poller</span><div>{{ status.instance.ciPoller ? 'on' : 'off' }}</div></div>
          <div><span class="text-label">Run budget</span><div>{{ status.instance.budget.maxMinutes }} min, {{ status.instance.budget.maxTokens.toLocaleString() }} tokens</div></div>
          <div class="md:col-span-3"><span class="text-label">Your workspace</span><div class="font-mono truncate" :title="status.instance.workspaceRoot">{{ status.instance.workspaceRoot }}/&lt;repo&gt;</div></div>
          <div class="md:col-span-2"><span class="text-label">Config</span><div class="font-mono truncate" :title="status.instance.claudeDir">{{ status.instance.claudeDir }}</div></div>
          <div class="md:col-span-2"><span class="text-label">Runs</span><div class="font-mono truncate" :title="status.instance.runsDir">{{ status.instance.runsDir }}</div></div>
        </div>
      </div>
      <p v-if="status" class="text-[11px] text-label flex items-center gap-2">
        Checked {{ new Date(status.checkedAt).toLocaleTimeString() }}.
        <UButton size="xs" variant="link" color="neutral" label="Check again" :loading="loading" class="p-0" @click="refresh" />
      </p>
    </div>
  </div>
</template>
