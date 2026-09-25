<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import type { Workflow } from '~/types'
import { buildGraph, ancestorsOf } from '~~/shared/utils/workflowGraph'
import { sendBackArrows, stackForRun, stepKind } from '~~/shared/utils/workflowStack'
import { RUN_STACK_KEY } from '~/utils/runStack'
import { isLiveStatus, isWaitingOnAPerson } from '~~/shared/types/run'

/**
 * A run as a vertical stack of its steps, laid out like its workflow: the
 * header, then every step as a card, parallel steps side by side, the open
 * decision inside the card that waits on it, and send-backs marked where they
 * landed. Same events as WorkflowRunPanel, so either can sit behind a run.
 */
const props = defineProps<{ run: WorkflowRun, logs?: Record<string, string[]> }>()
const emit = defineEmits<{
  continue: [note?: string], respond: [reply: string], reject: [note: string], rework: [stepId: string, note: string],
  note: [text: string], stop: [], restart: [stepId: string, note?: string], clone: [],
}>()

/**
 * 'loading' while the fetch is in flight (or has not started), 'missing' only
 * once the workflow route answers 404 (the workflow really is gone), 'loaded'
 * on success. A non-404 failure — a network blip, a 500 — leaves this at
 * 'loading' with `workflowLoadFailed` set, so it reads as neither "gone" nor
 * "fine": stackForRun(null, …) would otherwise report "The workflow no longer
 * exists", which is simply false while the request just hasn't come back yet.
 */
const workflowState = ref<'loading' | 'loaded' | 'missing'>('loading')
const workflowLoadFailed = ref(false)
const workflow = ref<Workflow | null>(null)
watch(() => props.run.workflowSlug, async (slug) => {
  workflowState.value = 'loading'
  workflowLoadFailed.value = false
  try {
    workflow.value = await $fetch<Workflow>(`/api/workflows/${slug}`)
    workflowState.value = 'loaded'
  } catch (err: any) {
    workflow.value = null
    if (err?.statusCode === 404 || err?.response?.status === 404) workflowState.value = 'missing'
    else workflowLoadFailed.value = true
  }
}, { immediate: true })

const layout = computed(() => stackForRun(workflow.value?.steps, props.run.steps.map(s => s.stepId)))
/** What the note actually says: suppressed while genuinely loading, a fetch-
 *  failure sentence for a transient error, and stackForRun's own note (which
 *  is already correct) for both 'missing' and 'loaded'. */
const workflowNote = computed(() => {
  if (workflowState.value === 'loading') {
    return workflowLoadFailed.value ? 'The workflow could not be loaded; steps are shown in run order.' : undefined
  }
  return layout.value.note
})
const stepById = computed(() => new Map(props.run.steps.map(s => [s.stepId, s])))
const wfById = computed(() => new Map((workflow.value?.steps ?? []).map(s => [s.id, s])))
const graph = computed(() => (workflow.value ? buildGraph(workflow.value.steps) : null))

function readsOf(id: string): string[] {
  const g = graph.value
  if (!g || !g.forwardPreds[id]) return []
  const ids = wfById.value.get(id)?.contextMode === 'ancestors' ? ancestorsOf(g, id) : g.forwardPreds[id]!
  return ids.map(p => stepById.value.get(p)?.label ?? p)
}

/**
 * Where this run's open decision is hosted, decided once here so it renders
 * exactly once no matter the combination of question kind, run status,
 * whether the gated step declares `approval: true`, or whether the workflow
 * has loaded at all.
 *
 * A runner-raised approval (budget reached, rework limit spent, too many
 * interruptions) sets `question.kind === 'approval'` on a step that usually
 * has no `approval: true` of its own — workflowRunner.ts raises these against
 * the step that would run next (or '' when there is none yet), not against a
 * step the workflow author gated. Those must NOT wait for the approval card,
 * which only exists for a step the workflow itself marks `approval: true`:
 * they fall through to the step's own card, or to the top level when the
 * question names no step in this run at all (including the empty stepId, and
 * including the case where the workflow hasn't loaded yet so `wfById` cannot
 * confirm the gated step's `approval` flag either way).
 */
type GateHost = { where: 'top' } | { where: 'approval' | 'card', stepId: string }
const gateHost = computed<GateHost | null>(() => {
  const q = props.run.question
  if (!q) return (props.run.status === 'awaiting_review' || props.run.status === 'paused') ? { where: 'top' } : null
  if (q.kind === 'approval' && wfById.value.get(q.stepId)?.approval) return { where: 'approval', stepId: q.stepId }
  if (stepById.value.has(q.stepId)) return { where: 'card', stepId: q.stepId }
  return { where: 'top' }
})
function gateAt(id: string): 'approval' | 'card' | null {
  const h = gateHost.value
  if (!h || h.where === 'top') return null
  return h.stepId === id ? h.where : null
}

const openIds = ref(new Set<string>())
const toggle = (id: string) => {
  const next = new Set(openIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openIds.value = next
}
/** Idempotent open, used to auto-open a target: calling it twice (once on
 *  mount, once again after the workflow load resolves) must not close it. */
function openStep(id: string) {
  if (openIds.value.has(id)) return
  openIds.value = new Set(openIds.value).add(id)
}

const arrows = computed(() => sendBackArrows(props.run).map((a, i) => ({ ...a, n: i + 1 })))

/** Child runs are only fetched when some step started any. */
const children = ref<WorkflowRun[]>([])
watch(() => props.run.steps.some(s => s.childRunIds?.length), async (has) => {
  if (!has) return
  try { children.value = await $fetch<WorkflowRun[]>('/api/runs') }
  catch { children.value = [] }
}, { immediate: true })
function childSummary(id: string): string {
  const ids = stepById.value.get(id)?.childRunIds ?? []
  const mine = children.value.filter(r => ids.includes(r.id))
  if (!mine.length) return `${ids.length} ${ids.length === 1 ? 'child run' : 'child runs'}`
  const done = mine.filter(r => r.status === 'completed').length
  const waiting = mine.filter(r => isWaitingOnAPerson(r.status)).length
  const failed = mine.filter(r => r.status === 'failed').length
  return [`${ids.length} children`, done && `${done} done`, waiting && `${waiting} waiting`, failed && `${failed} failed`].filter(Boolean).join(', ')
}

const evidenceOpen = ref(false)

provide(RUN_STACK_KEY, {
  run: toRef(props, 'run'),
  stepOf: id => stepById.value.get(id),
  workflowStepOf: id => wfById.value.get(id),
  kindOf: id => stepKind(wfById.value.get(id)),
  readsOf,
  logsOf: id => props.logs?.[id] ?? [],
  isOpen: id => openIds.value.has(id),
  toggle,
  arrivalsOf: id => arrows.value.filter(a => a.to === id),
  childSummary,
  gateAt,
  gate: {
    respond: r => emit('respond', r),
    continue: n => emit('continue', n),
    reject: n => emit('reject', n),
    rework: (s, n) => emit('rework', s, n),
  },
  restart: (s, n) => emit('restart', s, n),
  openEvidence: () => { evidenceOpen.value = true },
})

/**
 * `#step-<id>` opens that card and scrolls to it: the inbox links here. A
 * step whose card hosts the open gate opens itself too; the approval card
 * above a gated step is already visible without opening anything.
 *
 * Run once on mount (so a hash link works immediately) and once more the
 * first time the workflow finishes loading (`gateHost` cannot know an
 * approval-flagged step is the host until `wfById` exists, so a card that
 * should stay closed can briefly auto-open, or the real target can only be
 * found, once the fetch resolves). `openStep` is idempotent, so calling this
 * twice never re-closes a card the first pass already opened.
 */
const route = useRoute()
function scrollToStep(id: string) {
  document.getElementById(`step-${id}`)?.scrollIntoView({ block: 'center' })
}
async function focusTarget() {
  const fromHash = route.hash.startsWith('#step-') ? route.hash.slice(6) : null
  const h = gateHost.value
  const target = fromHash ?? (h && h.where !== 'top' ? h.stepId : undefined) ?? props.run.question?.stepId
  if (!target) return
  if (fromHash || gateHost.value?.where === 'card') openStep(target)
  await nextTick()
  scrollToStep(target)
}
onMounted(focusTarget)
watch(workflowState, (s) => { if (s === 'loaded') focusTarget() }, { once: true })
</script>

<template>
  <div class="space-y-4">
    <RunHeader :run="run" @note="(t) => emit('note', t)" @continue="emit('continue')" @stop="emit('stop')" @clone="emit('clone')" />
    <p v-if="workflowNote" class="t-small text-label">{{ workflowNote }}</p>
    <!-- Hosts a decision that has no step to hang on: a batch review, a step-by-step
         run paused between steps, or a question (often a runner-raised approval —
         budget, rework limit, too many interruptions) whose stepId names no step
         in this run, including while the workflow hasn't loaded yet. -->
    <RunGate
      v-if="gateHost?.where === 'top'" :run="run"
      @respond="(r) => emit('respond', r)" @continue="(n) => emit('continue', n)" @reject="(n) => emit('reject', n)" @rework="(s, n) => emit('rework', s, n)"
    />
    <div class="max-w-2xl mx-auto flex flex-col items-center">
      <div class="w-full flex justify-end mb-2">
        <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-folder-open" label="Evidence" @click="() => { evidenceOpen = true }" />
      </div>
      <div class="w-full rounded-lg px-3 py-2 t-small flex items-center gap-2" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <UIcon :name="run.watch && run.watch !== 'direct-invocation' ? 'i-lucide-radar' : 'i-lucide-play'" class="size-4 shrink-0" style="color: var(--warning);" />
        <span class="truncate">
          <span class="text-label">Started </span>
          <template v-if="run.ticketKey">from <span class="font-mono">{{ run.ticketKey }}</span></template>
          <template v-else>manually</template>
          <template v-if="run.startedBy"> by {{ run.startedBy }}</template>
          · {{ new Date(run.startedAt).toLocaleString() }}
        </span>
      </div>
      <div class="w-0.5 h-5" style="background: var(--border-default);" aria-hidden="true" />
      <RunStackBlocks :blocks="layout.blocks" />
    </div>
    <USlideover v-model:open="evidenceOpen" title="Evidence" :ui="{ content: 'max-w-3xl' }">
      <template #body><RunArtifacts :run-id="run.id" :live="isLiveStatus(run.status)" /></template>
    </USlideover>
  </div>
</template>
