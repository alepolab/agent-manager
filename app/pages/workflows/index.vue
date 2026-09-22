<script setup lang="ts">
import { workflowTemplates, materializeTemplateSteps } from '~/utils/workflowTemplates'
import { agentTemplates } from '~/utils/templates'
import { planTemplateResolution } from '~/utils/workflowInstantiation'

const { workflows, loading, error, create, fetchAll } = useWorkflows()
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
      // No non-null assertion: the template catalogue is empty on this instance
      // (oh-my-agent estate only), so `find` legitimately returns undefined and
      // asserting it away is a runtime throw rather than a type convenience.
      const agentTemplate = agentTemplates.find(t => t.id === id)
      if (!agentTemplate) continue
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
</script>

<template>
  <div>
    <PageHeader title="Workflows">
      <template #trailing>
        <span class="t-small text-meta">{{ workflows.length }}</span>
      </template>
      <template #right>
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
              style="background: var(--accent-muted); border: 1px solid rgba(229, 169, 62, 0.15);"
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

    <!-- Create modal -->
    <UModal v-model:open="showCreateModal" title="New workflow"
      description="Name the workflow. You add its steps on the next screen.">
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
