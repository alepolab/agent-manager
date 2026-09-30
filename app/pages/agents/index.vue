<script setup lang="ts">
import { getModelLabel, getModelTagline } from '~/utils/models'
import { agentTemplates } from '~/utils/templates'

const { agents, loading, error, create, fetchAll: fetchAgents } = useAgents()
const router = useRouter()
const toast = useToast()

const showCreateModal = ref(false)
const showImportModal = ref(false)
const searchQuery = ref('')
const skillCounts = ref<Record<string, number>>({})
const creatingTemplate = ref<string | null>(null)

async function loadSkillCounts() {
  try {
    skillCounts.value = await $fetch<Record<string, number>>('/api/agents/skill-counts')
  } catch {
    // Non-critical
  }
}
onMounted(loadSkillCounts)
useAutoRefresh(loadSkillCounts)

const filteredAgents = computed(() => {
  if (!searchQuery.value) return agents.value
  const q = searchQuery.value.toLowerCase()
  return agents.value.filter(a =>
    a.frontmatter.name.toLowerCase().includes(q) ||
    a.frontmatter.description?.toLowerCase().includes(q)
  )
})

const groupedAgents = computed(() => {
  const groups: Record<string, typeof agents.value> = {}
  for (const agent of filteredAgents.value) {
    const key = agent.directory || ''
    ;(groups[key] ??= []).push(agent)
  }
  // Named folders alphabetically, root ('') last
  return Object.entries(groups).sort(([a], [b]) => {
    if (!a) return 1
    if (!b) return -1
    return a.localeCompare(b)
  })
})

/**
 * A sortable table with an inspector, not a grid of cards. Thirty-six agents
 * as cards was twelve screens of colour stripes; as rows they fit on one and a
 * half, and the inspector shows what the card was straining to fit.
 */
type SortKey = 'name' | 'model' | 'skills'
const sortKey = ref<SortKey>('name')
const sortDir = ref<1 | -1>(1)
function sortBy(k: SortKey) {
  if (sortKey.value === k) sortDir.value = sortDir.value === 1 ? -1 : 1
  else { sortKey.value = k; sortDir.value = 1 }
}
const skillsOf = (a: (typeof agents.value)[number]) => a.frontmatter.skills?.length ?? skillCounts.value[a.slug] ?? 0
const sortedGroups = computed(() => groupedAgents.value.map(([dir, list]) => [dir, [...list].sort((a, b) => {
  const v = sortKey.value === 'name' ? a.frontmatter.name.localeCompare(b.frontmatter.name)
    : sortKey.value === 'model' ? (a.frontmatter.model ?? '').localeCompare(b.frontmatter.model ?? '')
    : skillsOf(a) - skillsOf(b)
  return v * sortDir.value
})] as const))

const route = useRoute()
const selectedSlug = computed(() => (typeof route.query.agent === 'string' ? route.query.agent : null))
const selected = computed(() => agents.value.find(a => a.slug === selectedSlug.value) ?? null)
/**
 * Wide screens select into the inspector beside the table; narrow ones have no
 * inspector (it is `hidden lg:block`), so a tap opens the agent itself, the way
 * a run row does on /runs. Keyboard selection always stays on the page.
 */
function select(slug: string, fromPointer = false) {
  if (fromPointer && !window.matchMedia('(min-width: 1024px)').matches) { router.push(`/agents/${slug}`); return }
  router.replace({ query: { ...route.query, agent: slug } })
}

/**
 * One tab stop for the table, arrows to move within it: the selected row (or
 * the first) is focusable, the rest are reached with Up and Down. It was one
 * tab stop per agent, 36 of them before the inspector.
 */
const rowOrder = computed(() => sortedGroups.value.flatMap(([, list]) => list.map(a => a.slug)))
const focusSlug = computed(() => (selectedSlug.value && rowOrder.value.includes(selectedSlug.value) ? selectedSlug.value : rowOrder.value[0]))
function moveRow(e: KeyboardEvent, slug: string) {
  const i = rowOrder.value.indexOf(slug)
  const n = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rowOrder.value.length - 1 : -2
  if (n === -2) return
  e.preventDefault()
  const next = rowOrder.value[Math.max(0, Math.min(rowOrder.value.length - 1, n))]
  if (!next) return
  select(next)
  nextTick(() => (document.querySelector(`[data-agent-row="${CSS.escape(next)}"]`) as HTMLElement | null)?.focus())
}

const hasGroups = computed(() =>
  groupedAgents.value.length > 1 ||
  (groupedAgents.value.length === 1 && groupedAgents.value[0]?.[0] !== '')
)

async function useTemplate(templateId: string) {
  const template = agentTemplates.find(t => t.id === templateId)
  if (!template) return
  creatingTemplate.value = templateId
  try {
    const agent = await create({ frontmatter: { ...template.frontmatter }, body: template.body })
    toast.add({ title: `${template.frontmatter.name} created`, color: 'success' })
    router.push(`/agents/${agent.slug}`)
  } catch (e: any) {
    toast.add({ title: 'Failed to create', description: e.data?.message || e.message, color: 'error' })
  } finally {
    creatingTemplate.value = null
  }
}
</script>

<template>
  <div class="h-full flex flex-col">
    <PageHeader title="Agents">
      <template #trailing>
        <span class="t-small text-meta font-normal">{{ agents.length }}</span>
      </template>
      <template #right>
        <input v-model="searchQuery" placeholder="Filter agents" class="field-input t-small w-52" aria-label="Filter agents" />
        <UButton label="Import…" size="sm" variant="ghost" color="neutral" @click="() => { showImportModal = true }" />
        <UButton label="New Agent" icon="i-lucide-plus" size="sm" @click="() => { showCreateModal = true }" />
      </template>
    </PageHeader>

    <div v-if="error" class="page">
      <p class="t-small" style="color: var(--error);">{{ error }}</p>
    </div>

    <div v-if="loading" class="page space-y-2"><SkeletonCard v-for="i in 4" :key="i" /></div>

    <div v-else-if="filteredAgents.length" class="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div class="min-h-0 overflow-y-auto" style="background: var(--surface-raised);">
        <table class="agent-table" aria-label="Agents">
          <thead>
            <tr>
              <th scope="col"><button class="focus-ring" @click="sortBy('name')">Name<span v-if="sortKey === 'name'" aria-hidden="true"> {{ sortDir === 1 ? '▾' : '▴' }}</span></button></th>
              <th scope="col" class="hidden md:table-cell">Description</th>
              <th scope="col" class="w-24"><button class="focus-ring" @click="sortBy('model')">Model<span v-if="sortKey === 'model'" aria-hidden="true"> {{ sortDir === 1 ? '▾' : '▴' }}</span></button></th>
              <th scope="col" class="w-16 text-right"><button class="focus-ring" @click="sortBy('skills')">Skills<span v-if="sortKey === 'skills'" aria-hidden="true"> {{ sortDir === 1 ? '▾' : '▴' }}</span></button></th>
            </tr>
          </thead>
          <tbody v-for="([directory, groupAgents]) in sortedGroups" :key="directory || '__root__'">
            <!-- A folder heading only when the agents actually live in folders. -->
            <tr v-if="hasGroups" class="agent-table__group"><th colspan="4" scope="colgroup">{{ directory || 'General' }} <span class="font-normal">{{ groupAgents.length }}</span></th></tr>
            <tr
              v-for="agent in groupAgents" :key="agent.slug"
              :class="{ 'agent-table__row--on': agent.slug === selectedSlug }"
              :data-agent-row="agent.slug"
              :tabindex="agent.slug === focusSlug ? 0 : -1"
              :aria-current="agent.slug === selectedSlug ? 'true' : undefined"
              @click="select(agent.slug, true)"
              @keydown.enter="router.push(`/agents/${agent.slug}`)"
              @keydown.space.prevent="select(agent.slug)"
              @keydown="moveRow($event, agent.slug)"
              @dblclick="router.push(`/agents/${agent.slug}`)"
            >
              <td class="font-medium"><div class="truncate">{{ agent.frontmatter.name }}</div></td>
              <td class="hidden md:table-cell text-label"><div class="truncate" :title="agent.frontmatter.description">{{ agent.frontmatter.description }}</div></td>
              <td :class="{ 'text-label': !agent.frontmatter.model }">{{ agent.frontmatter.model ? getModelLabel(agent.frontmatter.model) : 'Default' }}</td>
              <td class="text-right tabular-nums text-label">{{ skillsOf(agent) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <aside class="min-h-0 overflow-y-auto agent-inspector hidden lg:block">
        <template v-if="selected">
          <h2 class="t-head text-strong">{{ selected.frontmatter.name }}</h2>
          <p class="t-small text-label mt-1">{{ selected.frontmatter.description }}</p>
          <div class="flex gap-2 mt-4">
            <UButton size="sm" label="Edit" :to="`/agents/${selected.slug}`" />
          </div>
          <dl class="agent-inspector__kv">
            <dt>Model</dt><dd>{{ selected.frontmatter.model ? `${getModelLabel(selected.frontmatter.model)} · ${getModelTagline(selected.frontmatter.model)}` : 'Default' }}</dd>
            <dt>Tools</dt><dd>{{ selected.frontmatter.tools?.length ? selected.frontmatter.tools.join(', ') : 'All tools' }}</dd>
            <dt>Memory</dt><dd class="capitalize">{{ selected.frontmatter.memory || 'None' }}</dd>
            <dt>Skills</dt>
            <dd>
              <span v-if="selected.frontmatter.skills?.length" class="flex flex-wrap gap-1">
                <span v-for="skill in selected.frontmatter.skills" :key="skill" class="t-small px-1.5 py-px rounded" style="background: var(--badge-subtle-bg);">{{ skill }}</span>
              </span>
              <template v-else-if="skillCounts[selected.slug]">{{ skillCounts[selected.slug] }} linked from their own files</template>
              <template v-else>None</template>
            </dd>
            <dt>File</dt><dd class="font-mono t-small break-all">{{ selected.filePath }}</dd>
          </dl>
        </template>
        <p v-else class="t-small text-label">Select an agent to see its model, tools and skills. Double-click or press Enter to edit it; the arrow keys move between agents.</p>
      </aside>
    </div>

    <!-- Empty state: search miss -->
    <div v-else-if="searchQuery" class="flex flex-col items-center justify-center py-16 space-y-3">
      <p class="t-ui text-label">No agents match your search.</p>
    </div>

    <!-- Empty state: no agents — show templates -->
    <div v-else class="page space-y-5">
      <div class="text-center py-4">
        <p class="t-ui text-label">No agents yet. Start from a template or create your own.</p>
      </div>

      <ExampleBlock title="What does a good agent look like?" class="max-w-md mx-auto mb-6">
        <div class="space-y-2 t-small text-body">
          <div class="group-card">
            <p><strong class="text-strong">code-reviewer</strong> <span class="t-small text-label">← This name is short and descriptive</span></p>
            <p class="mt-1">"Reviews pull requests for bugs, style, and security." <span class="t-small text-label">← Explains what it does in one sentence</span></p>
            <p class="mt-1 t-small text-label">"Check for bugs, flag security issues, suggest improvements..." <span>← Instructions are specific</span></p>
          </div>
        </div>
      </ExampleBlock>

      <div class="inset-list">
        <button
          v-for="template in agentTemplates"
          :key="template.id"
          class="inset-row inset-row--link w-full text-left focus-ring"
          :disabled="creatingTemplate !== null"
          @click="useTemplate(template.id)"
        >
          <span class="inset-row__lead"><UIcon :name="template.icon" class="size-4 text-label" /></span>
          <span class="inset-row__body">
            <span class="inset-row__title">{{ template.frontmatter.name }}</span>
            <span class="inset-row__sub">{{ template.frontmatter.description }}</span>
          </span>
          <UIcon v-if="creatingTemplate === template.id" name="i-lucide-loader-2" class="size-3.5 animate-spin text-meta" />
        </button>
      </div>

      <div class="text-center">
        <UButton label="Or create from scratch" variant="ghost" size="sm" @click="() => { showCreateModal = true }" />
      </div>
    </div>

    <UModal v-model:open="showCreateModal">
      <template #content>
        <AgentWizard
          @saved="(a) => { showCreateModal = false; router.push(`/agents/${a.slug}`) }"
          @cancel="showCreateModal = false"
        />
      </template>
    </UModal>

    <UModal v-model:open="showImportModal">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">Import Agent</h3>
          <FileImport
            type="agents"
            @imported="(a) => { showImportModal = false; fetchAgents(); router.push(`/agents/${a.slug}`) }"
          />
          <div class="flex justify-end">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showImportModal = false }" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.agent-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 13px; }
.agent-table th { text-align: left; font-size: 12px; font-weight: 500; color: var(--text-tertiary); }
.agent-table thead th {
  position: sticky; top: 0; z-index: 1; padding: 8px 14px;
  background: var(--surface-raised);
  border-bottom: 0.5px solid var(--border-default);
}
.agent-table thead th:first-child { width: 60%; }
/* Description shows from md up, and takes the width the name gives back. */
@media (min-width: 768px) { .agent-table thead th:first-child { width: 30%; } }
.agent-table thead th button { font: inherit; color: inherit; }
.agent-table td { padding: 0 14px; height: 36px; color: var(--text-primary); border-bottom: 0.5px solid var(--border-default); }
.agent-table tbody tr:not(.agent-table__group) { cursor: default; }
.agent-table tbody tr:not(.agent-table__group):hover { background: var(--surface-hover); }
.agent-table tbody tr:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.agent-table__row--on, .agent-table__row--on:hover { background: var(--accent-muted) !important; }
.agent-table__row--on td:first-child { font-weight: 600; }
.agent-table__group th { padding: 14px 14px 6px; font-weight: 600; color: var(--text-tertiary); }
.agent-inspector {
  padding: 20px;
  border-left: 0.5px solid var(--border-default);
  background: var(--surface-base);
}
.agent-inspector__kv {
  display: grid;
  grid-template-columns: 5rem minmax(0, 1fr);
  gap: 8px 12px;
  margin-top: 18px;
  font-size: 12px;
}
.agent-inspector__kv dt { color: var(--text-tertiary); }
.agent-inspector__kv dd { margin: 0; color: var(--text-primary); }
</style>
