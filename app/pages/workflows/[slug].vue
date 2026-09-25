<script setup lang="ts">
import type { Workflow, WorkflowStep, WorkflowParameter } from '~/types'
import { buildGraph } from '~~/shared/utils/workflowGraph'
import { toStack, type StackBlock } from '~~/shared/utils/workflowStack'
import { canSave } from '~~/shared/utils/stackEdit'
import { triggerSummary, type Selection } from '~/utils/buildStack'
import { producesError } from '~/utils/produces'
import { isLiveStatus } from '~~/shared/types/run'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const slug = route.params.slug as string
const { fetchOne, update, remove } = useWorkflows()
const { agents } = useAgents()
// This page had no role awareness at all. It is reachable by URL, and Clone on
// the runs page used to land every role here - so a manager, whose role is
// "Reads progress across runs. Changes nothing", was shown Save and Delete
// workflow. The routes behind them already refuse it; the page did not.
const { can } = useUser()
/**
 * Hiding a button is a courtesy to the person; it is not a control on the edit.
 *
 * Every edit on this page goes through the stack editor and the drawers, and
 * some need no obvious button: dragging a card moves a step. So the guard is
 * `editable`, handed to each of them as read-only, not the markup alone. The
 * server refuses the Save that would persist any of it, so the damage was never
 * permanent - but a page that silently discards your edits on reload is a worse
 * answer than one that does not accept them.
 */
const readOnly = computed(() => !can('configure'))
const workflowRun = useWorkflowRun(slug)
const { run, runs, logs, attach, refresh: refreshRun, start } = workflowRun
const { onReject, onRework, onNote, onRestart, onStop, onContinue, onRespond } = useRunActionToasts(workflowRun)
// The PAGE fetches, not the drawer: the trigger card's summary carries the count,
// so it is needed before the drawer mounts.
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
    mode.value = 'run'
  }
  if (typeof q.clone === 'string') {
    const src = runs.value.find(r => r.id === q.clone)
    runInitial.value = src ? { prompt: src.initialPrompt, projectDir: src.projectDir, autoRun: src.autoRun, parameters: src.parameters } : undefined
    showRunModal.value = true
    mode.value = 'run'
  }
  if (q.start === '1') { runInitial.value = undefined; showRunModal.value = true }
  // `tab` is carried through rather than stripped with the intents: it is a
  // link target, not a one-shot, so ?run=X&tab=schedule must not lose the tab
  // when the intent is consumed.
  if (q.run || q.clone || q.start) router.replace({ path: route.path, query: q.tab ? { tab: q.tab } : {} })
}
function cloneRun() {
  if (!run.value) return
  runInitial.value = { prompt: run.value.initialPrompt, projectDir: run.value.projectDir, autoRun: run.value.autoRun, parameters: run.value.parameters }
  showRunModal.value = true
}

// Per-step status is read off the server-owned run. These say what state it is in,
// which decides whether a new run may start, whether the stack is editable, and
// whether the page opens on the run.
const isRunning = computed(() => run.value?.status === 'running')
/** Running, or joining its children: both go through rehydrate while live, so
 *  a restart rebuilds from the file and a save now would change what it runs. */
const editLocked = computed(() => run.value?.status === 'running' || run.value?.status === 'joining')
/** Anything not yet over, queued included: the page opens on such a run. */
const isLive = computed(() => !!run.value && isLiveStatus(run.value.status))
const isPaused = computed(() => run.value?.status === 'paused')
/** Stopped on a person who has entries to decide about. Like paused for every
 *  purpose on this page: no second run may start, and the run controls stay
 *  up. */
const isReviewing = computed(() => run.value?.status === 'awaiting_review')
/** Admitted but waiting for a slot in its concurrency group. Distinct from
 *  running: the stack is still editable (launchQueuedRun re-reads the
 *  definition, so an edit made while it waits is the one that runs), but
 *  nothing may start a second run of this workflow. */
const isQueued = computed(() => run.value?.status === 'queued')

/** Show a run already in `runs` (the newest, when Run mode opens with none) - no stream needed. */
function attachRun(id: string) {
  const found = runs.value.find(r => r.id === id)
  if (found) run.value = found
}

/** Run mode shows the current run; with none open yet, the newest one. */
function showRunMode() {
  if (!run.value && runs.value[0]) attachRun(runs.value[0].id)
  mode.value = 'run'
}

const workflow = ref<Workflow | null>(null)
const workflowSteps = ref<WorkflowStep[]>([])
/** The workflow's declared inputs. Edited here, collected by the run modal,
 *  and stated to every step by the runner. */
const workflowParameters = ref<WorkflowParameter[]>([])
const name = ref('')
const description = ref('')

const blocks = ref<StackBlock[]>([])
/** Why the stack can't show this workflow, when it can't: the page is then read-only. */
const notDrawable = ref<string | null>(null)
const selected = ref<Selection>(null)
const drawerTab = ref<'triggers' | 'inputs' | 'settings'>('triggers')
const mode = ref<'build' | 'run'>('build')
/** Not while a run is working (running or joining): a restart rebuilds from
 *  the file, so a save mid-run would change what the restart runs. Queued is
 *  fine - it re-reads the definition when it launches. */
const editable = computed(() => !readOnly.value && !notDrawable.value && !editLocked.value)
/** Editable but for the run, so the page says why rather than going quiet. */
const pausedByRun = computed(() => !readOnly.value && !notDrawable.value && editLocked.value)
/** The stack as last loaded or saved. A move or a split changes the blocks
 *  before it changes any step, so the steps alone cannot say it is unsaved. */
const savedBlocks = ref('[]')

/** Called from applyWorkflow after the steps are set. */
function layOut() {
  const r = toStack(workflowSteps.value)
  if (r.ok) { blocks.value = r.blocks; notDrawable.value = null }
  else { blocks.value = workflowSteps.value.map(s => ({ kind: 'step' as const, stepId: s.id })); notDrawable.value = r.reason }
}

// Steps are moved by a drag and deleted in two clicks; leaving discards both silently without this.
const isDirty = computed(() => !!workflow.value && JSON.stringify({ n: name.value, d: description.value, s: workflowSteps.value, b: JSON.stringify(blocks.value) }) !== JSON.stringify({ n: workflow.value.name, d: workflow.value.description, s: workflow.value.steps, b: savedBlocks.value }))
// useUnsavedChanges(anyDirty) is called below, once the refs it reads exist.
/** The concurrency group this workflow's runs count against. '' is ungrouped,
 *  which means the default group - and is sent as '' rather than omitted,
 *  because the PUT route is a shallow merge and an absent key would keep
 *  whatever was stored. */
const group = ref('')
/** Where this workflow's run transitions are announced. '' means the channel
 *  called `default`, then SLACK_WEBHOOK_URL - sent as '' rather than omitted
 *  because the PUT is a shallow merge. */
const notifyChannel = ref('')
const groups = ref<{ id: string, name: string, maxConcurrent: number, inFlight: number, waiting: number, implicit: boolean }[]>([])
const saving = ref(false)
const lastModified = ref<number | null>(null)
const showRunModal = ref(false)
/**
 * Seeded once at setup, before any await, the way explore.vue does it - and
 * never written back on click. A query param the page both reads and writes
 * can interleave with applyQueryIntent()'s replace on first paint and either
 * lose an intent or resurrect a consumed one. A link sets the tab; a click
 * does not need the URL to know.
 */
if (route.query.tab === 'schedule' || route.query.tab === 'inputs') {
  selected.value = { kind: 'trigger' }
  drawerTab.value = route.query.tab === 'inputs' ? 'inputs' : 'triggers'
}
/** The declaration as the server has it. The Inputs editor mutates
 *  workflowParameters; a schedule is validated against THIS, so the two are
 *  tracked separately and the difference is what warns the Schedule tab. */
const savedParameters = ref<WorkflowParameter[]>([])
const editingName = ref(false)
const editingDescription = ref(false)
useHead({ title: computed(() => `${name.value || 'Workflow'} | Agent Manager`) })

function applyWorkflow(data: Workflow) {
  workflow.value = data
  lastModified.value = (data as any).lastModified ?? null
  workflowSteps.value = [...data.steps]
  workflowParameters.value = [...(data.parameters ?? [])]
  savedParameters.value = [...(data.parameters ?? [])]
  name.value = data.name
  description.value = data.description
  group.value = data.group ?? ''
  notifyChannel.value = data.notifyChannel ?? ''
  layOut()
  savedBlocks.value = JSON.stringify(blocks.value)
  // A reload can drop the step the drawer was showing.
  const sel = selected.value
  if (sel?.kind === 'step' && !data.steps.some(s => s.id === sel.stepId)) selected.value = null
}

// Load workflow
onMounted(async () => {
  try {
    applyWorkflow(await fetchOne(slug))
    groups.value = await $fetch<typeof groups.value>('/api/workflow-groups').catch(() => [])
  } catch {
    toast.add({ title: 'Workflow not found', color: 'error' })
    router.push('/workflows')
  }
  // Attach to whatever the server is already running for this workflow, if anything -
  // a run outlives this tab, so a reload must not lose it. Then honour any
  // one-shot intent in the URL, which may point at a finished run instead.
  await attach()
  // A live run opens on the run, unless the URL names a tab (?tab=schedule|inputs
  // opens the trigger drawer, which lives in Build mode).
  if (isLive.value && !route.query.tab) mode.value = 'run'
  applyQueryIntent()
  // Fire-and-forget: the tab label's count can arrive a moment later, and
  // nothing above it should wait on a schedule read.
  void fetchSchedules()
})

const parametersDirty = computed(() =>
  JSON.stringify(workflowParameters.value.filter(p => p.name.trim())) !== JSON.stringify(savedParameters.value))

/** Everything unsaved, not just the stack.
 *
 *  isDirty covers name, description and steps. It was also what guarded the
 *  page against being left, so editing only an input, the concurrency group or
 *  the notify channel and navigating away discarded it with no prompt - while
 *  useExternalChange, given the full check, knew perfectly well they were
 *  dirty. One computed now feeds both, so they cannot disagree again. */
const anyDirty = computed(() => isDirty.value || parametersDirty.value
  || group.value !== (workflow.value?.group ?? '')
  || notifyChannel.value !== (workflow.value?.notifyChannel ?? ''))
useUnsavedChanges(anyDirty)

const workflowContent = (w: Workflow) => ({
  name: w.name, description: w.description, steps: w.steps,
  parameters: w.parameters ?? [], group: w.group ?? '', notifyChannel: w.notifyChannel ?? '',
})
// The same full check the leave guard uses: a background reload must not drop
// edits to inputs, group or channel either.
const { pending: externalPending, ...external } = useExternalChange({
  fetch: () => fetchOne(slug),
  baseline: () => workflow.value && workflowContent(workflow.value),
  content: workflowContent,
  isDirty: () => anyDirty.value,
  apply: applyWorkflow,
  paused: () => !workflow.value || saving.value,
})
function keepMine() {
  // Adopting their timestamp is what lets the next save overwrite instead of failing with 409.
  const theirs = external.keepMine()
  if (theirs) lastModified.value = (theirs as any).lastModified ?? null
}
useAutoRefresh(() => Promise.all([refreshRun(), fetchSchedules({ silent: true })]))

const graph = computed(() => buildGraph(workflowSteps.value))

// Agent descriptions run to whole paragraphs here - clip them or the picker is unreadable.
const summarise = (text?: string) => {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine
}
const agentChoices = computed(() => agents.value.map(a => ({ slug: a.slug, name: a.frontmatter.name || a.slug, description: summarise(a.frontmatter.description) })))
/** The inputs a dispatch step may fan out over: declared ones, named. */
const parameterNames = computed(() => workflowParameters.value.filter(p => p.name.trim()).map(p => p.name))

const { watches, fetchAll: fetchWatches } = useWatches()
onMounted(() => { void fetchWatches().catch(() => {}) })
const trigger = computed(() => triggerSummary(scheduleRows.value, watches.value.filter(w => w.workflowSlug === slug)))

const selectedStep = computed(() => {
  const s = selected.value
  return s?.kind === 'step' ? workflowSteps.value.find(x => x.id === s.stepId) : undefined
})
function patchSelected(patch: Partial<WorkflowStep>) {
  const id = selectedStep.value?.id
  if (!id) return
  workflowSteps.value = workflowSteps.value.map(s => (s.id === id ? { ...s, ...patch } : s))
}
function openInputs() {
  selected.value = { kind: 'trigger' }
  drawerTab.value = 'inputs'
  mode.value = 'build'
}

/** Below lg the drawer is a bottom sheet rather than a column. Read from the
 *  viewport, not rendered twice, so one drawer instance holds its own state. */
const wide = ref(true)
onMounted(() => {
  const mq = window.matchMedia('(min-width: 64rem)')
  wide.value = mq.matches
  const onChange = (e: MediaQueryListEvent) => { wide.value = e.matches }
  mq.addEventListener('change', onChange)
  onScopeDispose(() => mq.removeEventListener('change', onChange))
})
const sheetTitle = computed(() => selected.value?.kind === 'trigger' ? 'Trigger' : (selectedStep.value?.label || 'Step'))

/** The channels this instance has configured, for the notify step's picker. A
 *  dropdown rather than a text box on purpose: a mistyped channel name is a
 *  notification that silently never arrives. */
const channels = ref<{ name: string, kind: string, host?: string }[]>([])
onMounted(async () => {
  try {
    channels.value = (await $fetch<{ channels: typeof channels.value }>('/api/channels')).channels
  } catch {
    channels.value = []
  }
})

async function save() {
  if (!editable.value) return
  if (!workflow.value) return
  const r = canSave(blocks.value, workflowSteps.value)
  if (!r.ok) { toast.add({ title: 'This can’t be saved yet', description: r.reason, color: 'warning' }); return }
  // Refused rather than saved-and-warned: the runner reads this list as files it
  // must find, so a name that can never resolve is a step that always fails, and
  // the first sign of it is a run sent back after it has already spent budget.
  const bad = r.steps.find(s => producesError(s.produces ?? []))
  if (bad) { toast.add({ title: `Fix the files list on ${bad.label}`, description: producesError(bad.produces ?? [])!, color: 'warning' }); return }
  workflowSteps.value = r.steps
  saving.value = true
  try {
    const saved = await update(slug, {
      name: name.value,
      description: description.value,
      steps: r.steps,
      parameters: workflowParameters.value.filter(p => p.name.trim()),
      group: group.value,
      notifyChannel: notifyChannel.value,
      lastModified: lastModified.value ?? undefined,
    } as any)
    lastModified.value = (saved as any).lastModified ?? null
    workflow.value = saved as any
    // The baseline a schedule is checked against moves with the save, which is
    // what clears the Schedule tab's unsaved-inputs warning.
    savedParameters.value = workflowParameters.value.filter(p => p.name.trim())
    // The layout follows the file: what reloads is what is shown now.
    layOut()
    savedBlocks.value = JSON.stringify(blocks.value)
    toast.add({ title: 'Workflow saved', color: 'success' })
  } catch (e: any) {
    if (e?.statusCode === 409 || e?.data?.statusCode === 409) toast.add({ title: 'Changed by someone else', description: (e.data?.message || 'Reload to see the latest version before saving again.') + (e.data?.data?.lastModified ? ` Last saved ${new Date(e.data.data.lastModified).toLocaleTimeString()}.` : ''), color: 'warning' })
    else toast.add({ title: 'Failed to save', description: e.data?.message || e.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

async function deleteWorkflow() {
  // Deleting a workflow cascades to nothing, so its schedules survive it and
  // keep showing a next fire time while every fire errors - a failure nobody
  // sees until a night has passed. Named here because the count is already on
  // this page. Degrades to the plain question if the fetch has not landed.
  const n = scheduleRows.value.length
  const question = n
    ? `Delete this workflow? ${n} schedule${n === 1 ? '' : 's'} point at it and will start failing.`
    : 'Delete this workflow?'
  if (!confirm(question)) return
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
  mode.value = 'run'
  try {
    await update(slug, { lastRunAt: new Date().toISOString() } as any)
  } catch {
    // Non-critical
  }
}

const canRun = computed(() => workflowSteps.value.length > 0 && !isRunning.value && !isPaused.value && !isReviewing.value && !isQueued.value)

const parallelHint = computed(() => graph.value.entries.length > 1
  || workflowSteps.value.some(s => (graph.value.succ[s.id] ?? []).length > 1))
</script>

<template>
  <div class="flex flex-col h-full min-w-0">
    <!-- Top bar -->
    <div
      class="min-h-14 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 shrink-0 sticky top-0 z-10"
      style="border-bottom: 1px solid var(--border-subtle); background: var(--surface-base);"
    >
      <NuxtLink to="/workflows" class="p-1.5 rounded-lg hover-bg focus-ring" aria-label="Back to workflows">
        <UIcon name="i-lucide-arrow-left" class="size-4 text-meta" />
      </NuxtLink>

      <!-- Editable name -->
      <div class="flex-1 min-w-0 basis-32">
        <input
          v-if="editingName && editable"
          v-model="name"
          class="field-input t-body font-medium w-full max-w-xs"
          @blur="editingName = false"
          @keydown.enter="editingName = false"
        />
        <button
          v-else-if="editable"
          class="t-body font-medium truncate text-left max-w-full"
          style="color: var(--text-primary);"
          @click="editingName = true"
        >
          {{ name || 'Untitled Workflow' }}
        </button>
        <span v-else data-testid="workflow-name" class="block t-body font-medium truncate" style="color: var(--text-primary);">
          {{ name || 'Untitled Workflow' }}
        </span>
      </div>

      <!-- Build | Run: the definition, or what a run of it did. -->
      <div class="flex items-center gap-2">
        <div role="tablist" aria-label="Builder mode" class="flex rounded-lg p-0.5" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
          <button
            role="tab"
            data-testid="mode-build"
            :aria-selected="mode === 'build'"
            class="t-small px-2.5 py-1 rounded-md focus-ring"
            :style="mode === 'build' ? 'background: var(--surface-base); color: var(--text-primary);' : 'color: var(--text-tertiary);'"
            @click="mode = 'build'"
          >
            Build
          </button>
          <button
            role="tab"
            data-testid="mode-run"
            :aria-selected="mode === 'run'"
            :disabled="!runs.length"
            class="t-small px-2.5 py-1 rounded-md focus-ring font-mono disabled:opacity-50"
            :style="mode === 'run' ? 'background: var(--surface-base); color: var(--text-primary);' : 'color: var(--text-tertiary);'"
            @click="showRunMode"
          >
            {{ run ? `Run #${run.id.slice(0, 6)}` : 'Run' }}
          </button>
        </div>
        <select
          v-if="mode === 'run' && runs.length > 1"
          :value="run?.id ?? ''"
          class="field-input t-small max-w-[11rem]"
          aria-label="Recent runs"
          @change="attachRun(($event.target as HTMLSelectElement).value)"
        >
          <option v-if="!run" value="" disabled>Choose a run…</option>
          <option v-for="r in runs" :key="r.id" :value="r.id">
            #{{ r.id.slice(0, 6) }} · {{ r.status }} · {{ r.startedAt ? new Date(r.startedAt).toLocaleString() : 'not started' }}
          </option>
        </select>
      </div>

      <!-- Each of these maps to a route that already refuses the wrong role:
           Run needs `startRun`, Save and Delete need `configure`. They rendered
           for everyone regardless, so the only way to learn you could not use
           one was to press it and read the 403. -->
      <div class="flex items-center gap-2">
        <UButton
          :label="workflowParameters.length ? `Inputs (${workflowParameters.length})` : 'Inputs'"
          icon="i-lucide-sliders-horizontal"
          size="sm"
          variant="ghost"
          color="neutral"
          @click="() => { openInputs() }"
        />
        <UButton
          v-if="can('startRun')"
          label="Run"
          icon="i-lucide-play"
          size="sm"
          :disabled="!canRun"
          @click="() => { showRunModal = true }"
        />
        <!-- Disabled rather than hidden while a run works, so the button does not
             jump when the run ends. -->
        <UButton v-if="editable || pausedByRun" label="Save" icon="i-lucide-save" size="sm" variant="soft" :loading="saving" :disabled="!editable || !anyDirty" @click="save" />
        <UButton v-if="can('configure')" icon="i-lucide-trash-2" size="sm" variant="ghost" color="error" aria-label="Delete workflow" @click="deleteWorkflow" />
        <!-- Said out loud rather than left as an absence: a page with its controls
             quietly removed is indistinguishable from a broken one, and the
             pipeline definition is worth reading before answering a gate on it. -->
        <span v-if="!can('configure')" class="t-small text-label">
          Read-only - changing a workflow is an operator's job.
        </span>
      </div>
    </div>

    <!-- Description -->
    <div class="px-4 py-2 flex items-center gap-3 min-w-0" style="border-bottom: 1px solid var(--border-subtle);">
      <input
        v-if="editingDescription && editable"
        v-model="description"
        class="field-input t-small w-full max-w-lg"
        placeholder="Workflow description..."
        @blur="editingDescription = false"
        @keydown.enter="editingDescription = false"
      />
      <button
        v-else-if="editable"
        class="t-small text-left flex-1 truncate min-w-0"
        style="color: var(--text-tertiary);"
        @click="editingDescription = true"
      >
        {{ description || 'Click to add a description...' }}
      </button>
      <span v-else class="t-small flex-1 truncate min-w-0" style="color: var(--text-tertiary);">
        {{ description }}
      </span>
      <span
        v-if="parallelHint"
        class="t-small shrink-0 hidden sm:inline"
        style="color: var(--text-disabled);"
        title="Parallel branches share one project folder. Safe for agents that read and analyse; risky for two agents writing the same files."
      >
        <UIcon name="i-lucide-git-branch" class="size-3 -mt-px" /> parallel branches share one folder
      </span>
    </div>

    <p v-if="pausedByRun" data-testid="editing-paused" class="px-4 py-1.5 t-small" style="color: var(--text-tertiary); border-bottom: 1px solid var(--border-subtle);">
      Editing is paused while a run is in progress.
    </p>

    <ExternalChangeBanner v-if="externalPending" class="mx-4 my-2" @reload="external.reload" @keep="keepMine" />
    <div
      v-if="notDrawable"
      data-testid="not-drawable"
      class="mx-4 my-2 rounded-xl px-4 py-3 flex items-start gap-3 t-small"
      style="background: var(--surface-raised); border: 1px solid var(--warning);"
    >
      <UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0 mt-0.5" style="color: var(--warning);" />
      <span style="color: var(--text-secondary);">
        This workflow's shape can't be shown as a stack, so it opens read-only. {{ notDrawable }}
      </span>
    </div>

    <!-- Build: the stack, and the drawer for whatever is selected in it. -->
    <div
      v-if="mode === 'build'"
      class="flex-1 min-h-0 overflow-y-auto grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start"
    >
      <WorkflowStackEditor
        v-model:blocks="blocks"
        v-model:steps="workflowSteps"
        v-model:selected="selected"
        class="w-full min-w-0"
        :read-only="!editable"
        :agents="agentChoices"
        :trigger-summary="trigger"
      />
      <aside
        v-if="wide"
        data-testid="drawer-column"
        class="hidden lg:block rounded-xl p-4 lg:sticky lg:top-0 max-h-full overflow-y-auto"
        style="background: var(--surface-raised); border: 1px solid var(--border-subtle);"
      >
        <TriggerDrawer
          v-if="selected?.kind === 'trigger'"
          v-model:tab="drawerTab"
          v-model:parameters="workflowParameters"
          v-model:group="group"
          v-model:notify-channel="notifyChannel"
          :workflow-slug="slug"
          :workflow-name="name"
          :saved-parameters="savedParameters"
          :schedulable="workflowSteps.length > 0"
          :groups="groups"
          :channels="channels"
          :read-only="!editable"
        />
        <StepDrawer
          v-else-if="selectedStep"
          :key="selectedStep.id"
          :step="selectedStep"
          :agents="agentChoices"
          :channels="channels"
          :parameter-names="parameterNames"
          :read-only="!editable"
          @patch="patchSelected"
        />
        <p v-else class="t-small text-label">Select the trigger or a step to change it.</p>
      </aside>
    </div>

    <!-- Run: the current run as its own stack. -->
    <div v-else class="flex-1 min-h-0 overflow-y-auto p-4 min-w-0">
      <RunStack
        v-if="run"
        :run="run"
        :logs="logs"
        @continue="onContinue"
        @respond="onRespond"
        @reject="onReject"
        @rework="onRework"
        @note="onNote"
        @stop="onStop"
        @restart="onRestart"
        @clone="cloneRun"
      />
      <p v-else class="t-small text-label">No run is open. Start one with Run, or pick one above.</p>
    </div>

    <!-- Below lg: the same drawer as a bottom sheet. -->
    <USlideover
      v-if="!wide"
      side="bottom"
      :title="sheetTitle"
      :open="mode === 'build' && !!selected"
      @update:open="(v: boolean) => { if (!v) selected = null }"
    >
      <template #body>
        <TriggerDrawer
          v-if="selected?.kind === 'trigger'"
          v-model:tab="drawerTab"
          v-model:parameters="workflowParameters"
          v-model:group="group"
          v-model:notify-channel="notifyChannel"
          :workflow-slug="slug"
          :workflow-name="name"
          :saved-parameters="savedParameters"
          :schedulable="workflowSteps.length > 0"
          :groups="groups"
          :channels="channels"
          :read-only="!editable"
        />
        <StepDrawer
          v-else-if="selectedStep"
          :key="selectedStep.id"
          :step="selectedStep"
          :agents="agentChoices"
          :channels="channels"
          :parameter-names="parameterNames"
          :read-only="!editable"
          @patch="patchSelected"
        />
        <p v-else class="t-small text-label">Select the trigger or a step to change it.</p>
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
  </div>
</template>
