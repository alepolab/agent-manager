<script setup lang="ts">
import type { StackBlock } from '~~/shared/utils/workflowStack'
import { RUN_STACK_KEY } from '~/utils/runStack'
import { REWORK_LIMIT } from '~~/shared/utils/runHistory'

/** Renders one level of the stack; paths render their branches with this same component. */
defineProps<{ blocks: StackBlock[] }>()
const ctx = inject(RUN_STACK_KEY)!
const run = ctx.run

/** A branch's condition is its first step's runWhen. */
function conditionOf(branch: StackBlock[]): string {
  const first = branch[0]
  if (!first) return 'Goes straight on'
  if (first.kind !== 'step') return 'Always'
  const when = ctx.workflowStepOf(first.stepId)?.runWhen?.artifact
  return when ? `If ${when} exists` : 'Always'
}
/** Whether THIS card hosts the open gate — decided once by RunStack (ctx.gateAt),
 *  not by re-deriving it here, so an approval-kind question on a step that
 *  isn't actually gated (a runner-raised budget/rework/interruption approval)
 *  does not also try to render inside this dashed approval card. The card
 *  itself still shows whenever the workflow step declares `approval: true`,
 *  regardless of whether it is hosting the live gate right now. */
const approvalHere = (id: string) => ctx.gateAt(id) === 'approval'
</script>

<template>
  <template v-for="(b, i) in blocks" :key="b.kind === 'step' ? b.stepId : `paths-${i}`">
    <div v-if="i > 0" class="w-0.5 h-5 mx-auto" style="background: var(--border-default);" aria-hidden="true" />

    <template v-if="b.kind === 'step'">
      <template v-if="ctx.workflowStepOf(b.stepId)?.approval">
        <section
          class="w-full rounded-lg px-3 py-2 space-y-2"
          :style="{ background: approvalHere(b.stepId) ? 'var(--accent-muted)' : 'var(--surface-raised)', border: `1px ${approvalHere(b.stepId) ? 'solid var(--waiting)' : 'dashed var(--border-default)'}` }"
          :aria-label="`Approval before ${ctx.stepOf(b.stepId)?.label}`"
        >
          <p class="t-small flex items-center gap-1.5" style="color: var(--text-secondary);">
            <UIcon name="i-lucide-hand" class="size-3.5" />
            Approval by {{ ctx.workflowStepOf(b.stepId)?.gateRole ?? 'anyone' }} · can send the work back to any earlier step, up to {{ REWORK_LIMIT }} times
          </p>
          <RunGate
            v-if="approvalHere(b.stepId)" :run="run"
            @respond="ctx.gate.respond" @continue="ctx.gate.continue" @reject="ctx.gate.reject" @rework="ctx.gate.rework"
          />
        </section>
        <div class="w-0.5 h-5 mx-auto" style="background: var(--border-default);" aria-hidden="true" />
      </template>
      <RunStackCard :step-id="b.stepId" />
    </template>

    <div
      v-else class="w-full grid gap-3 rounded-xl p-3 max-sm:!grid-cols-1"
      :style="{ gridTemplateColumns: `repeat(${b.branches.length}, minmax(0, 1fr))`, border: '1px dashed var(--border-default)' }"
      role="group" :aria-label="b.rejoin ? 'Paths that run in parallel and rejoin' : 'Paths that each end separately'"
    >
      <div v-for="(br, j) in b.branches" :key="j" class="flex flex-col items-stretch gap-1 min-w-0">
        <p class="t-small font-mono text-label truncate">{{ conditionOf(br) }}</p>
        <RunStackBlocks :blocks="br" />
      </div>
    </div>
  </template>
</template>
