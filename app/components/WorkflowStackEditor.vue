<script setup lang="ts">
import type { WorkflowStep } from '~/types'
import type { StackBlock } from '~~/shared/utils/workflowStack'
import * as E from '~~/shared/utils/stackEdit'
import { BUILD_STACK_KEY, type PickerChoice, type Selection } from '~/utils/buildStack'

/**
 * The workflow as an editable stack: the trigger card, then every step, with a
 * "+" between cards. Owns the edits (shared/utils/stackEdit.ts) and hands the
 * results back through v-model; the page decides when to save.
 */
const props = defineProps<{
  blocks: StackBlock[]
  steps: WorkflowStep[]
  selected: Selection
  readOnly: boolean
  agents: { slug: string, name: string }[]
  triggerSummary: string
}>()
const emit = defineEmits<{
  'update:blocks': [StackBlock[]]
  'update:steps': [WorkflowStep[]]
  'update:selected': [Selection]
}>()
const toast = useToast()

const stepById = computed(() => new Map(props.steps.map(s => [s.id, s])))

/** Run an edit; a refusal is told to the person and changes nothing. */
function edit(fn: () => void) {
  try { fn() }
  catch (err) { toast.add({ title: 'Can’t do that here', description: err instanceof Error ? err.message : String(err), color: 'warning' }) }
}
const setBlocks = (b: StackBlock[]) => emit('update:blocks', b)
const patchStep = (id: string, patch: Partial<WorkflowStep>) =>
  emit('update:steps', props.steps.map(s => (s.id === id ? { ...s, ...patch } : s)))

function apply(choice: PickerChoice, slot: E.Slot) {
  edit(() => {
    if (choice.kind === 'split') return setBlocks(E.splitAt(props.blocks, slot))
    if (choice.kind === 'approval') {
      const below = E.seqAt(props.blocks, slot.seq)[slot.index]
      if (!below || below.kind !== 'step') throw new Error('An approval goes above a step. Add the step first.')
      return patchStep(below.stepId, { approval: true })
    }
    const s = E.newStep(choice.action, { agentSlug: choice.agentSlug }) as WorkflowStep
    const blocks = E.insertStep(props.blocks, slot, s.id)
    emit('update:steps', [...props.steps, s])
    setBlocks(blocks)
    emit('update:selected', { kind: 'step', stepId: s.id })
  })
}

provide(BUILD_STACK_KEY, {
  readOnly: toRef(props, 'readOnly'),
  stepOf: id => stepById.value.get(id),
  agentName: slug => props.agents.find(a => a.slug === slug)?.name ?? slug,
  agents: toRef(props, 'agents'),
  isSelected: id => props.selected?.kind === 'step' && props.selected.stepId === id,
  select: id => emit('update:selected', { kind: 'step', stepId: id }),
  apply,
  remove: id => edit(() => {
    setBlocks(E.removeStep(props.blocks, id))
    emit('update:steps', props.steps.filter(s => s.id !== id))
    if (props.selected?.kind === 'step' && props.selected.stepId === id) emit('update:selected', null)
  }),
  move: (seq, from, to) => edit(() => setBlocks(E.moveWithin(props.blocks, seq, from, to))),
  addBranch: at => edit(() => setBlocks(E.addBranch(props.blocks, at))),
  removeBranch: (at, branch) => edit(() => setBlocks(E.removeBranch(props.blocks, at, branch))),
  setRejoin: (at, rejoin) => edit(() => setBlocks(E.setRejoin(props.blocks, at, rejoin))),
  setCondition: (id, artifact) => patchStep(id, { runWhen: artifact.trim() ? { artifact: artifact.trim() } : undefined }),
  clearApproval: id => patchStep(id, { approval: undefined, gateRole: undefined }),
})
</script>

<template>
  <div class="max-w-2xl mx-auto flex flex-col items-center">
    <button
      class="w-full rounded-lg px-3 py-2 t-small flex items-center gap-2 text-left focus-ring"
      :style="{ background: 'var(--surface-raised)', border: `1px solid ${selected?.kind === 'trigger' ? 'var(--accent)' : 'var(--border-subtle)'}` }"
      data-testid="trigger-card" @click="emit('update:selected', { kind: 'trigger' })"
    >
      <UIcon name="i-lucide-radar" class="size-4 shrink-0" style="color: var(--warning);" />
      <span class="min-w-0">
        <span class="block t-label text-label">Trigger</span>
        <span class="block truncate" style="color: var(--text-primary);">{{ triggerSummary }}</span>
      </span>
    </button>
    <div class="w-0.5 h-3" style="background: var(--border-default);" aria-hidden="true" />
    <BuildStackBlocks :blocks="blocks" :seq="[]" />
    <p v-if="!blocks.length && readOnly" class="t-small text-label mt-2">No steps yet.</p>
  </div>
</template>
