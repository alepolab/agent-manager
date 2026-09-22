<script setup lang="ts">
import type { Edge } from '@vue-flow/core'
import { VueFlow, Handle, Position, MarkerType, useVueFlow } from '@vue-flow/core'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import type { Workflow, WorkflowStep } from '~/types'
import { getAgentColor } from '~/utils/colors'
import { buildGraph, edgeKey, edgeTarget, maxVisitsOf, DEFAULT_MAX_VISITS, type EdgeCondition } from '~~/shared/utils/workflowGraph'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const slug = route.params.slug as string
const { fetchOne, update, remove } = useWorkflows()
const { agents } = useAgents()
// This page had no role awareness at all. It is reachable by URL, and Clone on
// the runs page used to land every role here — so a manager, whose role is
// "Reads progress across runs. Changes nothing", was shown Save and Delete
// workflow. The routes behind them already refuse it; the page did not.
const { can } = useUser()
/**
 * Hiding a button is a courtesy to the person; it is not a control on the edit.
 *
 * Every mutation on this canvas funnels through the five handlers below, and
 * three of them need no button at all: clicking an edge cycles its condition
 * and eventually removes it, dragging a
 * node moves it, dropping an agent adds a step. Guarding the markup alone would
 * leave all three reachable. The server refuses the Save that would persist any
 * of it, so the damage was never permanent — but a canvas that silently discards
 * your edits on reload is a worse answer than one that does not accept them.
 */
const readOnly = computed(() => !can('configure'))
const { run, runs, logs, attach, start, continueRun, stop, restart, respond, sendNote, reject, skip, rework } = useWorkflowRun(slug)
const runInitial = ref<{ prompt: string, projectDir?: string, autoRun: boolean } | undefined>()

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
    runInitial.value = src ? { prompt: src.initialPrompt, projectDir: src.projectDir, autoRun: src.autoRun } : undefined
    showRunModal.value = true
  }
  if (q.start === '1') { runInitial.value = undefined; showRunModal.value = true }
  if (q.run || q.clone || q.start) router.replace({ path: route.path })
}
const showRunDetails = ref(false)
function cloneRun() {
  if (!run.value) return
  runInitial.value = { prompt: run.value.initialPrompt, projectDir: run.value.projectDir, autoRun: run.value.autoRun }
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
const name = ref('')
const description = ref('')
// Edges are deleted by a click and nodes moved by a drag; leaving discards both silently without this.
const isDirty = computed(() => !!workflow.value && JSON.stringify({ n: name.value, d: description.value, s: workflowSteps.value }) !== JSON.stringify({ n: workflow.value.name, d: workflow.value.description, s: workflow.value.steps }))
useUnsavedChanges(isDirty)
const saving = ref(false)
const lastModified = ref<number | null>(null)
const showRunModal = ref(false)
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
        ownerRole: step.ownerRole,
        gateRole: step.gateRole,
        agentColor: agent?.frontmatter.color,
        agentModel: agent?.frontmatter.model,
        monitorLabel: agentBySlug(step.monitorSlug)?.frontmatter.name ?? step.monitorSlug,
        approval: step.approval === true,
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

/**
 * What each edge condition looks like on the canvas.
 *
 * Semantic colour, separate from the accent: a reader has to be able to tell
 * the refusal arm from the success arm at a glance, and an accent-coloured
 * branch says only "this is an edge".
 */
const CONDITION_COLOUR: Record<EdgeCondition, string> = {
  pass: 'var(--success, #2f855a)',
  fail: 'var(--error, #c53030)',
  approved: 'var(--success, #2f855a)',
  rejected: 'var(--error, #c53030)',
  default: 'var(--text-tertiary, #718096)',
}
const CONDITION_LABEL: Record<EdgeCondition, string> = {
  pass: 'on PASS',
  fail: 'on FAIL',
  approved: 'if approved',
  rejected: 'if rejected',
  default: 'otherwise',
}
/**
 * Clicking an edge walks it round this ring. Deleting used to be the only
 * thing a click did, and there was nowhere at all to express a condition —
 * which is why every workflow on this canvas was an unconditional fan-out.
 * Cycling keeps one interaction, reaches delete at the end of the ring, and
 * makes an accidental click recoverable rather than destructive.
 */
const CONDITION_RING: (EdgeCondition | undefined)[] = [undefined, 'pass', 'fail', 'default']

const edges = computed<Edge[]>(() => {
  const g = graph.value
  const flowEdges = workflowSteps.value.flatMap(step =>
    (g.succ[step.id] ?? []).map((target) => {
      const isBack = g.backEdges.has(edgeKey(step.id, target))
      // A conditional edge is drawn as a branch, not as one arm of a parallel
      // fan-out, because those are different things and the canvas was showing
      // them identically: several plain links out of a step all fire at once,
      // while conditional links are alternatives and only one is taken.
      const when = g.conditions[edgeKey(step.id, target)]
      const colour = when ? CONDITION_COLOUR[when] : isBack ? 'var(--warning, #e5a93e)' : 'var(--accent)'
      const loopLabel = isBack ? `loop ≤${maxVisitsOf(stepById(target) ?? { id: target })}` : undefined
      return {
        id: `e-${step.id}-${target}`,
        source: step.id,
        target,
        sourceHandle: isBack ? 'loop' : 'out',
        targetHandle: 'in',
        type: isBack ? 'smoothstep' : 'default',
        // A branch is not animated: animation reads as "this flows", and only
        // one of these will.
        animated: !isBack && !when,
        label: when ? (loopLabel ? `${CONDITION_LABEL[when]} · ${loopLabel}` : CONDITION_LABEL[when]) : loopLabel,
        labelStyle: { fill: colour, fontSize: '10px', fontWeight: when ? 600 : 400 },
        labelBgStyle: { fill: 'var(--surface, #fff)' },
        labelBgPadding: [4, 2] as [number, number],
        style: isBack
          ? { stroke: colour, strokeWidth: 1.5 }
          : when
            ? { stroke: colour, strokeWidth: 2 }
            : { strokeDasharray: '5 5', stroke: colour },
        markerEnd: { type: MarkerType.ArrowClosed, color: colour },
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
  if (readOnly.value || isRunning.value || !source || !target || source.startsWith('monitor:') || target.startsWith('monitor:')) return
  materializeEdges()
  workflowSteps.value = workflowSteps.value.map((s) => {
    if (s.id !== source) return s
    const next = s.next ?? []
    // Compare by target: an entry may be a bare id OR { to, when }, and
    // `includes` on the raw entry would never match a conditional one — so
    // dragging the same link twice would silently add a duplicate edge.
    return next.some(e => edgeTarget(e) === target) ? s : { ...s, next: [...next, target] }
  })
}

function onEdgeClick({ edge }: { edge: { id: string, source: string, target: string } }) {
  if (readOnly.value || isRunning.value || edge.id.startsWith('m-')) return
  materializeEdges()
  workflowSteps.value = workflowSteps.value.map((s) => {
    if (s.id !== edge.source) return s
    const next = s.next ?? []
    const current = next.find(e => edgeTarget(e) === edge.target)
    if (current === undefined) return s
    const when = typeof current === 'string' ? undefined : current.when
    const at = CONDITION_RING.indexOf(when)
    const nextWhen = CONDITION_RING[(at + 1) % (CONDITION_RING.length + 1)]
    // Past the end of the ring the edge is removed, which is where a click
    // used to land immediately.
    if (at === CONDITION_RING.length - 1) {
      return { ...s, next: next.filter(e => edgeTarget(e) !== edge.target) }
    }
    return {
      ...s,
      next: next.map(e => (edgeTarget(e) === edge.target
        ? (nextWhen ? { to: edge.target, when: nextWhen } : edge.target)
        : e)),
    }
  })
}

function onNodeDragStop({ node }: { node: { id: string, position: { x: number, y: number } } }) {
  if (readOnly.value || node.id.startsWith('monitor:')) return
  workflowSteps.value = workflowSteps.value.map(s =>
    s.id === node.id ? { ...s, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } } : s,
  )
}

function addStep(agentSlug: string, position?: { x: number, y: number }) {
  const agent = agentBySlug(agentSlug)
  if (!agent || readOnly.value || isRunning.value) return
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
  if (readOnly.value || isRunning.value) return
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
    const saved = await update(slug, {
      name: name.value,
      description: description.value,
      steps: workflowSteps.value,
      lastModified: lastModified.value ?? undefined,
    } as any)
    lastModified.value = (saved as any).lastModified ?? null
    workflow.value = saved as any
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

async function startRun(prompt: string, projectDir?: string, autoRun = false) {
  showRunModal.value = false
  if (!workflow.value) return
  await start(prompt, projectDir, autoRun)
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
          class="field-input t-body font-medium w-full max-w-xs"
          @blur="editingName = false"
          @keydown.enter="editingName = false"
        />
        <button
          v-else
          class="t-body font-medium truncate text-left"
          style="color: var(--text-primary);"
          @click="editingName = true"
        >
          {{ name || 'Untitled Workflow' }}
        </button>
      </div>

      <!-- Mobile: Add Agent button. `configure` like Save, because a step added
           by someone who cannot save is a step that quietly disappears on
           reload — a worse outcome than not offering it. -->
      <UButton
        v-if="can('configure')"
        class="md:hidden"
        label="Add Agent"
        icon="i-lucide-plus"
        size="xs"
        variant="soft"
        @click="() => { showMobileAgentPicker = true }"
      />

      <!-- Each of these maps to a route that already refuses the wrong role:
           Stop needs `runEngine`, Run needs `startRun`, Save and Delete need
           `configure`. They rendered for everyone regardless, so the only way to
           learn you could not use one was to press it and read the 403. -->
      <UButton
        v-if="(isRunning || isPaused) && can('runEngine')"
        label="Stop"
        icon="i-lucide-square"
        size="sm"
        color="error"
        variant="soft"
        @click="stop"
      />
      <UButton
        v-else-if="!isRunning && !isPaused && can('startRun')"
        label="Run"
        icon="i-lucide-play"
        size="sm"
        :disabled="!canRun"
        @click="() => { showRunModal = true }"
      />
      <UButton v-if="can('configure')" label="Save" icon="i-lucide-save" size="sm" variant="soft" :loading="saving" @click="save" />
      <UButton v-if="can('configure')" icon="i-lucide-trash-2" size="sm" variant="ghost" color="error" aria-label="Delete workflow" @click="deleteWorkflow" />
      <!-- Said out loud rather than left as an absence: a page with its controls
           quietly removed is indistinguishable from a broken one, and the
           pipeline definition is worth reading before answering a gate on it. -->
      <span v-if="!can('configure')" class="t-small text-label whitespace-nowrap">
        Read-only — changing a workflow is an operator's job.
      </span>
    </div>

    <!-- Description -->
    <div class="px-4 py-2 flex items-center gap-3" style="border-bottom: 1px solid var(--border-subtle);">
      <input
        v-if="editingDescription"
        v-model="description"
        class="field-input t-small w-full max-w-lg"
        placeholder="Workflow description..."
        @blur="editingDescription = false"
        @keydown.enter="editingDescription = false"
      />
      <button
        v-else
        class="t-small text-left flex-1 truncate"
        style="color: var(--text-tertiary);"
        @click="editingDescription = true"
      >
        {{ description || 'Click to add a description...' }}
      </button>
      <span
        v-if="parallelHint"
        class="t-small shrink-0"
        style="color: var(--text-disabled);"
        title="Each parallel branch works in its own git worktree, on its own branch cut from the run branch, merged back into it when the wave finishes. Two agents can write at once; a branch that conflicts with the run branch is reported rather than merged."
      >
        <UIcon name="i-lucide-git-branch" class="size-3 -mt-px" /> parallel branches get their own worktree
      </span>
    </div>

    <!-- Body: palette + canvas -->
    <div class="flex-1 flex min-h-0">
      <!-- Left palette (hidden on mobile) -->
      <div
        v-if="can('configure')"
        class="hidden md:flex flex-col w-[200px] shrink-0 overflow-hidden"
        style="border-right: 1px solid var(--border-subtle); background: var(--surface-raised);"
      >
        <div class="px-3 pt-3 pb-2">
          <div class="t-small font-medium mb-2" style="color: var(--text-secondary);">Your Agents</div>
          <input
            v-model="paletteSearch"
            placeholder="Filter..."
            aria-label="Filter agents"
            class="field-search w-full t-small"
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
            <span class="t-small truncate" style="color: var(--text-secondary);">
              {{ agent.frontmatter.name }}
            </span>
            <UIcon name="i-lucide-grip-vertical" class="size-3 ml-auto text-meta opacity-50" />
          </button>
          <div v-if="!filteredAgents.length" class="t-small text-center py-4 text-meta">
            No agents found
          </div>
        </div>
        <div class="px-3 py-2 t-small leading-relaxed" style="border-top: 1px solid var(--border-subtle); color: var(--text-tertiary);">
          Click or drag an agent to add a step. Drag a handle to link steps. Several plain links out of one step run in
          parallel; a link back to an earlier step loops. Click a link to make it conditional &mdash; <span style="color: var(--success, #2f855a);">on&nbsp;PASS</span>,
          <span style="color: var(--error, #c53030);">on&nbsp;FAIL</span>, otherwise &mdash; and once more to remove it. A step that
          states a verdict takes only the arm matching it, so a review can send work back instead of ending the run.
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
            :nodes-connectable="!isRunning && can('configure')"
            :nodes-draggable="!isRunning && can('configure')"
            @drop="onDrop"
            @dragover="onDragOver"
            @connect="onConnect"
            @edge-click="onEdgeClick"
            @node-drag-stop="onNodeDragStop"
          >
            <template #node-workflow="nodeProps">
              <WorkflowNode
                :data="nodeProps.data"
                :editable="!readOnly"
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
                  <div class="t-small font-medium truncate" style="color: var(--text-primary);">
                    {{ nodeProps.data.label }}
                  </div>
                  <div class="t-small" style="color: var(--text-disabled);">
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
              <p class="t-ui" style="color: var(--text-tertiary);">
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
          <span class="t-small font-medium" style="color: var(--success, #22c55e);">Workflow complete</span>
        </div>

      </div>
    </div>

    <!-- Run detail: live per-agent rows while a run is active, run history otherwise -->
    <USlideover v-model:open="showRunDetails" title="Run details">
      <template #body>
        <WorkflowRunPanel
          :run="run"
          :runs="runs"
          :logs="logs"
          @continue="(n) => continueRun(n)"
          @respond="respond"
          @reject="reject" @skip="skip"
          @rework="rework"
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
      @update:open="showRunModal = $event"
      @start="startRun"
    />

    <!-- Step settings -->
    <UModal :open="!!settingsStepId" :title="settingsStep?.label ?? 'Step settings'" description="Settings for this step: who owns it, what it runs, and whether it stops for a decision." @update:open="settingsStepId = $event ? settingsStepId : null">
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
    <UModal v-model:open="showMobileAgentPicker" title="Add agent"
      description="Pick an agent to add as a step in this workflow.">
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
              <span class="t-small" style="color: var(--text-secondary);">
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
