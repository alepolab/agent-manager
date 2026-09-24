<script setup lang="ts">
import { isLiveStatus } from '~~/shared/types/run'
import { RUN_STATUS_COLOR as STATUS_COLOR } from '~/utils/runStatus'
import { RUN_STACK_KEY, STEP_KIND_ICON, STEP_KIND_LABEL } from '~/utils/runStack'

/** One step of a run. Collapsed: what it is and how it went. Expanded: what it read, made, was told and said. */
const props = defineProps<{ stepId: string }>()
const ctx = inject(RUN_STACK_KEY)!
const { can } = useUser()
const mayDrive = computed(() => can('runEngine'))

const step = computed(() => ctx.stepOf(props.stepId)!)
const wf = computed(() => ctx.workflowStepOf(props.stepId))
const kind = computed(() => ctx.kindOf(props.stepId))
const open = computed(() => ctx.isOpen(props.stepId))
const run = ctx.run
const settledRun = computed(() => !isLiveStatus(run.value.status))
const settled = computed(() => ['completed', 'failed', 'skipped'].includes(step.value.status))
/** This card hosts any open decision RunStack routed here (ctx.gateAt) —
 *  an ordinary question, or a runner-raised approval (budget, rework limit,
 *  too many interruptions) that has no approval card of its own to render in.
 *  A workflow-authored approval gate renders in the approval card above this
 *  one (RunStackBlocks) instead, whenever the gated step declares `approval:
 *  true` — so the two never both claim the same open decision. */
const askingHere = computed(() => ctx.gateAt(props.stepId) === 'card')

const elapsed = computed(() => {
  const s = step.value
  if (!s.startedAt) return ''
  const secs = Math.round(((s.completedAt ?? Date.now()) - s.startedAt) / 1000)
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
})
const tokens = computed(() => {
  const u = step.value.usage
  return u ? (u.input_tokens + u.output_tokens).toLocaleString() : ''
})
const usd = computed(() => (step.value.usage?.usd != null ? `$${step.value.usage.usd.toFixed(2)}` : ''))
const logs = computed(() => ctx.logsOf(props.stepId))
const latest = computed(() => logs.value.at(-1)?.slice(9) ?? '')
const arrivals = computed(() => ctx.arrivalsOf(props.stepId))

/** Replay asks for an optional instruction before it restarts anything. */
const replaying = ref(false)
const replayNote = ref('')
function replay() {
  ctx.restart(props.stepId, replayNote.value.trim() || undefined)
  replaying.value = false
  replayNote.value = ''
}
</script>

<template>
  <div class="w-full space-y-1">
    <p
      v-for="a in arrivals" :key="`${a.at}-${a.n}`"
      class="t-small flex items-center gap-1" style="color: var(--warning);" :data-sendback-to="stepId"
    >
      <UIcon name="i-lucide-corner-left-up" class="size-3.5 shrink-0" />
      Sent back here ({{ a.n }}) by {{ a.by.startsWith('agent:') ? a.by.slice(6) : a.by }} from {{ ctx.stepOf(a.from)?.label ?? a.from }}<template v-if="a.note">: {{ a.note }}</template>
    </p>
    <article
      :id="`step-${stepId}`" :data-step="stepId"
      class="w-full rounded-lg overflow-hidden"
      :style="{
        background: 'var(--surface-raised)',
        border: `1px solid ${step.status === 'running' ? STATUS_COLOR.running : 'var(--border-subtle)'}`,
        opacity: step.status === 'pending' || step.status === 'skipped' ? 0.7 : 1,
      }"
    >
      <button
        class="w-full grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-left focus-ring"
        :aria-expanded="open" @click="ctx.toggle(stepId)"
      >
        <span class="w-2.5 h-2.5 rounded-full" :class="{ 'animate-pulse': step.status === 'running' }" :style="{ background: STATUS_COLOR[step.status] }" role="img" :aria-label="step.status" :title="step.status" />
        <span class="min-w-0">
          <span class="flex items-center gap-2">
            <span class="t-ui font-medium truncate" style="color: var(--text-primary);">{{ step.label }}</span>
            <span v-if="step.visits > 1" class="t-small text-label" :title="`This step ran ${step.visits} times`">×{{ step.visits }}</span>
            <span
              v-if="step.monitorVerdict && step.monitorVerdict !== 'CONTINUE'" class="t-small font-mono"
              :style="{ color: step.monitorVerdict === 'ABORT' ? STATUS_COLOR.failed : 'var(--warning)' }"
            >{{ step.monitorVerdict }}</span>
          </span>
          <span class="flex items-center gap-1.5 t-small text-label truncate">
            <UIcon :name="STEP_KIND_ICON[kind]" class="size-3.5 shrink-0" />
            {{ STEP_KIND_LABEL[kind] }}<template v-if="kind === 'agent'"> · {{ step.agentSlug }}</template>
            <template v-if="wf?.monitorSlug"> · Check</template>
            <template v-if="step.status === 'skipped' && step.skipReason"> · skipped: {{ step.skipReason }}</template>
            <template v-if="step.childRunIds?.length"> · <span data-testid="child-run-count">{{ ctx.childSummary(stepId) }}</span></template>
          </span>
        </span>
        <span class="t-small font-mono text-label tabular-nums text-right whitespace-nowrap">
          {{ elapsed }}<template v-if="tokens"><br>{{ tokens }} tok{{ usd ? ` · ${usd}` : '' }}</template>
        </span>
      </button>
      <div v-if="step.status === 'running' && latest && !open" class="px-3 pb-2 t-small font-mono truncate text-label" :title="latest">{{ latest }}</div>

      <div v-if="open" class="px-3 pb-3 pt-2 space-y-3" style="border-top: 1px solid var(--border-subtle);">
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <p class="t-label text-label mb-1">Reads</p>
            <p v-if="!ctx.readsOf(stepId).length" class="t-small text-label">The run's prompt and inputs</p>
            <ul class="space-y-0.5"><li v-for="r in ctx.readsOf(stepId)" :key="r" class="t-small font-mono">{{ r }}</li></ul>
          </div>
          <div>
            <p class="t-label text-label mb-1">Produces</p>
            <p v-if="!wf?.produces?.length" class="t-small text-label">No declared files</p>
            <ul class="space-y-0.5"><li v-for="f in wf?.produces ?? []" :key="f" class="t-small font-mono">{{ f }}</li></ul>
          </div>
        </div>

        <div v-if="step.checks?.length" class="space-y-1">
          <p class="t-label text-label">Checks</p>
          <details v-for="c in step.checks" :key="c.at" class="t-small rounded p-2" style="background: var(--surface-base);">
            <summary class="cursor-pointer focus-ring">
              Visit {{ c.visit }} ·
              <span class="font-mono" :style="{ color: c.verdict === 'CONTINUE' ? STATUS_COLOR.completed : c.verdict === 'ABORT' ? STATUS_COLOR.failed : 'var(--warning)' }">{{ c.verdict }}</span>
            </summary>
            <pre class="whitespace-pre-wrap mt-1 max-h-48 overflow-auto">{{ c.note }}</pre>
          </details>
        </div>

        <p v-if="step.error" class="t-small" :style="{ color: STATUS_COLOR.failed }">{{ step.error }}</p>

        <div v-if="step.childRunIds?.length" class="space-y-0.5" data-testid="child-runs">
          <p class="t-small text-label">The runs this step started<template v-if="step.status === 'waiting'">, which it is waiting for</template></p>
          <NuxtLink :to="`/runs?parent=${run.id}`" class="t-small underline focus-ring">See all {{ step.childRunIds.length }} in Runs</NuxtLink>
        </div>

        <div v-if="logs.length" class="max-h-72 overflow-auto rounded p-2" style="background: var(--surface-base); border: 1px solid var(--border-subtle);"><LogLines :lines="logs" /></div>
        <pre v-else-if="step.output" class="t-small whitespace-pre-wrap max-h-64 overflow-auto">{{ step.output }}</pre>
        <p v-else class="t-small text-label">No output yet.</p>

        <div class="flex flex-wrap gap-2">
          <UButton v-if="mayDrive && settledRun && settled && !replaying" size="xs" variant="soft" icon="i-lucide-rotate-ccw" label="Replay from here" @click="() => { replaying = true }" />
          <UButton v-if="mayDrive && step.sessionId && step.sessionProject" size="xs" variant="soft" icon="i-lucide-message-circle" label="Ask this agent" :to="`/cli/project/${step.sessionProject}/session/${step.sessionId}`" />
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-folder-open" label="Evidence" @click="ctx.openEvidence()" />
        </div>
        <div v-if="replaying" class="space-y-2">
          <textarea v-model="replayNote" rows="2" class="field-input w-full resize-none t-small" placeholder="Optional instruction for this step, e.g. verify from inside the container only" aria-label="Instruction for the replayed step" />
          <div class="flex gap-2">
            <UButton size="xs" icon="i-lucide-rotate-ccw" :label="`Replay from ${step.label}`" @click="replay" />
            <UButton size="xs" variant="ghost" color="neutral" label="Cancel" @click="() => { replaying = false }" />
          </div>
        </div>
      </div>

      <div v-if="askingHere" class="px-3 pb-3">
        <RunGate :run="run" @respond="ctx.gate.respond" @continue="ctx.gate.continue" @reject="ctx.gate.reject" @rework="ctx.gate.rework" />
      </div>
    </article>
  </div>
</template>
