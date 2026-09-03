<script setup lang="ts">
import { VueFlow, Handle, Position } from '@vue-flow/core'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import type { Workflow, WorkflowStep } from '~/types'
import { getAgentColor } from '~/utils/colors'
import { buildGraph, edgeKey, maxVisitsOf, DEFAULT_MAX_VISITS } from '~/utils/workflowGraph'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const slug = route.params.slug as string
const { fetchOne, update, remove } = useWorkflows()
const { agents } = useAgents()
const { steps: execSteps, isRunning, isPaused, isComplete, currentStepIds, nextStepIds, run, continueWorkflow, continueWith, respondToStep, stop } = useWorkflowExecution()

const workflow = ref<Workflow | null>(null)
const workflowSteps = ref<WorkflowStep[]>([])
const name = ref('')
const description = ref('')
const saving = ref(false)
const showRunModal = ref(false)
const showMobileAgentPicker = ref(false)
const paletteSearch = ref('')
const editingName = ref(false)
const editingDescription = ref(false)
const settingsStepId = ref<string | null>(null)

// Load workflow
onMounted(async () => {
  try {
    const data = await fetchOne(slug)
    workflow.value = data
    workflowSteps.value = [...data.steps]
    name.value = data.name
    description.value = data.description
  } catch {
    toast.add({ title: 'Workflow not found', color: 'error' })
    router.push('/workflows')
  }
})

const graph = computed(() => buildGraph(workflowSteps.value))
const stepById = (id: string) => workflowSteps.value.find(s => s.id === id)
const agentBySlug = (agentSlug?: string) => agents.value.find(a => a.slug === agentSlug)
const labelOf = (id: string) => stepById(id)?.label || 'Step'

/** Distinct monitors in use, each rendered once with a dashed link to every step it watches. */
const monitorGroups = computed(() => {
  const groups = new Map<string, string[]>()
  for (const step of workflowSteps.value) {
    if (!step.monitorSlug) continue
    const watched = groups.get(step.monitorSlug) ?? []
    watched.push(step.id)
    groups.set(step.monitorSlug, watched)
  }
  return groups
})

const defaultPosition = (i: number) => ({ x: i * 220, y: 100 })

const nodes = computed(() => {
  const stepNodes = workflowSteps.value.map((step, i) => {
    const agent = agentBySlug(step.agentSlug)
    const exec = execSteps.value.find(e => e.stepId === step.id)
    return {
      id: step.id,
      type: 'workflow',
      position: step.position ?? defaultPosition(i),
      data: {
        label: step.label,
        agentSlug: step.agentSlug,
        agentColor: agent?.frontmatter.color,
        agentModel: agent?.frontmatter.model,
        monitorLabel: agentBySlug(step.monitorSlug)?.frontmatter.name ?? step.monitorSlug,
        maxVisits: step.maxVisits,
        status: exec?.status,
        visits: exec?.visits,
        monitorVerdict: exec?.monitorVerdict,
      },
    }
  })

  const monitorNodes = [...monitorGroups.value.entries()].map(([monitorSlug, watched]) => {
    const positions = watched.map((id) => {
      const idx = workflowSteps.value.findIndex(s => s.id === id)
      return stepById(id)?.position ?? defaultPosition(idx)
    })
    const avgX = positions.reduce((sum, p) => sum + p.x, 0) / (positions.length || 1)
    const maxY = Math.max(...positions.map(p => p.y), 100)
    return {
      id: `monitor:${monitorSlug}`,
      type: 'monitor',
      draggable: false,
      selectable: false,
      position: { x: avgX, y: maxY + 200 },
      data: {
        label: agentBySlug(monitorSlug)?.frontmatter.name ?? monitorSlug,
        color: getAgentColor(agentBySlug(monitorSlug)?.frontmatter.color),
        watching: watched.length,
      },
    }
  })

  return [...stepNodes, ...monitorNodes]
})

const edges = computed(() => {
  const g = graph.value
  const flowEdges = workflowSteps.value.flatMap(step =>
    (g.succ[step.id] ?? []).map((target) => {
      const isBack = g.backEdges.has(edgeKey(step.id, target))
      return {
        id: `e-${step.id}-${target}`,
        source: step.id,
        target,
        sourceHandle: isBack ? 'loop' : 'out',
        targetHandle: 'in',
        type: isBack ? 'smoothstep' : 'default',
        animated: !isBack,
        label: isBack ? `loop ≤${maxVisitsOf(stepById(target) ?? { id: target })}` : undefined,
        labelStyle: { fill: 'var(--warning, #e5a93e)', fontSize: '10px' },
        style: isBack
          ? { stroke: 'var(--warning, #e5a93e)', strokeWidth: 1.5 }
          : { strokeDasharray: '5 5', stroke: 'var(--accent)' },
        markerEnd: { type: 'arrowclosed', color: isBack ? 'var(--warning, #e5a93e)' : 'var(--accent)' },
      }
    }),
  )

  const monitorEdges = [...monitorGroups.value.entries()].flatMap(([monitorSlug, watched]) =>
    watched.map(stepId => ({
      id: `m-${monitorSlug}-${stepId}`,
      source: `monitor:${monitorSlug}`,
      target: stepId,
      selectable: false,
      style: { strokeDasharray: '2 4', stroke: 'var(--text-disabled)', strokeWidth: 1 },
    })),
  )

  return [...flowEdges, ...monitorEdges]
})

/**
 * Freeze the implicit array-order chain into explicit `next` arrays. Called before the first
 * hand-drawn change, so legacy workflows keep their shape instead of losing every link.
 */
function materializeEdges() {
  if (workflowSteps.value.some(s => s.next !== undefined)) return
  const g = buildGraph(workflowSteps.value)
  workflowSteps.value = workflowSteps.value.map(s => ({ ...s, next: [...(g.succ[s.id] ?? [])] }))
}

function onConnect({ source, target }: { source: string, target: string }) {
  if (isRunning.value || !source || !target || source.startsWith('monitor:') || target.startsWith('monitor:')) return
  materializeEdges()
  workflowSteps.value = workflowSteps.value.map((s) => {
    if (s.id !== source) return s
    const next = s.next ?? []
    return next.includes(target) ? s : { ...s, next: [...next, target] }
  })
}

function onEdgeClick({ edge }: { edge: { id: string, source: string, target: string } }) {
  if (isRunning.value || edge.id.startsWith('m-')) return
  materializeEdges()
  workflowSteps.value = workflowSteps.value.map(s =>
    s.id === edge.source ? { ...s, next: (s.next ?? []).filter(id => id !== edge.target) } : s,
  )
}

function onNodeDragStop({ node }: { node: { id: string, position: { x: number, y: number } } }) {
  if (node.id.startsWith('monitor:')) return
  workflowSteps.value = workflowSteps.value.map(s =>
    s.id === node.id ? { ...s, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } } : s,
  )
}

function addStep(agentSlug: string, position?: { x: number, y: number }) {
  const agent = agentBySlug(agentSlug)
  if (!agent || isRunning.value) return
  // Once edges are explicit, a new node starts unconnected rather than silently
  // inheriting the array-order fallback.
  const explicit = workflowSteps.value.some(s => s.next !== undefined)
  workflowSteps.value = [...workflowSteps.value, {
    id: crypto.randomUUID(),
    agentSlug,
    label: agent.frontmatter.name,
    ...(explicit ? { next: [] } : {}),
    ...(position ? { position } : {}),
  }]
  showMobileAgentPicker.value = false
}

function onDrop(event: DragEvent) {
  const agentSlug = event.dataTransfer?.getData('agentSlug')
  if (!agentSlug) return
  addStep(agentSlug)
}

function onDragOver(event: DragEvent) { event.preventDefault() }

function removeStep(stepId: string) {
  if (isRunning.value) return
  workflowSteps.value = workflowSteps.value
    .filter(s => s.id !== stepId)
    .map(s => (s.next ? { ...s, next: s.next.filter(id => id !== stepId) } : s))
}

// Per-step settings (monitor agent + loop cap)
const settingsStep = computed(() => (settingsStepId.value ? stepById(settingsStepId.value) : undefined))
// Agent descriptions run to whole paragraphs here - clip them or the picker is unreadable.
const summarise = (text?: string) => {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine
}
const monitorOptions = computed(() => [
  { value: undefined, label: 'No monitor', description: 'Run this step unsupervised' },
  ...agents.value.map(a => ({ value: a.slug, label: a.frontmatter.name, description: summarise(a.frontmatter.description) })),
])

function patchStep(stepId: string, changes: Partial<WorkflowStep>) {
  workflowSteps.value = workflowSteps.value.map(s => (s.id === stepId ? { ...s, ...changes } : s))
}

const settingsMonitor = computed({
  get: () => settingsStep.value?.monitorSlug,
  set: (value?: string) => settingsStepId.value && patchStep(settingsStepId.value, { monitorSlug: value || undefined }),
})
const settingsMaxVisits = computed({
  get: () => settingsStep.value?.maxVisits ?? DEFAULT_MAX_VISITS,
  set: (value: number) => {
    const clamped = Math.max(1, Math.min(20, Math.floor(Number(value) || DEFAULT_MAX_VISITS)))
    if (settingsStepId.value) patchStep(settingsStepId.value, { maxVisits: clamped })
  },
})

async function save() {
  if (!workflow.value) return
  saving.value = true
  try {
    await update(slug, {
      name: name.value,
      description: description.value,
      steps: workflowSteps.value,
    })
    toast.add({ title: 'Workflow saved', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Failed to save', description: e.data?.message || e.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

async function deleteWorkflow() {
  if (!confirm('Delete this workflow?')) return
  try {
    await remove(slug)
    router.push('/workflows')
  } catch (e: any) {
    toast.add({ title: 'Failed to delete', description: e.data?.message || e.message, color: 'error' })
  }
}

async function startRun(prompt: string, projectDir?: string, autoRun = false) {
  showRunModal.value = false
  if (!workflow.value) return
  const w = { ...workflow.value, steps: workflowSteps.value }
  await run(w, prompt, projectDir, autoRun)
  try {
    await update(slug, { lastRunAt: new Date().toISOString() } as any)
  } catch {
    // Non-critical
  }
}

const canRun = computed(() => workflowSteps.value.length > 0 && !isRunning.value)
const filteredAgents = computed(() => {
  if (!paletteSearch.value) return agents.value
  const q = paletteSearch.value.toLowerCase()
  return agents.value.filter(a => a.frontmatter.name.toLowerCase().includes(q))
})

const nextStepLabels = computed(() => nextStepIds.value.map(labelOf))
const parallelHint = computed(() => graph.value.entries.length > 1
  || workflowSteps.value.some(s => (graph.value.succ[s.id] ?? []).length > 1))

// Track the run's own end, not "every node has a terminal status" - with a cycle every node
// can read completed while the loop still has laps left, and between waves while it is paused.
const allCompleted = computed(() => execSteps.value.length > 0 && isComplete.value && !isRunning.value)
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Top bar -->
    <div
      class="h-14 flex items-center gap-3 px-4 shrink-0 sticky top-0 z-10"
      style="border-bottom: 1px solid var(--border-subtle); background: var(--surface-base);"
    >
      <NuxtLink to="/workflows" class="p-1.5 rounded-lg hover-bg focus-ring">
        <UIcon name="i-lucide-arrow-left" class="size-4 text-meta" />
      </NuxtLink>

      <!-- Editable name -->
      <div class="flex-1 min-w-0">
        <input
          v-if="editingName"
          v-model="name"
          class="field-input text-[14px] font-medium w-full max-w-xs"
          @blur="editingName = false"
          @keydown.enter="editingName = false"
        />
        <button
          v-else
          class="text-[14px] font-medium truncate text-left"
          style="color: var(--text-primary);"
          @click="editingName = true"
        >
          {{ name || 'Untitled Workflow' }}
        </button>
      </div>

      <!-- Mobile: Add Agent button -->
      <UButton
        class="md:hidden"
        label="Add Agent"
        icon="i-lucide-plus"
        size="xs"
        variant="soft"
        @click="showMobileAgentPicker = true"
      />

      <UButton
        v-if="isRunning"
        label="Stop"
        icon="i-lucide-square"
        size="sm"
        color="error"
        variant="soft"
        @click="stop"
      />
      <UButton
        v-else
        label="Run"
        icon="i-lucide-play"
        size="sm"
        :disabled="!canRun"
        @click="showRunModal = true"
      />
      <UButton label="Save" icon="i-lucide-save" size="sm" variant="soft" :loading="saving" @click="save" />
      <UButton icon="i-lucide-trash-2" size="sm" variant="ghost" color="error" @click="deleteWorkflow" />
    </div>

    <!-- Description -->
    <div class="px-4 py-2 flex items-center gap-3" style="border-bottom: 1px solid var(--border-subtle);">
      <input
        v-if="editingDescription"
        v-model="description"
        class="field-input text-[12px] w-full max-w-lg"
        placeholder="Workflow description..."
        @blur="editingDescription = false"
        @keydown.enter="editingDescription = false"
      />
      <button
        v-else
        class="text-[12px] text-left flex-1 truncate"
        style="color: var(--text-tertiary);"
        @click="editingDescription = true"
      >
        {{ description || 'Click to add a description...' }}
      </button>
      <span
        v-if="parallelHint"
        class="text-[10px] shrink-0"
        style="color: var(--text-disabled);"
        title="Parallel branches share one project folder. Safe for agents that read and analyse; risky for two agents writing the same files."
      >
        <UIcon name="i-lucide-git-branch" class="size-3 -mt-px" /> parallel branches share one folder
      </span>
    </div>

    <!-- Body: palette + canvas -->
    <div class="flex-1 flex min-h-0">
      <!-- Left palette (hidden on mobile) -->
      <div
        class="hidden md:flex flex-col w-[200px] shrink-0 overflow-hidden"
        style="border-right: 1px solid var(--border-subtle); background: var(--surface-raised);"
      >
        <div class="px-3 pt-3 pb-2">
          <div class="text-[11px] font-medium mb-2" style="color: var(--text-secondary);">Your Agents</div>
          <input
            v-model="paletteSearch"
            placeholder="Filter..."
            class="field-search w-full text-[11px]"
          />
        </div>
        <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          <div
            v-for="agent in filteredAgents"
            :key="agent.slug"
            draggable="true"
            class="flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-grab active:cursor-grabbing hover-bg transition-colors"
            @dragstart="(e: DragEvent) => { e.dataTransfer?.setData('agentSlug', agent.slug) }"
          >
            <div
              class="size-2 rounded-full shrink-0"
              :style="{ background: getAgentColor(agent.frontmatter.color) }"
            />
            <span class="text-[11px] truncate" style="color: var(--text-secondary);">
              {{ agent.frontmatter.name }}
            </span>
            <UIcon name="i-lucide-grip-vertical" class="size-3 ml-auto text-meta opacity-50" />
          </div>
          <div v-if="!filteredAgents.length" class="text-[11px] text-center py-4 text-meta">
            No agents found
          </div>
        </div>
        <div class="px-3 py-2 text-[10px] leading-relaxed" style="border-top: 1px solid var(--border-subtle); color: var(--text-disabled);">
          Drag a handle to link steps. Several links out of one step run in parallel; a link back to an
          earlier step loops. Click a link to delete it.
        </div>
      </div>

      <!-- Canvas -->
      <div class="flex-1 flex flex-col min-w-0">
        <div class="flex-1 min-h-[300px]">
          <VueFlow
            :nodes="nodes"
            :edges="edges"
            fit-view-on-init
            :min-zoom="0.3"
            :max-zoom="2"
            :nodes-connectable="!isRunning"
            :nodes-draggable="!isRunning"
            @drop="onDrop"
            @dragover="onDragOver"
            @connect="onConnect"
            @edge-click="onEdgeClick"
            @node-drag-stop="onNodeDragStop"
          >
            <template #node-workflow="nodeProps">
              <WorkflowNode
                :data="nodeProps.data"
                @remove="removeStep(nodeProps.id)"
                @settings="settingsStepId = nodeProps.id"
              />
            </template>

            <template #node-monitor="nodeProps">
              <div
                class="rounded-xl px-3 py-2 flex items-center gap-2"
                style="width: 170px; background: var(--surface-raised); border: 1px dashed var(--border-subtle);"
              >
                <Handle id="out" type="source" :position="Position.Top" />
                <UIcon name="i-lucide-shield" class="size-3.5 shrink-0" :style="{ color: nodeProps.data.color }" />
                <div class="min-w-0">
                  <div class="text-[11px] font-medium truncate" style="color: var(--text-primary);">
                    {{ nodeProps.data.label }}
                  </div>
                  <div class="text-[9px]" style="color: var(--text-disabled);">
                    monitoring {{ nodeProps.data.watching }} step{{ nodeProps.data.watching === 1 ? '' : 's' }}
                  </div>
                </div>
              </div>
            </template>

            <Controls position="bottom-right" />
            <MiniMap v-if="workflowSteps.length >= 5" position="top-right" />
          </VueFlow>

          <!-- Empty canvas state -->
          <div
            v-if="!workflowSteps.length && workflow"
            class="absolute inset-0 flex items-center justify-center pointer-events-none"
          >
            <div class="text-center space-y-2">
              <UIcon name="i-lucide-mouse-pointer-click" class="size-8 mx-auto" style="color: var(--text-disabled);" />
              <p class="text-[13px]" style="color: var(--text-tertiary);">
                Drag agents from the left panel onto the canvas
              </p>
            </div>
          </div>
        </div>

        <!-- Workflow complete banner -->
        <div
          v-if="allCompleted && execSteps.length > 0"
          class="px-4 py-2.5 flex items-center gap-2"
          style="background: rgba(74, 222, 128, 0.06); border-top: 1px solid rgba(74, 222, 128, 0.12);"
        >
          <UIcon name="i-lucide-check-circle" class="size-4" style="color: var(--success, #22c55e);" />
          <span class="text-[12px] font-medium" style="color: var(--success, #22c55e);">Workflow complete</span>
        </div>

        <!-- Execution log -->
        <div v-if="execSteps.length > 0" class="p-4">
          <WorkflowExecutionLog
            :steps="execSteps"
            :workflow-steps="workflowSteps"
            :current-step-ids="currentStepIds"
            :next-step-labels="nextStepLabels"
            :is-paused="isPaused"
            :is-complete="isComplete"
            @continue="continueWorkflow"
            @continue-with="continueWith"
            @respond="respondToStep"
            @stop="stop"
          />
        </div>
      </div>
    </div>

    <!-- Run modal -->
    <WorkflowRunModal
      :open="showRunModal"
      @update:open="showRunModal = $event"
      @start="startRun"
    />

    <!-- Step settings -->
    <UModal :open="!!settingsStepId" @update:open="settingsStepId = $event ? settingsStepId : null">
      <template #content>
        <div v-if="settingsStep" class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">{{ settingsStep.label }}</h3>

          <div class="field-group">
            <label class="field-label">Monitor agent</label>
            <USelectDropdown v-model="settingsMonitor" :options="monitorOptions" placeholder="No monitor" />
            <span class="field-hint">
              Reviews this step's output and replies CONTINUE, RETRY or ABORT. RETRY re-runs the step
              with the monitor's feedback. Doubles the agent calls for this step.
            </span>
          </div>

          <div class="field-group">
            <label class="field-label">Max visits per run</label>
            <input
              :value="settingsMaxVisits"
              type="number"
              min="1"
              max="20"
              class="field-input w-24"
              @change="settingsMaxVisits = ($event.target as HTMLInputElement).valueAsNumber"
            />
            <span class="field-hint">
              How many times a loop or a monitor retry may bring this step back. Default {{ DEFAULT_MAX_VISITS }}.
            </span>
          </div>

          <div class="flex justify-end">
            <UButton label="Done" size="sm" @click="settingsStepId = null" />
          </div>
        </div>
      </template>
    </UModal>

    <!-- Mobile agent picker -->
    <UModal v-model:open="showMobileAgentPicker">
      <template #content>
        <div class="p-4 space-y-3 bg-overlay">
          <h3 class="text-page-title">Add Agent</h3>
          <input
            v-model="paletteSearch"
            placeholder="Search agents..."
            class="field-search w-full"
          />
          <div class="space-y-1 max-h-64 overflow-y-auto">
            <button
              v-for="agent in filteredAgents"
              :key="agent.slug"
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover-bg text-left"
              @click="addStep(agent.slug)"
            >
              <div
                class="size-2 rounded-full shrink-0"
                :style="{ background: getAgentColor(agent.frontmatter.color) }"
              />
              <span class="text-[12px]" style="color: var(--text-secondary);">
                {{ agent.frontmatter.name }}
              </span>
            </button>
          </div>
          <div class="flex justify-end">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="showMobileAgentPicker = false" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
