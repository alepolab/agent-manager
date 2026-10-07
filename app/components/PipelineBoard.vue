<script setup lang="ts">
import { HOLD } from '~~/shared/types/workflowGroup'
import type { WorkflowRun, CostAggregate } from '~~/shared/types/run'
import { GATE_VERDICT, statusWord } from '~/utils/runStatus'
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

/**
 * Outcomes as one bar in a fixed order — finished, working, waiting, broken,
 * stopped, not started — so the same status sits in the same place on every
 * visit. Six chips in six colours sorted by count moved every time a number did.
 */
const OUTCOME_ORDER = ['completed', 'running', 'joining', 'paused', 'awaiting_review', 'failed', 'interrupted', 'stopped', 'queued']
const OUTCOME_FILL: Record<string, string> = {
  completed: 'var(--success)', running: 'var(--accent)', joining: 'var(--accent)',
  paused: 'var(--waiting)', awaiting_review: 'var(--waiting)',
  failed: 'var(--error)', interrupted: 'var(--error)',
  stopped: 'var(--text-disabled)', queued: 'transparent',
}
const outcomes = computed(() => {
  const by: Record<string, number> = {}
  for (const r of runs.value) by[r.status] = (by[r.status] ?? 0) + 1
  const rank = (k: string) => { const i = OUTCOME_ORDER.indexOf(k); return i < 0 ? OUTCOME_ORDER.length : i }
  return Object.entries(by).sort((a, b) => rank(a[0]) - rank(b[0]))
})

/** Two statuses read "Stopped" to a person; in a legend side by side they need telling apart. */
const outcomeWord = (s: string) => (s === 'interrupted' ? 'Server restart' : statusWord(s))

const VERDICT = GATE_VERDICT

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
  if (r.status === 'queued') return r.parked?.gaveWayTo === HOLD ? 'Paused: its group is on hold' : r.parked?.gaveWayTo ? `Stepped aside while ${r.parked.gaveWayTo} runs` : r.parked ? `Decided; waiting for a slot to ${r.parked.handOver ? 'send back' : r.parked.action}` : 'Waiting for a slot'
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
  <div class="space-y-7">
    <!-- The four numbers a manager acts on, in one row. They were four hero
         cards with a 22px figure over a tracked-caps eyebrow, which made them
         the loudest thing on a page whose job is the queue under them. -->
    <section class="stat-row" aria-label="This pipeline">
      <div class="stat-row__cell">
        <div class="stat-row__key">Waiting on a person</div>
        <div class="stat-row__value" :style="{ color: waiting.length ? 'var(--waiting)' : undefined }">{{ waiting.length }}</div>
        <div class="stat-row__note">{{ waiting.length ? `longest ${fmt(waiting[0]!.waited)}` : 'no gate is open' }}</div>
      </div>
      <div class="stat-row__cell">
        <div class="stat-row__key">Human time vs agent time</div>
        <div class="stat-row__value">{{ fmt(humanMs) }} <small>/ {{ fmt(agentMs) }}</small></div>
        <div class="stat-row__note">waiting for people / executing</div>
      </div>
      <div class="stat-row__cell">
        <div class="stat-row__key">Sent back</div>
        <div class="stat-row__value">{{ reworked.length }} <small>of {{ runs.length }}</small></div>
        <div class="stat-row__note">{{ atCap.length }} at the limit of 2</div>
      </div>
      <div class="stat-row__cell">
        <div class="stat-row__key">Spend</div>
        <div class="stat-row__value">{{ cost ? `$${cost.totals.cost_usd.toFixed(2)}` : '—' }}</div>
        <!-- A cost board that hides its own partiality is the fabrication
             costReport.ts exists to prevent. -->
        <div class="stat-row__note">
          <template v-if="cost && !cost.totals.complete">partial: {{ cost.totals.unmeasured_step_count }} unmeasured, {{ cost.totals.unpriced_step_count }} unpriced</template>
          <template v-else-if="cost">{{ cost.run_count }} runs, complete</template>
          <template v-else>usage unavailable</template>
        </div>
      </div>
    </section>

    <section>
      <div class="group-head"><h2>Outcomes</h2><span class="group-head__count">{{ runs.length }} runs<template v-if="settled.length">, {{ settled.length }} settled</template></span></div>
      <p v-if="!runs.length" class="t-ui text-label">No runs yet.</p>
      <template v-else>
        <div class="meter" role="img" :aria-label="outcomes.map(([s, n]) => `${outcomeWord(s)} ${n}`).join(', ')">
          <span v-for="[status, n] in outcomes" :key="status" :style="{ flex: n, background: OUTCOME_FILL[status] ?? 'var(--text-disabled)' }" />
        </div>
        <!-- Each count opens the runs behind it, listed under the bar. -->
        <div class="meter-legend">
          <button
            v-for="[status, n] in outcomes" :key="status" type="button"
            class="meter-legend__item focus-ring" :class="{ 'meter-legend__item--on': outcome === status }"
            :aria-pressed="outcome === status" :title="outcome === status ? 'Hide these runs' : `Show the ${n} ${outcomeWord(status).toLowerCase()} run(s)`"
            @click="outcome = outcome === status ? '' : status"
          >
            <i :style="{ background: OUTCOME_FILL[status] ?? 'var(--text-disabled)', boxShadow: OUTCOME_FILL[status] === 'transparent' ? 'inset 0 0 0 1px var(--border-emphasis)' : undefined }" />{{ outcomeWord(status) }} <b>{{ n }}</b>
          </button>
        </div>
        <div v-if="outcome" class="mt-3">
          <p v-if="!outcomeRuns.length" class="t-ui text-label">No {{ outcomeWord(outcome).toLowerCase() }} runs now.</p>
          <div v-else class="inset-list">
            <NuxtLink v-for="r in outcomeRuns.slice(0, OUTCOME_LIMIT)" :key="r.id" :to="`/runs/${r.id}`" class="inset-row focus-ring">
              <span class="inset-row__lead"><StatusLabel :status="r.status" icon-only /></span>
              <span class="inset-row__body">
                <span class="inset-row__title" :class="{ 'font-mono': r.ticketKey }">{{ r.ticketKey || r.workflowName }}</span>
                <span class="inset-row__sub" :title="whereItIs(r)">{{ r.workflowName }} · {{ whereItIs(r) }}</span>
              </span>
              <span class="inset-row__end" :title="new Date(r.startedAt).toLocaleString()">{{ new Date(r.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }} {{ new Date(r.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }}</span>
            </NuxtLink>
          </div>
          <NuxtLink :to="`/runs?status=${outcome}`" class="t-small underline underline-offset-2 text-label inline-block mt-2">
            {{ outcomeRuns.length > OUTCOME_LIMIT ? `All ${outcomeRuns.length} in Runs` : 'Open in Runs' }}
          </NuxtLink>
        </div>
      </template>
    </section>

    <!-- What is stuck, and for how long. -->
    <section v-if="showGates">
      <div class="group-head"><h2>Stopped at a gate</h2><span class="group-head__count">{{ waiting.length }}</span></div>
      <p v-if="!waiting.length" class="t-ui text-label">Nothing is waiting on a person.</p>
      <div v-else class="inset-list">
        <NuxtLink v-for="w in waiting" :key="w.run.id" :to="`/runs/${w.run.id}`" class="inset-row focus-ring">
          <span class="inset-row__lead"><StatusLabel status="paused" icon-only /></span>
          <span class="inset-row__body">
            <span class="inset-row__title">{{ w.run.ticketKey || (w.run.initialPrompt.split('\n')[0] ?? '') }}</span>
            <span class="inset-row__sub">{{ w.run.steps.find(s => s.stepId === w.run.question?.stepId)?.label ?? 'a step' }}</span>
          </span>
          <span class="inset-row__end" style="color: var(--waiting); font-weight: 600;">{{ fmt(w.waited) }}</span>
        </NuxtLink>
      </div>
    </section>

    <!-- Who decided what. History, not a queue: open for a manager, whose
         whole page this is, and folded for everyone else, above whom it used
         to sit as a wall of identical APPROVED rows. -->
    <details class="group-details" :open="showGates">
      <summary class="group-head cursor-pointer focus-ring">
        <h2>Decisions</h2><span class="group-head__count">{{ decisions.length }}</span>
        <span v-if="decisions.length" class="t-small text-label">from {{ withDecisions }} of {{ runs.length }} runs; the rest settled before decisions were recorded</span>
      </summary>
      <p v-if="!decisions.length" class="t-ui text-label">
        No gate decisions recorded yet. Decisions are kept from the moment a gate is answered; runs that settled before this was recorded carry none.
      </p>
      <div v-else class="inset-list">
        <NuxtLink
          v-for="d in decisions.slice(0, 20)" :key="`${d.runId}-${d.at}`" :to="`/runs/${d.runId}`"
          class="inset-row focus-ring"
        >
          <span class="inset-row__lead"><StatusLabel :status="VERDICT[d.verdict]?.status ?? 'paused'" :label="VERDICT[d.verdict]?.word ?? d.verdict" icon-only /></span>
          <span class="inset-row__body">
            <span class="inset-row__title">{{ d.label }} <span class="font-normal text-label">· {{ d.ticket }}</span></span>
            <span v-if="d.note" class="inset-row__sub" :title="d.note">{{ d.note }}</span>
          </span>
          <span class="inset-row__end" :title="`Waited ${fmt(d.waitedMs)} for a person`">{{ d.by }} · {{ fmt(d.waitedMs) }}</span>
        </NuxtLink>
      </div>
    </details>
  </div>
</template>
