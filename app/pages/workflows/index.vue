<script setup lang="ts">
import { workflowTemplates, materializeTemplateSteps } from '~/utils/workflowTemplates'
import { agentTemplates } from '~/utils/templates'
import { planTemplateResolution } from '~/utils/workflowInstantiation'
import { DEFAULT_GROUP_ID } from '~~/shared/types/workflowGroup'

const { workflows, loading, error, create, fetchAll } = useWorkflows()
// Fetched once here rather than per card: schedules are not loaded app-wide,
// and N cards each calling the composable would each fire a request.
const { schedules, fetchAll: fetchSchedules } = useSchedules()
onMounted(() => { void fetchSchedules() })
const scheduleCounts = computed(() => {
  const counts: Record<string, { total: number, enabled: number }> = {}
  for (const s of schedules.value) {
    const c = counts[s.workflowSlug] ??= { total: 0, enabled: 0 }
    c.total++
    if (s.enabled) c.enabled++
  }
  return counts
})
const { agents, create: createAgent } = useAgents()
// Creating a workflow is `configure`, which only an operator holds. The three
// create affordances on this page were offered to every role and each ended in
// a 403 from POST /api/workflows.
const { can } = useUser()
const router = useRouter()
const toast = useToast()
const searchQuery = ref('')
const showCreateModal = ref(false)
const creatingTemplate = ref<string | null>(null)
const newName = ref('')
const newDescription = ref('')
const creating = ref(false)

const filteredWorkflows = computed(() => {
  if (!searchQuery.value) return workflows.value
  const q = searchQuery.value.toLowerCase()
  return workflows.value.filter(w =>
    w.name.toLowerCase().includes(q) ||
    w.description?.toLowerCase().includes(q)
  )
})

async function useWorkflowTemplate(templateId: string) {
  const template = workflowTemplates.find(t => t.id === templateId)
  if (!template) return
  creatingTemplate.value = templateId
  try {
    // Decision logic (which agentTemplateIds - steps' own plus every monitorSlug -
    // need resolving, and which already have an existing agent to reuse) lives in
    // planTemplateResolution(); see app/utils/workflowInstantiation.ts for why
    // monitorSlug needs its own pass. What's left here is I/O: create an agent for
    // everything the plan says doesn't exist yet.
    const plan = planTemplateResolution(template, agentTemplates, agents.value)
    const agentSlugByTemplateId: Record<string, string> = { ...plan.resolved }
    for (const id of plan.toCreate) {
      const agentTemplate = agentTemplates.find(t => t.id === id)!
      const agent = await createAgent({ frontmatter: { ...agentTemplate.frontmatter }, body: agentTemplate.body })
      agentSlugByTemplateId[id] = agent.slug
    }

    const steps = materializeTemplateSteps({ ...template, steps: plan.steps }, agentSlugByTemplateId)
    const workflow = await create({ name: template.name, description: template.description, steps })
    router.push(`/workflows/${workflow.slug}`)
  } catch (e: any) {
    toast.add({ title: 'Failed to create', description: e.data?.message || e.message, color: 'error' })
  } finally {
    creatingTemplate.value = null
  }
}

async function createBlank() {
  if (!newName.value.trim()) return
  creating.value = true
  try {
    const workflow = await create({
      name: newName.value.trim(),
      description: newDescription.value.trim(),
      steps: [],
    })
    showCreateModal.value = false
    newName.value = ''
    newDescription.value = ''
    router.push(`/workflows/${workflow.slug}`)
  } catch (e: any) {
    toast.add({ title: 'Failed to create', description: e.data?.message || e.message, color: 'error' })
  } finally {
    creating.value = false
  }
}

/**
 * Concurrency groups: how many runs of the workflows in a group may work at
 * once. Edited here rather than on one workflow, because a group is a fact
 * about several of them - "these three pipelines share two slots" is not
 * something any single workflow can say. Which group a workflow is IN is set
 * on that workflow, next to its Inputs.
 *
 * The whole table is saved at once (PUT /api/workflow-groups), so a row with a
 * bad cap is refused before anything is written rather than leaving the file
 * half-edited.
 */
interface GroupRow { id: string, name: string, maxConcurrent: number, inFlight: number, waiting: number, implicit: boolean }
const showGroups = ref(false)
const groups = ref<GroupRow[]>([])
const groupRows = ref<{ id: string, name: string, maxConcurrent: number }[]>([])
const savingGroups = ref(false)

async function loadGroups() {
  groups.value = await $fetch<GroupRow[]>('/api/workflow-groups').catch(() => [])
  // The default group is editable too, and it is the only cap most instances
  // ever need. `capFor` already prefers a saved `default` row over
  // AGENT_MAX_CONCURRENT_PIPELINES, so this needs no server change - it was
  // only ever missing because the row was filtered out of the editor. When
  // nothing names it yet, its cap is prefilled from the env-derived value so
  // saving the table does not silently change the number in force.
  groupRows.value = groups.value.map(g => ({ id: g.implicit ? DEFAULT_GROUP_ID : g.id, name: g.name, maxConcurrent: g.maxConcurrent }))
}
const isDefaultRow = (row: { id: string }) => row.id === DEFAULT_GROUP_ID
/** The env var still governs the default group until a row is saved for it. */
const defaultRowUnsaved = computed(() => groups.value.find(g => g.implicit) !== undefined)
onMounted(loadGroups)
// loadGroups resets the editable rows, so it waits while the groups editor is open.
useAutoRefresh(() => Promise.all([
  fetchSchedules({ silent: true }),
  showGroups.value ? null : loadGroups(),
]))

function slugifyGroupId(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function addGroup() {
  groupRows.value.push({ id: '', name: '', maxConcurrent: 2 })
}

async function saveGroups() {
  savingGroups.value = true
  try {
    // The id is derived from the name for a new row and never changed for an
    // existing one: workflows reference the id, so renaming a group must not
    // orphan every workflow that named it.
    // The default row keeps its id verbatim rather than being re-slugified:
    // `slugifyGroupId('Ungrouped')` is `ungrouped`, an id `capFor` would never
    // consult, so the cap would save cleanly and govern nothing. It is also
    // dropped entirely when it is still at the env-derived value and no row
    // existed before, so an instance nobody has touched keeps an empty file.
    const payload = groupRows.value
      .filter(g => g.name.trim())
      .filter(g => !(isDefaultRow(g) && defaultRowUnsaved.value && Number(g.maxConcurrent) === groups.value.find(x => x.implicit)?.maxConcurrent))
      .map(g => ({
        id: isDefaultRow(g) ? DEFAULT_GROUP_ID : (g.id || slugifyGroupId(g.name)),
        name: g.name.trim(),
        maxConcurrent: Number(g.maxConcurrent),
      }))
    await $fetch('/api/workflow-groups', { method: 'PUT', body: { groups: payload } })
    await loadGroups()
    showGroups.value = false
    toast.add({ title: 'Groups saved', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Failed to save groups', description: e.data?.message || e.message, color: 'error' })
  } finally {
    savingGroups.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader title="Workflows">
      <template #trailing>
        <span class="t-small text-meta">{{ workflows.length }}</span>
      </template>
      <template #right>
        <UButton v-if="can('configure')" label="Groups" icon="i-lucide-layers" size="sm" variant="ghost" color="neutral" @click="() => { showGroups = true }" />
        <UButton v-if="can('configure')" label="New Workflow" icon="i-lucide-plus" size="sm" @click="() => { showCreateModal = true }" />
      </template>
    </PageHeader>

    <div class="px-6 py-4">
      <p class="t-ui mb-4 leading-relaxed text-label">
        Chain agents together into multi-step pipelines that pass work from one agent to the next.
      </p>

      <!-- Search -->
      <div v-if="workflows.length" class="mb-5">
        <input
          v-model="searchQuery"
          placeholder="Search workflows..."
          aria-label="Search workflows"
          class="field-search max-w-xs"
        />
      </div>

      <!-- Error state -->
      <div
        v-if="error"
        class="rounded-xl px-4 py-3 mb-4 flex items-start gap-3"
        style="background: rgba(248, 113, 113, 0.06); border: 1px solid rgba(248, 113, 113, 0.12);"
      >
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0 mt-0.5" style="color: var(--error);" />
        <span class="t-small flex-1" style="color: var(--error);">{{ error }}</span>
        <UButton size="xs" variant="ghost" color="neutral" label="Try again" :loading="loading" @click="fetchAll()" />
      </div>

      <!-- Loading -->
      <div v-if="loading" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <SkeletonCard v-for="i in 3" :key="i" />
      </div>

      <!-- Workflow grid -->
      <div v-else-if="filteredWorkflows.length" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <WorkflowCard
          v-for="workflow in filteredWorkflows"
          :key="workflow.slug"
          :workflow="workflow"
          :schedules="scheduleCounts[workflow.slug]"
        />
      </div>

      <!-- Empty state: search miss -->
      <div v-else-if="searchQuery" class="flex flex-col items-center justify-center py-16 space-y-3">
        <p class="t-ui text-label">No workflows match your search.</p>
      </div>

      <!-- Empty state: no workflows — show templates -->
      <div v-else class="space-y-5">
        <div class="text-center py-8 space-y-2">
          <div class="flex justify-center">
            <div
              class="size-12 rounded-xl flex items-center justify-center"
              style="background: var(--accent-muted); border: 1px solid rgba(var(--accent-rgb), 0.15);"
            >
              <UIcon name="i-lucide-git-branch" class="size-6" style="color: var(--accent);" />
            </div>
          </div>
          <h3 class="t-head font-semibold tracking-tight" style="color: var(--text-primary); font-family: var(--font-display);">Chain your agents together</h3>
          <p class="t-ui text-label max-w-md mx-auto">
            Create workflows that pass work from one agent to the next. Start from a template or create your own.
          </p>
        </div>

        <!-- Each card creates a workflow, so the whole grid is `configure`.
             Offering a reviewer a template they cannot instantiate is the same
             dead control as the New Workflow button above it. -->
        <p v-if="!can('configure')" class="t-ui text-label">
          No workflows on this instance yet. An operator sets them up.
        </p>
        <h4 v-if="can('configure')" class="text-section-label">Templates</h4>
        <div v-if="can('configure')" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <button
            v-for="template in workflowTemplates"
            :key="template.id"
            class="rounded-lg p-4 text-left hover-lift focus-ring relative overflow-hidden group bg-card border border-subtle"
            :disabled="creatingTemplate !== null"
            @click="useWorkflowTemplate(template.id)"
          >
            <div class="flex items-center gap-2.5 mb-2">
              <UIcon :name="template.icon" class="size-4 shrink-0 text-label" />
              <span class="t-ui font-medium">{{ template.name }}</span>
              <UIcon
                v-if="creatingTemplate === template.id"
                name="i-lucide-loader-2"
                class="size-3.5 ml-auto animate-spin text-meta"
              />
            </div>
            <p class="t-small text-label leading-relaxed line-clamp-2">
              {{ template.description }}
            </p>
            <div class="flex items-center gap-1 mt-2">
              <span
                v-for="(step, idx) in template.steps"
                :key="idx"
                class="t-small font-mono text-meta"
              >
                {{ step.label }}<span v-if="idx < template.steps.length - 1" class="mx-1" style="color: var(--text-disabled);">-></span>
              </span>
            </div>
          </button>
        </div>

        <div class="text-center">
          <UButton v-if="can('configure')" label="Or create from scratch" variant="ghost" size="sm" @click="() => { showCreateModal = true }" />
        </div>
      </div>
    </div>

    <!-- Concurrency groups -->
    <UModal v-model:open="showGroups">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay max-h-[85vh] overflow-y-auto">
          <div>
            <h3 class="text-page-title">Concurrency groups</h3>
            <p class="t-small text-label mt-1 leading-relaxed">
              How many runs of a group's workflows may work at once. A schedule, a watch or a
              dispatched child over the cap becomes a queued run and starts by itself when a slot
              frees. A run you start by hand never waits — but it does occupy a slot, and a run
              that dispatches holds one of its own group's slots while it does so.
            </p>
          </div>

          <div class="space-y-2">
            <div v-if="groupRows.length" class="flex items-center gap-2 t-label font-mono uppercase tracking-wider text-meta">
              <span style="flex: 1 1 0%; min-width: 0;">Group</span>
              <span style="flex: 0 0 5rem;">At once</span>
              <span style="flex: 0 0 7rem;">Now</span>
              <span style="flex: 0 0 1.75rem;" />
            </div>
            <div v-for="(g, i) in groupRows" :key="i" class="flex items-center gap-2">
              <!-- Flex sizing set inline: .field-input carries width: 100%, which
                   made the cap field claim a flex basis of the whole row and
                   collapsed the name field beside it to nothing. -->
              <input
                v-model="g.name" placeholder="SDLC pipelines" class="field-input"
                style="flex: 1 1 0%; min-width: 0;" :aria-label="`Group ${i + 1} name`"
                :disabled="isDefaultRow(g)" :title="isDefaultRow(g) ? 'Every workflow that names no group counts here; it cannot be renamed or removed.' : undefined"
              />
              <input
                v-model.number="g.maxConcurrent" type="number" min="1" step="1" class="field-input"
                style="flex: 0 0 5rem;" :aria-label="`Group ${i + 1} concurrent runs`"
              />
              <span class="t-small text-meta leading-tight" style="flex: 0 0 7rem;">
                <template v-if="g.id">{{ groups.find(x => x.id === g.id)?.inFlight ?? 0 }} running, {{ groups.find(x => x.id === g.id)?.waiting ?? 0 }} waiting</template>
                <template v-else>new</template>
              </span>
              <!-- The default row has no Remove: deleting it would not delete the
                   group, only hand its cap back to the env var, which reads as a
                   cap that vanished. -->
              <UButton
                v-if="!isDefaultRow(g)" icon="i-lucide-x" size="xs" variant="ghost" color="neutral" class="shrink-0"
                :aria-label="`Remove group ${i + 1}`" @click="() => { groupRows.splice(i, 1) }"
              />
              <span v-else style="flex: 0 0 1.75rem;" />
            </div>
            <UButton label="Add group" icon="i-lucide-plus" size="xs" variant="ghost" color="neutral" @click="addGroup" />
          </div>

          <div class="t-small text-meta">
            <template v-if="defaultRowUnsaved">
              Ungrouped workflows share the default group. Its cap of
              {{ groups.find(g => g.implicit)?.maxConcurrent }} comes from AGENT_MAX_CONCURRENT_PIPELINES on this
              instance, or the built-in default of 2, and applies until you save a cap here.
            </template>
            <template v-else>
              Ungrouped workflows share the default group, whose cap is saved here — AGENT_MAX_CONCURRENT_PIPELINES no longer applies to it.
            </template>
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showGroups = false }" />
            <UButton label="Save groups" size="sm" :loading="savingGroups" @click="saveGroups" />
          </div>
        </div>
      </template>
    </UModal>

    <!-- Create modal -->
    <UModal v-model:open="showCreateModal">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">New Workflow</h3>
          <form class="space-y-3" @submit.prevent="createBlank">
            <div>
              <label for="wf-name" class="t-small font-medium text-label block mb-1">Name</label>
              <input
                id="wf-name"
                v-model="newName"
                placeholder="My Workflow"
                class="field-input w-full"
                required
              />
            </div>
            <div>
              <label for="wf-desc" class="t-small font-medium text-label block mb-1">Description</label>
              <input
                id="wf-desc"
                v-model="newDescription"
                placeholder="What does this workflow do?"
                class="field-input w-full"
              />
            </div>
            <div class="flex justify-end gap-2 pt-2">
              <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showCreateModal = false }" />
              <UButton type="submit" label="Create" size="sm" :loading="creating" :disabled="!newName.trim()" />
            </div>
          </form>
        </div>
      </template>
    </UModal>
  </div>
</template>
