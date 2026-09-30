<script setup lang="ts">
import { HOLD } from '~~/shared/types/workflowGroup'
import type { WorkflowRun, CostAggregate } from '~~/shared/types/run'
import { RUN_STATUS_COLOR } from '~/utils/runStatus'
import { runElapsedMs } from '~~/shared/utils/runClock'
import { humanWaitMs } from '~~/shared/utils/runDecisions'

/**
 * Where the pipeline is stuck, how often work comes back, and what it costs —
 * the top of the dashboard, and the whole of it for a manager.
 *
 * It was the /board page, and shared every run with the dashboard's queue under
 * a second fetch of /api/runs. The runs come from the dashboard now, which
 * renders this only once they have loaded: a board that renders zeros when the
 * API is down reports a healthy quiet pipeline, the opposite of the truth.
 *
 * Read-only by construction. This issues no POST, which is what makes it honest
 * to offer to a role defined as "Changes nothing".
 */
const props = defineProps<{
  runs: WorkflowRun[]
  /** The gate list repeats the dashboard's queue, so it shows only to someone who has no queue. */
  showGates?: boolean
}>()
const runs = computed(() => props.runs)
const cost = ref<CostAggregate | null>(null)

async function refreshCost() {
  try { cost.value = await $fetch<CostAggregate>('/api/runs/cost') } catch { cost.value = null }
}
// Spend moves when runs do; the dashboard's poll is what moves them.
watch(runs, refreshCost, { immediate: true })

const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })

const fmt = (ms: number) => {
  const m = Math.round(ms / 60000)
  if (m < 1) return '<1m'
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Runs stopped at a gate right now, longest wait first: the queue that is costing time. */
const waiting = computed(() => runs.value
  .filter(r => r.status === 'paused' && r.question)
  .map(r => ({ run: r, waited: Math.max(0, now.value - (r.question?.askedAt ?? now.value)) }))
  .sort((a, b) => b.waited - a.waited))

/**
 * Hours the pipeline spent waiting on people, against hours it spent executing.
 *
 * The comparison is the point: agent time is what the system costs, human time
 * is what it waits for, and only one of them is visible anywhere else.
 */
const humanMs = computed(() => runs.value.reduce((s, r) => s + humanWaitMs(r), 0))
const agentMs = computed(() => runs.value.reduce((s, r) => s + runElapsedMs(r, now.value), 0))

/** Every decision anyone has taken at a gate, newest first. */
const decisions = computed(() => runs.value
  .flatMap(r => (r.decisions ?? []).map(d => ({ ...d, runId: r.id, ticket: r.ticketKey ?? r.workflowName })))
  .sort((a, b) => b.at - a.at))

const reworked = computed(() => runs.value.filter(r => (r.reworks ?? 0) > 0))
const atCap = computed(() => runs.value.filter(r => (r.reworks ?? 0) >= 2))

const settled = computed(() => runs.value.filter(r => r.endedAt))
const outcomes = computed(() => {
  const by: Record<string, number> = {}
  for (const r of runs.value) by[r.status] = (by[r.status] ?? 0) + 1
  return Object.entries(by).sort((a, b) => b[1] - a[1])
})

/**
 * The runs behind one outcome count, listed under it. In the URL, so a
 * filtered dashboard can be sent to someone or survive a reload.
 */
const route = useRoute()
const router = useRouter()
const outcome = computed({
  get: () => (typeof route.query.outcome === 'string' ? route.query.outcome : ''),
  set: v => router.replace({ query: { ...route.query, outcome: v || undefined } }),
})
const OUTCOME_LIMIT = 50
const outcomeRuns = computed(() => runs.value.filter(r => r.status === outcome.value).sort((a, b) => b.startedAt - a.startedAt))
/** One line on where a run stands: why it failed, what it waits on, or the step it is at. */
function whereItIs(r: WorkflowRun): string {
  const label = (id?: string) => r.steps.find(s => s.stepId === id)?.label
  if (r.status === 'failed') return r.error || `Failed at ${r.steps.find(s => s.status === 'failed')?.label ?? 'a step'}`
  // Before the question: a decision already taken waits for a slot, and the question it answered is history.
  if (r.status === 'queued') return r.parked?.gaveWayTo === HOLD ? 'Paused: its group is on hold' : r.parked?.gaveWayTo ? `Stepped aside while ${r.parked.gaveWayTo} runs` : r.parked ? `Decided; waiting for a slot to ${r.parked.action}` : 'Waiting for a slot'
  if (r.question) return `${label(r.question.stepId) ?? 'A step'}: ${r.question.text.split('\n')[0]}`
  const at = label(r.currentStepIds[0]) ?? r.steps.find(s => s.status === 'running')?.label
  if (at) return `At ${at}`
  const done = r.steps.filter(s => s.status === 'completed').length
  return `${done} of ${r.steps.length} steps done`
}

/**
 * Decisions only exist from the moment they started being recorded. Runs that
 * settled before that carry none, so every figure derived from them describes
 * the runs that have them and no others — said on the page rather than left for
 * a reader to discover by disbelieving a zero.
 */
const withDecisions = computed(() => runs.value.filter(r => (r.decisions?.length ?? 0) > 0).length)
</script>

<template>
  <div class="space-y-6">
    <!-- The four numbers a manager acts on. -->
    <section class="grid gap-3" style="grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));">
      <div class="rounded-xl px-4 py-3" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <div class="t-small font-mono uppercase tracking-wider text-label">Waiting on a person</div>
        <div class="t-title font-medium tabular-nums" :style="{ color: waiting.length ? RUN_STATUS_COLOR.paused : 'var(--text-primary)' }">{{ waiting.length }}</div>
        <div class="t-small text-label">{{ waiting.length ? `longest ${fmt(waiting[0]!.waited)}` : 'no gate is open' }}</div>
      </div>
      <div class="rounded-xl px-4 py-3" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <div class="t-small font-mono uppercase tracking-wider text-label">Human time vs agent time</div>
        <div class="t-title font-medium tabular-nums">{{ fmt(humanMs) }}<span class="t-ui text-label"> / {{ fmt(agentMs) }}</span></div>
        <div class="t-small text-label">waiting for people / executing</div>
      </div>
      <div class="rounded-xl px-4 py-3" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <div class="t-small font-mono uppercase tracking-wider text-label">Sent back</div>
        <div class="t-title font-medium tabular-nums">{{ reworked.length }}<span class="t-ui text-label"> / {{ runs.length }}</span></div>
        <div class="t-small text-label">{{ atCap.length }} at the limit of 2</div>
      </div>
      <div class="rounded-xl px-4 py-3" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <div class="t-small font-mono uppercase tracking-wider text-label">Spend</div>
        <div class="t-title font-medium tabular-nums">{{ cost ? `$${cost.totals.cost_usd.toFixed(2)}` : '—' }}</div>
        <!-- A cost board that hides its own partiality is the fabrication
             costReport.ts exists to prevent. -->
        <div class="t-small text-label">
          <template v-if="cost && !cost.totals.complete">partial: {{ cost.totals.unmeasured_step_count }} unmeasured, {{ cost.totals.unpriced_step_count }} unpriced</template>
          <template v-else-if="cost">{{ cost.run_count }} runs, complete</template>
          <template v-else>usage unavailable</template>
        </div>
      </div>
    </section>

    <!-- What is stuck, and for how long. -->
    <section v-if="showGates">
      <h2 class="text-section-label mb-2">Stopped at a gate <span class="text-meta font-normal">{{ waiting.length }}</span></h2>
      <p v-if="!waiting.length" class="t-ui text-label">Nothing is waiting on a person.</p>
      <div v-else class="space-y-1">
        <NuxtLink
          v-for="w in waiting" :key="w.run.id" :to="`/runs/${w.run.id}`"
          class="grid grid-cols-[minmax(0,1fr)_10rem_6rem] items-center gap-3 rounded-lg px-3 py-2 t-small focus-ring"
          style="background: var(--surface-raised); border: 1px solid var(--border-subtle);"
        >
          <span class="truncate" style="color: var(--text-primary);">{{ w.run.ticketKey || (w.run.initialPrompt.split('\n')[0] ?? '') }}</span>
          <span class="text-label truncate">{{ w.run.steps.find(s => s.stepId === w.run.question?.stepId)?.label ?? 'a step' }}</span>
          <span class="text-right tabular-nums" :style="{ color: RUN_STATUS_COLOR.paused }">{{ fmt(w.waited) }}</span>
        </NuxtLink>
      </div>
    </section>

    <!-- Who decided what. -->
    <section>
      <h2 class="text-section-label mb-2">Decisions <span class="text-meta font-normal">{{ decisions.length }}</span></h2>
      <p v-if="!decisions.length" class="t-ui text-label">
        No gate decisions recorded yet. Decisions are kept from the moment a gate is answered; runs that settled before this was recorded carry none.
      </p>
      <div v-else class="space-y-1">
        <p class="t-small text-label">From {{ withDecisions }} of {{ runs.length }} runs — the rest settled before decisions were recorded.</p>
        <NuxtLink
          v-for="d in decisions.slice(0, 20)" :key="`${d.runId}-${d.at}`" :to="`/runs/${d.runId}`"
          class="grid grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_5rem_7rem] items-center gap-3 rounded-lg px-3 py-2 t-small focus-ring"
          style="background: var(--surface-raised); border: 1px solid var(--border-subtle);"
        >
          <span
            class="font-mono uppercase t-small truncate"
            :style="{ color: d.verdict === 'approved' ? RUN_STATUS_COLOR.completed : d.verdict === 'rejected' ? RUN_STATUS_COLOR.failed : RUN_STATUS_COLOR.paused }"
          >{{ d.verdict }}</span>
          <span class="truncate" style="color: var(--text-primary);">{{ d.label }}</span>
          <span class="text-label truncate" :title="d.note || ''">{{ d.note || '—' }}</span>
          <span class="text-label text-right tabular-nums" :title="`Waited ${fmt(d.waitedMs)} for a person`">{{ fmt(d.waitedMs) }}</span>
          <span class="text-label truncate text-right">{{ d.by }}</span>
        </NuxtLink>
      </div>
    </section>

    <section>
      <h2 class="text-section-label mb-2">Outcomes</h2>
      <div class="flex flex-wrap gap-3 t-small">
        <button
          v-for="[status, n] in outcomes" :key="status" type="button"
          class="rounded-lg px-3 py-1.5 focus-ring cursor-pointer"
          :style="{ background: 'var(--surface-raised)', border: `1px solid ${outcome === status ? RUN_STATUS_COLOR[status] : 'var(--border-subtle)'}` }"
          :aria-pressed="outcome === status" :title="outcome === status ? 'Hide these runs' : `Show the ${n} ${status} run(s)`"
          @click="outcome = outcome === status ? '' : status"
        >
          <span class="font-mono uppercase t-small" :style="{ color: RUN_STATUS_COLOR[status] }">{{ status }}</span>
          <span class="ml-2 tabular-nums">{{ n }}</span>
        </button>
        <span v-if="!runs.length" class="text-label">No runs yet.</span>
      </div>
      <p v-if="settled.length" class="t-small text-label mt-2">{{ settled.length }} settled of {{ runs.length }}.</p>

      <div v-if="outcome" class="mt-3 space-y-1">
        <p v-if="!outcomeRuns.length" class="t-ui text-label">No {{ outcome }} runs now.</p>
        <NuxtLink
          v-for="r in outcomeRuns.slice(0, OUTCOME_LIMIT)" :key="r.id" :to="`/runs/${r.id}`"
          class="grid grid-cols-[8rem_minmax(0,1fr)_minmax(0,1.5fr)_7rem] items-center gap-3 rounded-lg px-3 py-2 t-small focus-ring"
          style="background: var(--surface-raised); border: 1px solid var(--border-subtle);"
        >
          <span class="truncate font-medium" style="color: var(--text-primary);">{{ r.ticketKey || r.workflowName }}</span>
          <span class="text-label truncate" :title="r.workflowName">{{ r.workflowName }}</span>
          <span class="text-label truncate" :title="whereItIs(r)">{{ whereItIs(r) }}</span>
          <span class="text-label text-right tabular-nums" :title="new Date(r.startedAt).toLocaleString()">{{ new Date(r.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }} {{ new Date(r.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }}</span>
        </NuxtLink>
        <NuxtLink :to="`/runs?status=${outcome}`" class="t-small underline text-label inline-block mt-1">
          {{ outcomeRuns.length > OUTCOME_LIMIT ? `All ${outcomeRuns.length} in Runs` : 'Open in Runs' }}
        </NuxtLink>
      </div>
    </section>
  </div>
</template>
