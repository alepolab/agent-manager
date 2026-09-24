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

const workflow = ref<Workflow | null>(null)
watch(() => props.run.workflowSlug, async (slug) => {
  try { workflow.value = await $fetch<Workflow>(`/api/workflows/${slug}`) }
  catch { workflow.value = null }
}, { immediate: true })

const layout = computed(() => stackForRun(workflow.value?.steps, props.run.steps.map(s => s.stepId)))
const stepById = computed(() => new Map(props.run.steps.map(s => [s.stepId, s])))
const wfById = computed(() => new Map((workflow.value?.steps ?? []).map(s => [s.id, s])))
const graph = computed(() => (workflow.value ? buildGraph(workflow.value.steps) : null))

function readsOf(id: string): string[] {
  const g = graph.value
  if (!g || !g.forwardPreds[id]) return []
  const ids = wfById.value.get(id)?.contextMode === 'ancestors' ? ancestorsOf(g, id) : g.forwardPreds[id]!
  return ids.map(p => stepById.value.get(p)?.label ?? p)
}

const openIds = ref(new Set<string>())
const toggle = (id: string) => {
  const next = new Set(openIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openIds.value = next
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
  gate: {
    respond: r => emit('respond', r),
    continue: n => emit('continue', n),
    reject: n => emit('reject', n),
    rework: (s, n) => emit('rework', s, n),
  },
  restart: (s, n) => emit('restart', s, n),
  openEvidence: () => { evidenceOpen.value = true },
})

/** `#step-<id>` opens that card and scrolls to it: the inbox links here. The gate's card opens by itself. */
const route = useRoute()
onMounted(async () => {
  const fromHash = route.hash.startsWith('#step-') ? route.hash.slice(6) : null
  const target = fromHash ?? props.run.question?.stepId
  if (!target) return
  if (props.run.question?.kind !== 'approval' || fromHash) toggle(target)
  await nextTick()
  document.getElementById(`step-${target}`)?.scrollIntoView({ block: 'center' })
})
</script>

<template>
  <div class="space-y-4">
    <RunHeader :run="run" @note="(t) => emit('note', t)" @continue="emit('continue')" @stop="emit('stop')" @clone="emit('clone')" />
    <p v-if="layout.note" class="t-small text-label">{{ layout.note }}</p>
    <!-- Waiting on a person with no step to hang the decision on: a batch review, or a step-by-step run paused between steps. -->
    <RunGate
      v-if="!run.question && (run.status === 'awaiting_review' || run.status === 'paused')" :run="run"
      @respond="(r) => emit('respond', r)" @continue="(n) => emit('continue', n)" @reject="(n) => emit('reject', n)" @rework="(s, n) => emit('rework', s, n)"
    />
    <div class="max-w-2xl mx-auto flex flex-col items-center">
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
