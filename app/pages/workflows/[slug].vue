<script setup lang="ts">
import type { Edge } from '@vue-flow/core'
import { VueFlow, Handle, Position, MarkerType, useVueFlow } from '@vue-flow/core'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import type { Workflow, WorkflowStep, WorkflowParameter } from '~/types'
import { getAgentColor } from '~/utils/colors'
import { buildGraph, edgeKey, maxVisitsOf, DEFAULT_MAX_VISITS } from '~~/shared/utils/workflowGraph'
import { isValidParameterName, RESERVED_PARAM_PROJECT_DIR } from '~~/shared/utils/workflowParameters'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const slug = route.params.slug as string
const { fetchOne, update, remove } = useWorkflows()
const { agents } = useAgents()
const { run, runs, logs, attach, start, continueRun, stop, restart, respond, sendNote } = useWorkflowRun(slug)
// The PAGE fetches, not the panel: the tab's own label carries the count, so it
// is needed before the panel mounts.
const { fetchAll: fetchSchedules, forWorkflow } = useSchedules()
const scheduleRows = forWorkflow(slug)
const runInitial = ref<{ prompt: string, projectDir?: string, autoRun: boolean, parameters?: Record<string, string> } | undefined>()

/** One-shot intents from the Runs page and workflow cards (?run=, ?clone=, ?start=1).
 *  Consumed then removed from the URL so a reload does not repeat them. */
function applyQueryIntent() {
  const q = route.query
  if (typeof q.run === 'string') {
    const found = runs.value.find(r => r.id === q.run)
    if (found) run.value = found
  }
  if (typeof q.clone === 'string') {
    const src = runs.value.find(r => r.id === q.clone)
    runInitial.value = src ? { prompt: src.initialPrompt, projectDir: src.projectDir, autoRun: src.autoRun, parameters: src.parameters } : undefined
    showRunModal.value = true
  }
  if (q.start === '1') { runInitial.value = undefined; showRunModal.value = true }
  // `tab` is carried through rather than stripped with the intents: it is a
  // link target, not a one-shot, so ?run=X&tab=schedule must not lose the tab
  // when the intent is consumed.
  if (q.run || q.clone || q.start) router.replace({ path: route.path, query: q.tab ? { tab: q.tab } : {} })
}
const showRunDetails = ref(false)
function cloneRun() {
  if (!run.value) return
  runInitial.value = { prompt: run.value.initialPrompt, projectDir: run.value.projectDir, autoRun: run.value.autoRun, parameters: run.value.parameters }
  showRunModal.value = true
}

// The panel and the canvas nodes both read per-step status off the server-owned run.
// These mirror the shape the old client-side engine exposed, so the rest of the page
// (node status badges, the complete banner, next-step labels) is unchanged.
const execSteps = computed(() => run.value?.steps ?? [])
const isRunning = computed(() => run.value?.status === 'running')
const isPaused = computed(() => run.value?.status === 'paused')
const isComplete = computed(() => !!run.value && ['completed', 'failed', 'stopped', 'interrupted'].includes(run.value.status))

/** Clicking a previous (terminal) run in the panel's history list just shows it - no stream needed. */
function attachRun(id: string) {
  const found = runs.value.find(r => r.id === id)
  if (found) run.value = found
}

/** Return from a run's detail to the history list. The panel renders the list
 *  as v-else of the detail, so without a way to clear the selection, opening
 *  any run hid every other run for the rest of the visit. */
function closeRun() {
  run.value = null
}

const workflow = ref<Workflow | null>(null)
const workflowSteps = ref<WorkflowStep[]>([])
/** The workflow's declared inputs. Edited here, collected by the run modal,
 *  and stated to every step by the runner. */
const workflowParameters = ref<WorkflowParameter[]>([])
const name = ref('')
const description = ref('')
// Edges are deleted by a click and nodes moved by a drag; leaving discards both silently without this.
const isDirty = computed(() => !!workflow.value && JSON.stringify({ n: name.value, d: description.value, s: workflowSteps.value }) !== JSON.stringify({ n: workflow.value.name, d: workflow.value.description, s: workflow.value.steps }))
useUnsavedChanges(isDirty)
const saving = ref(false)
const lastModified = ref<number | null>(null)
const showRunModal = ref(false)
const showParameters = ref(false)
/**
 * Seeded once at setup, before any await, the way explore.vue does it - and
 * never written back on click. A query param the page both reads and writes
 * can interleave with applyQueryIntent()'s replace on first paint and either
 * lose an intent or resurrect a consumed one. A link sets the tab; a click
 * does not need the URL to know.
 */
const activeTab = ref<'canvas' | 'schedule'>(route.query.tab === 'schedule' ? 'schedule' : 'canvas')
/** The declaration as the server has it. The Inputs editor mutates
 *  workflowParameters; a schedule is validated against THIS, so the two are
 *  tracked separately and the difference is what warns the Schedule tab. */
const savedParameters = ref<WorkflowParameter[]>([])
const showMobileAgentPicker = ref(false)
const paletteSearch = ref('')
const editingName = ref(false)
const editingDescription = ref(false)
const settingsStepId = ref<string | null>(null)
useHead({ title: computed(() => `${name.value || 'Workflow'} | Agent Manager`) })

// Load workflow
onMounted(async () => {
  try {
    const data = await fetchOne(slug)
    workflow.value = data
    lastModified.value = (data as any).lastModified ?? null
    workflowSteps.value = [...data.steps]
    workflowParameters.value = [...(data.parameters ?? [])]
    savedParameters.value = [...(data.parameters ?? [])]
    name.value = data.name
    description.value = data.description
  } catch {
    toast.add({ title: 'Workflow not found', color: 'error' })
    router.push('/workflows')
  }
  // Attach to whatever the server is already running for this workflow, if anything -
  // a run outlives this tab, so a reload must not lose it. Then honour any
  // one-shot intent in the URL, which may point at a finished run instead.
  await attach()
  applyQueryIntent()
  // Fire-and-forget: the tab label's count can arrive a moment later, and
  // nothing above it should wait on a schedule read.
  void fetchSchedules()
})

const parametersDirty = computed(() =>
  JSON.stringify(workflowParameters.value.filter(p => p.name.trim())) !== JSON.stringify(savedParameters.value))

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

// Unpositioned steps wrap into rows of five: a 13-step runbook in one row is 2,860px wide and unreadable once fitted.
const defaultPosition = (i: number) => ({ x: (i % 5) * 220, y: 100 + Math.floor(i / 5) * 150 })

// Fit once, when both the pane and the nodes are measured. `fit-view-on-init`
// consumes itself against a pane that is still hidden behind app.vue's v-show
// (the workflow often loads before /api/config does) and never retries.
const { fitView, onPaneReady, onNodesInitialized } = useVueFlow()
let paneReady = false
let fitted = false
// Only once the pane is measured: fitView on an unmeasured pane is a no-op that logs a warning.
const fitOnce = async () => { if (paneReady && !fitted && await fitView()) fitted = true }
onPaneReady(() => { paneReady = true; void fitOnce() })
onNodesInitialized(fitOnce)

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
        approval: step.approval === true,
        runWhen: step.runWhen?.artifact,
        triggerSource: step.triggerWorkflow?.source,
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

const edges = computed<Edge[]>(() => {
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
        markerEnd: { type: MarkerType.ArrowClosed, color: isBack ? 'var(--warning, #e5a93e)' : 'var(--accent)' },
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
const agentOptions = computed(() => agents.value.map(a => ({ value: a.slug, label: a.frontmatter.name || a.slug })))
const settingsAgent = computed({
  get: () => settingsStep.value?.agentSlug,
  set: (value?: string) => { if (settingsStepId.value && value) patchStep(settingsStepId.value, { agentSlug: value }) },
})
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
const settingsRunWhen = computed({
  get: () => settingsStep.value?.runWhen?.artifact ?? '',
  set: (value: string) => {
    const artifact = value.trim()
    if (settingsStepId.value) patchStep(settingsStepId.value, { runWhen: artifact ? { artifact } : undefined })
  },
})
/** The artifact a dispatch step fans out over. Emptying it removes the whole
 *  triggerWorkflow block: a step with a routing table and no source to read it
 *  against is config that can never fire. */
const settingsTriggerSource = computed({
  get: () => settingsStep.value?.triggerWorkflow?.source ?? '',
  set: (value: string) => {
    const source = value.trim()
    if (!settingsStepId.value) return
    const current = settingsStep.value?.triggerWorkflow
    patchStep(settingsStepId.value, { triggerWorkflow: source ? { ...current, source } : undefined })
  },
})
const settingsTriggerSlug = computed({
  get: () => settingsStep.value?.triggerWorkflow?.slug ?? '',
  set: (value: string) => {
    const slug = value.trim()
    const current = settingsStep.value?.triggerWorkflow
    if (!settingsStepId.value || !current) return
    patchStep(settingsStepId.value, { triggerWorkflow: { ...current, slug: slug || undefined } })
  },
})
const settingsTriggerRouteBy = computed({
  get: () => settingsStep.value?.triggerWorkflow?.routeBy ?? '',
  set: (value: string) => {
    const routeBy = value.trim()
    const current = settingsStep.value?.triggerWorkflow
    if (!settingsStepId.value || !current) return
    patchStep(settingsStepId.value, { triggerWorkflow: { ...current, routeBy: routeBy || undefined } })
  },
})
/** The routing table, edited as `value: workflow-slug` lines. A JSON object in
 *  a text box is a worse thing to type than one pair per line, and this is the
 *  only place a person writes it. */
const settingsTriggerRoutes = computed({
  get: () => Object.entries(settingsStep.value?.triggerWorkflow?.routes ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
  set: (value: string) => {
    const current = settingsStep.value?.triggerWorkflow
    if (!settingsStepId.value || !current) return
    const routes: Record<string, string> = {}
    for (const line of value.split('\n')) {
      const at = line.indexOf(':')
      if (at < 1) continue
      const key = line.slice(0, at).trim()
      const slug = line.slice(at + 1).trim()
      if (key && slug) routes[key] = slug
    }
    patchStep(settingsStepId.value, { triggerWorkflow: { ...current, routes: Object.keys(routes).length ? routes : undefined } })
  },
})
const settingsMaxVisits = computed({
  get: () => settingsStep.value?.maxVisits ?? DEFAULT_MAX_VISITS,
  set: (value: number) => {
    const clamped = Math.max(1, Math.min(20, Math.floor(Number(value) || DEFAULT_MAX_VISITS)))
    if (settingsStepId.value) patchStep(settingsStepId.value, { maxVisits: clamped })
  },
})

function addParameter() {
  workflowParameters.value.push({ name: '' })
}

function removeParameter(index: number) {
  workflowParameters.value.splice(index, 1)
}

/** A name that is not an identifier reads as two tokens in a step header and
 *  cannot be referred to, so it is flagged here rather than silently dropped
 *  on save. */
function parameterNameError(index: number): string | null {
  const param = workflowParameters.value[index]
  if (!param) return null
  const name = param.name.trim()
  if (!name) return null
  if (!isValidParameterName(name)) return 'Letters, digits and _ only, starting with a lowercase letter'
  if (workflowParameters.value.some((other, i) => i !== index && other.name.trim() === name)) return 'Declared twice'
  return null
}

async function save() {
  if (!workflow.value) return
  saving.value = true
  try {
    const saved = await update(slug, {
      name: name.value,
      description: description.value,
      steps: workflowSteps.value,
      parameters: workflowParameters.value.filter(p => p.name.trim()),
      lastModified: lastModified.value ?? undefined,
    } as any)
    lastModified.value = (saved as any).lastModified ?? null
    workflow.value = saved as any
    // The baseline a schedule is checked against moves with the save, which is
    // what clears the Schedule tab's unsaved-inputs warning.
    savedParameters.value = workflowParameters.value.filter(p => p.name.trim())
    toast.add({ title: 'Workflow saved', color: 'success' })
  } catch (e: any) {
    if (e?.statusCode === 409 || e?.data?.statusCode === 409) toast.add({ title: 'Changed by someone else', description: (e.data?.message || 'Reload to see the latest version before saving again.') + (e.data?.data?.lastModified ? ` Last saved ${new Date(e.data.data.lastModified).toLocaleTimeString()}.` : ''), color: 'warning' })
    else toast.add({ title: 'Failed to save', description: e.data?.message || e.message, color: 'error' })
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

async function startRun(prompt: string, projectDir?: string, autoRun = false, parameters?: Record<string, string>) {
  showRunModal.value = false
  if (!workflow.value) return
  await start(prompt, projectDir, autoRun, parameters)
  try {
    await update(slug, { lastRunAt: new Date().toISOString() } as any)
  } catch {
    // Non-critical
  }
}

const canRun = computed(() => workflowSteps.value.length > 0 && !isRunning.value && !isPaused.value)
const filteredAgents = computed(() => {
  if (!paletteSearch.value) return agents.value
  const q = paletteSearch.value.toLowerCase()
  return agents.value.filter(a => a.frontmatter.name.toLowerCase().includes(q))
})

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
      <NuxtLink to="/workflows" class="p-1.5 rounded-lg hover-bg focus-ring" aria-label="Back to workflows">
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
        @click="() => { showMobileAgentPicker = true }"
      />

      <UButton
        v-if="isRunning || isPaused"
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
        @click="() => { showRunModal = true }"
      />
      <UButton
        :label="workflowParameters.length ? `Inputs (${workflowParameters.length})` : 'Inputs'"
        icon="i-lucide-sliders-horizontal"
        size="sm"
        variant="ghost"
        color="neutral"
        @click="() => { showParameters = true }"
      />
      <UButton label="Save" icon="i-lucide-save" size="sm" variant="soft" :loading="saving" @click="save" />
      <UButton icon="i-lucide-trash-2" size="sm" variant="ghost" color="error" aria-label="Delete workflow" @click="deleteWorkflow" />
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

    <!-- Canvas / Schedule. A hand-rolled strip, matching studio/EditorPanel:
         nothing in this app uses UTabs, and its chrome would not match these
         CSS-var styles. -->
    <div class="shrink-0 flex" style="border-bottom: 1px solid var(--border-subtle);">
      <button
        v-for="tab in (['canvas', 'schedule'] as const)"
        :key="tab"
        class="px-4 py-2.5 text-[12px] font-medium capitalize transition-all relative"
        :style="{ color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-tertiary)' }"
        :data-testid="`workflow-tab-${tab}`"
        @click="activeTab = tab"
      >
        {{ tab }}<!-- Omitted rather than shown as (0) while the fetch is in
             flight: a wrong zero on a workflow that IS scheduled is worse than
             no number. -->
        <span v-if="tab === 'schedule' && scheduleRows.length" class="ml-1 text-meta">({{ scheduleRows.length }})</span>
        <div
          v-if="activeTab === tab"
          class="absolute bottom-0 left-2 right-2 h-0.5 rounded-full"
          style="background: var(--accent);"
        />
      </button>
    </div>

    <!-- Body: palette + canvas.
         v-show, not v-if: VueFlow fits the view on init, so a remount would
         throw away the pan and zoom the person set. The panel below is v-if
         because it should not mount until it is looked at. -->
    <div v-show="activeTab === 'canvas'" class="flex-1 flex min-h-0">
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
            aria-label="Filter agents"
            class="field-search w-full text-[11px]"
          />
        </div>
        <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          <button
            v-for="agent in filteredAgents"
            :key="agent.slug"
            type="button"
            draggable="true"
            class="w-full text-left flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-grab active:cursor-grabbing hover-bg transition-colors focus-ring"
            @dragstart="(e: DragEvent) => { e.dataTransfer?.setData('agentSlug', agent.slug) }"
            @click="addStep(agent.slug)"
          >
            <div
              class="size-2 rounded-full shrink-0"
              :style="{ background: getAgentColor(agent.frontmatter.color) }"
            />
            <span class="text-[11px] truncate" style="color: var(--text-secondary);">
              {{ agent.frontmatter.name }}
            </span>
            <UIcon name="i-lucide-grip-vertical" class="size-3 ml-auto text-meta opacity-50" />
          </button>
          <div v-if="!filteredAgents.length" class="text-[11px] text-center py-4 text-meta">
            No agents found
          </div>
        </div>
        <div class="px-3 py-2 text-[10px] leading-relaxed" style="border-top: 1px solid var(--border-subtle); color: var(--text-tertiary);">
          Click or drag an agent to add a step. Drag a handle to link steps. Several links out of one step run in parallel; a link back to an
          earlier step loops. Click a link to delete it.
        </div>
      </div>

      <!-- Canvas -->
      <div class="flex-1 flex flex-col min-w-0">
        <!-- Run controls stay in view; per-step detail opens in a slide-over. -->
        <WorkflowRunBar
          :run="run"
          :runs="runs"
          :logs="logs"
          @continue="continueRun()"
          @stop="stop"
          @restart="restart"
          @clone="cloneRun"
          @close="closeRun"
          @details="showRunDetails = true"
        />
        <div class="flex-1 min-h-[300px] relative">
          <VueFlow
            id="workflow-canvas"
            :nodes="nodes"
            :edges="edges"
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

      </div>
    </div>

    <!-- When this workflow runs on its own. Mounted lazily, unlike the canvas. -->
    <WorkflowSchedulePanel
      v-if="activeTab === 'schedule'"
      class="flex-1 min-h-0 overflow-y-auto"
      :workflow-slug="slug"
      :workflow-name="name"
      :parameters="savedParameters"
      :schedulable="workflowSteps.length > 0"
      :parameters-dirty="parametersDirty"
    />

    <!-- Run detail: live per-agent rows while a run is active, run history otherwise -->
    <USlideover v-model:open="showRunDetails" title="Run details">
      <template #body>
        <WorkflowRunPanel
          :run="run"
          :runs="runs"
          :logs="logs"
          @continue="(n) => continueRun(n)"
          @respond="respond"
          @note="sendNote"
          @stop="stop"
          @attach="attachRun"
          @restart="(stepId, note) => restart(stepId, note)"
          @clone="cloneRun"
          @close="closeRun"
        />
      </template>
    </USlideover>

    <!-- Run modal -->
    <WorkflowRunModal
      :open="showRunModal"
      :initial="runInitial"
      :parameters="workflowParameters"
      @update:open="showRunModal = $event"
      @start="startRun"
    />

    <!-- Workflow inputs: what an operator (or a schedule) must state before a
         run starts, instead of hoping it was buried in the prompt. -->
    <UModal :open="showParameters" @update:open="showParameters = $event">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">Workflow inputs</h3>
          <p class="text-[12px] text-label">
            Named values collected when a run starts and stated to every step. Declare what this
            workflow needs - which repository, which Jira project - so no agent has to work it out
            from the prompt.
          </p>

          <div v-if="!workflowParameters.length" class="text-[12px]" style="color: var(--text-disabled);">
            No inputs declared. Runs are started with just the prompt.
          </div>

          <div v-for="(param, index) in workflowParameters" :key="index" class="field-group">
            <div class="flex items-start gap-2">
              <div class="flex-1 space-y-2">
                <input
                  v-model="param.name"
                  placeholder="name, e.g. jira_project"
                  class="field-input w-full"
                >
                <span v-if="parameterNameError(index)" class="field-hint" style="color: var(--text-error, #dc2626);">
                  {{ parameterNameError(index) }}
                </span>
                <input
                  v-model="param.description"
                  placeholder="what it is for (shown to whoever starts the run)"
                  class="field-input w-full"
                >
                <div class="flex items-center gap-3">
                  <input
                    v-model="param.default"
                    placeholder="default (optional)"
                    class="field-input flex-1"
                  >
                  <label class="flex items-center gap-2 cursor-pointer shrink-0">
                    <input v-model="param.required" type="checkbox" class="shrink-0">
                    <span class="field-label mb-0">Required</span>
                  </label>
                </div>
                <span v-if="param.name.trim() === RESERVED_PARAM_PROJECT_DIR" class="field-hint">
                  Reserved name: this one becomes the run's project folder, and replaces that field
                  in the run dialog. Everything else is stated to the agents as text.
                </span>
              </div>
              <UButton
                icon="i-lucide-trash-2"
                size="sm"
                variant="ghost"
                color="error"
                @click="removeParameter(index)"
              />
            </div>
          </div>

          <div class="flex justify-between gap-2 pt-3">
            <UButton label="Add input" icon="i-lucide-plus" size="sm" variant="soft" @click="addParameter" />
            <div class="flex gap-2">
              <UButton label="Close" variant="ghost" color="neutral" size="sm" @click="() => { showParameters = false }" />
              <UButton label="Save" icon="i-lucide-save" size="sm" :loading="saving" @click="save" />
            </div>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Step settings -->
    <UModal :open="!!settingsStepId" @update:open="settingsStepId = $event ? settingsStepId : null">
      <template #content>
        <div v-if="settingsStep" class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">{{ settingsStep.label }}</h3>

          <div class="field-group">
            <label class="field-label">Agent</label>
            <div class="flex items-center gap-2">
              <USelectDropdown v-model="settingsAgent" :options="agentOptions" class="flex-1" />
              <UButton :to="`/agents/${settingsStep.agentSlug}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-pencil" label="Edit agent" />
            </div>
            <span class="field-hint">The agent that runs this step. Editing changes its prompt for every workflow that uses it; a promoted agent changes it for the team.</span>
          </div>

          <div class="field-group">
            <label class="field-label">Monitor agent</label>
            <USelectDropdown v-model="settingsMonitor" :options="monitorOptions" placeholder="No monitor" />
            <span class="field-hint">
              Reviews this step's output and replies CONTINUE, RETRY or ABORT. RETRY re-runs the step
              with the monitor's feedback. Doubles the agent calls for this step.
            </span>
          </div>

          <div class="field-group">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" :checked="settingsStep.approval === true" @change="settingsStepId && patchStep(settingsStepId, { approval: ($event.target as HTMLInputElement).checked || undefined })">
              <span class="field-label mb-0">Ask me before this step runs</span>
            </label>
            <span class="field-hint">The run pauses on the run page until you approve, even when running to completion. Use it for steps with an outward effect, such as pushing and opening the pull request.</span>
          </div>

          <div class="field-group">
            <label class="field-label">Run only when this artifact has content</label>
            <input
              v-model="settingsRunWhen" type="text" class="field-input" placeholder="approved-drafts.json"
            >
            <span class="field-hint">
              A filename in the run's artifacts directory, for a step that consumes what an
              earlier step wrote. Leave empty and the step always runs. When the file is not
              written, or holds an empty array or object, the step is skipped and everything
              downstream still runs. When it exists but is not valid JSON the step fails, so a
              step that crashed mid-write is never mistaken for one with nothing to do.
            </span>
          </div>

          <div v-if="settingsStep.agentSlug === 'sdlc-jira-tracker'" class="field-group">
            <label class="field-label">Move the ticket to</label>
            <input
              :value="settingsStep.jira?.transition ?? ''" type="text" class="field-input" placeholder="In Progress"
              @change="settingsStepId && patchStep(settingsStepId, { jira: { ...(settingsStep.jira ?? {}), transition: ($event.target as HTMLInputElement).value.trim() || undefined } })"
            >
            <label class="flex items-center gap-2 cursor-pointer mt-2">
              <input type="checkbox" :checked="settingsStep.jira?.comment === true" @change="settingsStepId && patchStep(settingsStepId, { jira: { ...(settingsStep.jira ?? {}), comment: ($event.target as HTMLInputElement).checked || undefined } })">
              <span class="field-label mb-0">Post the outcome comment</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer mt-2">
              <input type="checkbox" :checked="settingsStep.jira?.attach === true" @change="settingsStepId && patchStep(settingsStepId, { jira: { ...(settingsStep.jira ?? {}), attach: ($event.target as HTMLInputElement).checked || undefined } })">
              <span class="field-label mb-0">Attach the run's evidence files</span>
            </label>
            <span class="field-hint">Runner-executed, no model call. The status is matched to the ticket's own workflow (with synonyms), so "Dev Done" lands even where the project calls it "Ready for Review"; when nothing matches, the output lists what the ticket offers. Writes reach Jira only when JIRA_POST_ENABLED=1 on the instance.</span>
          </div>

          <div v-if="settingsStep.agentSlug === 'sdlc-auto-dispatcher'" class="field-group">
            <label class="field-label">Dispatch one run per entry in</label>
            <input v-model="settingsTriggerSource" type="text" class="field-input" placeholder="created-tickets.json">
            <template v-if="settingsTriggerSource">
              <label class="field-label mt-2">Route on this field</label>
              <input v-model="settingsTriggerRouteBy" type="text" class="field-input" placeholder="work_type">
              <label class="field-label mt-2">Routes, one <code>value: workflow-slug</code> per line</label>
              <textarea v-model="settingsTriggerRoutes" rows="5" class="field-input font-mono text-xs" placeholder="bug: runbook-a-ticket-to-evidence-backed-pr&#10;feature: runbook-b-feature-request-to-evidence-backed-pr" />
              <label class="field-label mt-2">Workflow for anything the routes miss</label>
              <input v-model="settingsTriggerSlug" type="text" class="field-input" placeholder="runbook-a-ticket-to-evidence-backed-pr">
            </template>
            <span class="field-hint">Runner-executed, no model call. Reads that file from this run's artifacts and starts one run per entry, each in its own checkout. The children are not waited for: this step completes as soon as they exist, and each reports to its own run. An entry nobody can route fails the step and starts nothing, so a batch is never half-dispatched. Concurrent pipelines are capped on the instance (AGENT_MAX_CONCURRENT_PIPELINES); the rest queue and start as slots free up.</span>
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
            <UButton label="Done" size="sm" @click="() => { settingsStepId = null }" />
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
            aria-label="Search agents"
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
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showMobileAgentPicker = false }" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
