<script setup lang="ts">
import type { StackBlock } from '~~/shared/utils/workflowStack'
import type { SeqPath } from '~~/shared/utils/stackEdit'
import { BUILD_STACK_KEY } from '~/utils/buildStack'

/**
 * One sequence of the builder's stack. A "+" sits before every block and after
 * the last; steps can be dragged among their siblings; paths show each branch's
 * condition, the rejoin toggle, and add/remove branch.
 */
const props = defineProps<{ blocks: StackBlock[], seq: SeqPath }>()
const ctx = inject(BUILD_STACK_KEY)!
const nested = computed(() => props.seq.length > 0)
const endsOpen = computed(() => { const l = props.blocks.at(-1); return l?.kind === 'paths' && !l.rejoin })
const firstStepOf = (branch: StackBlock[]) => (branch[0]?.kind === 'step' ? branch[0].stepId : null)
const seqKey = JSON.stringify(props.seq)

let dragFrom: number | null = null
function onDragStart(e: DragEvent, i: number) { dragFrom = i; e.dataTransfer?.setData('text/x-stack-seq', seqKey) }
function onDrop(e: DragEvent, to: number) {
  if (dragFrom === null || e.dataTransfer?.getData('text/x-stack-seq') !== seqKey) return
  const from = dragFrom
  dragFrom = null
  if (from !== to) ctx.move(props.seq, from, to)
}
</script>

<template>
  <template v-for="(b, i) in blocks" :key="b.kind === 'step' ? b.stepId : `paths-${i}`">
    <div v-if="!ctx.readOnly.value" class="flex flex-col items-center">
      <ActionPicker :agents="ctx.agents.value" :allow-split="!nested" :allow-approval="b.kind === 'step' && !ctx.stepOf(b.stepId)?.approval" @choose="(c) => ctx.apply(c, { seq, index: i })" />
      <div class="w-0.5 h-3" style="background: var(--border-default);" aria-hidden="true" />
    </div>
    <div v-else-if="i > 0" class="w-0.5 h-5 mx-auto" style="background: var(--border-default);" aria-hidden="true" />

    <div
      v-if="b.kind === 'step'" class="w-full space-y-1"
      :draggable="!ctx.readOnly.value" @dragstart="(e) => onDragStart(e, i)" @dragover.prevent @drop="(e) => onDrop(e, i)"
    >
      <section
        v-if="ctx.stepOf(b.stepId)?.approval"
        class="w-full rounded-lg px-3 py-2 flex items-center gap-2 t-small"
        style="background: var(--surface-raised); border: 1px dashed var(--border-default); color: var(--text-secondary);"
      >
        <UIcon name="i-lucide-hand" class="size-3.5" />
        <span class="flex-1">Approval by {{ ctx.stepOf(b.stepId)?.gateRole ?? 'anyone' }} · can send the work back to any earlier step, up to 2 times</span>
        <UButton v-if="!ctx.readOnly.value" size="xs" variant="ghost" color="neutral" icon="i-lucide-x" aria-label="Remove this approval" @click="ctx.clearApproval(b.stepId)" />
      </section>
      <BuildStackCard :step-id="b.stepId" />
    </div>

    <div
      v-else class="w-full rounded-xl p-3 space-y-2" style="border: 1px dashed var(--border-default);"
      role="group" :aria-label="b.rejoin ? 'Paths that run in parallel and rejoin' : 'Paths that each end separately'"
    >
      <div class="grid gap-3 max-sm:!grid-cols-1" :style="{ gridTemplateColumns: `repeat(${b.branches.length}, minmax(0, 1fr))` }">
        <div v-for="(br, j) in b.branches" :key="j" class="flex flex-col items-stretch gap-1 min-w-0">
          <div class="flex items-center gap-1">
            <input
              v-if="firstStepOf(br) && !ctx.readOnly.value"
              class="field-input t-small font-mono flex-1 min-w-0" :value="ctx.stepOf(firstStepOf(br)!)?.runWhen?.artifact ?? ''"
              placeholder="Always (or: runs if this file exists)" :aria-label="`Condition for path ${j + 1}`"
              @change="(e) => ctx.setCondition(firstStepOf(br)!, (e.target as HTMLInputElement).value)"
            >
            <p v-else class="t-small font-mono text-label truncate flex-1">{{ firstStepOf(br) ? (ctx.stepOf(firstStepOf(br)!)?.runWhen?.artifact ? `If ${ctx.stepOf(firstStepOf(br)!)?.runWhen?.artifact} exists` : 'Always') : 'Goes straight on' }}</p>
            <UButton v-if="!ctx.readOnly.value" size="xs" variant="ghost" color="neutral" icon="i-lucide-x" :aria-label="`Remove path ${j + 1}`" @click="ctx.removeBranch({ seq, index: i }, j)" />
          </div>
          <BuildStackBlocks :blocks="br" :seq="[...seq, { block: i, branch: j }]" />
        </div>
      </div>
      <div v-if="!ctx.readOnly.value" class="flex flex-wrap items-center gap-3 t-small">
        <UButton size="xs" variant="soft" icon="i-lucide-plus" label="Add path" @click="ctx.addBranch({ seq, index: i })" />
        <label class="flex items-center gap-1.5"><input type="checkbox" :checked="b.rejoin" @change="(e) => ctx.setRejoin({ seq, index: i }, (e.target as HTMLInputElement).checked)"> Rejoin after paths</label>
      </div>
    </div>
  </template>

  <div v-if="!ctx.readOnly.value && !endsOpen" class="flex flex-col items-center">
    <ActionPicker :agents="ctx.agents.value" :allow-split="!nested" :allow-approval="false" @choose="(c) => ctx.apply(c, { seq, index: blocks.length })" />
  </div>
</template>
