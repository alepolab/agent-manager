<script setup lang="ts">
import { isLiveStatus, isWaitingOnAPerson, type WorkflowRun } from '~~/shared/types/run'
import { statusKind, statusWord } from '~/utils/runStatus'
import { runLastActivityAt } from '~~/shared/utils/runClock'
import { currentStep } from '~/utils/runActivity'
import { oversightFor } from '~~/shared/utils/oversight'
import { gateAsk } from '~~/shared/utils/notifications'

/**
 * Home answers one question: what is open, addressed to me, and how long has it
 * been open. Everything that did not answer it has gone — the counts of static
 * configuration the sidebar already carries, the badge announcing the reader's
 * own job title, and a copy of /runs?mine=1.
 *
 * ROLE_BLURB lived here and was a second, drifted copy of ROLE_LABEL in
 * shared/types/role.ts. One map, in one place, or they disagree — which they
 * already did.
 */
const { me, can, role } = useUser()

// A manager's only question — where is the pipeline stuck, how often does work
// come back, what does it cost — is the board at the top. The queue and the
// Recent list below it are verbs they do not hold, so for them the board is the page.
const boardOnly = computed(() => role.value === 'manager')
const { agents, fetchAll: fetchAgents } = useAgents()
const { commands, fetchAll: fetchCommands } = useCommands()
const { skills, fetchAll: fetchSkills } = useSkills()
const { workflows, fetchAll: fetchWorkflows } = useWorkflows()
const toast = useToast()

const runs = ref<WorkflowRun[]>([])
const escalated = ref<{ key: string, watchId: string, lastError?: string, updatedAt: number }[]>([])
const loaded = ref(false)
/** Why the queue is empty, when it is empty because something broke. */
const loadError = ref<string | null>(null)

async function refresh() {
  const [r] = await Promise.allSettled([$fetch<WorkflowRun[]>('/api/runs')])
  // A rejected fetch used to leave the previous list in place and say nothing,
  // so "Nothing waiting on you" was shown for both an all-clear and an API that
  // was down. On the one screen whose job is to say what needs a person, those
  // two readings could not be further apart.
  if (r.status === 'fulfilled') { runs.value = r.value; loadError.value = null }
  else loadError.value = (r.reason as any)?.data?.message || (r.reason as any)?.message || 'Could not load runs'
  try {
    const watches = await $fetch<{ id: string }[]>('/api/watches')
    const states = await Promise.all(watches.map(w => $fetch<Record<string, { key: string, watchId: string, disposition: string, lastError?: string, updatedAt: number }>>(`/api/watches/${w.id}/state`).catch(() => ({}))))
    escalated.value = states.flatMap(s => Object.values(s)).filter(t => t.disposition === 'escalated')
  } catch { escalated.value = [] }
  loaded.value = true
}
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  refresh()
  if (!agents.value.length) fetchAgents()
  if (!commands.value.length) fetchCommands()
  if (!skills.value.length) fetchSkills()
  if (!workflows.value.length) fetchWorkflows()
  // isLiveStatus, so a run waiting for a slot keeps the poll going: the moment
  // it starts is the moment this page most needs to repaint.
  timer = setInterval(() => { if (runs.value.some(r => isLiveStatus(r.status))) refresh() }, 10_000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
// The live poll above stops once nothing is running; this picks up runs a watch or schedule starts.
useAutoRefresh(refresh)

const hasContent = computed(() => agents.value.length > 0 || commands.value.length > 0 || skills.value.length > 0)

/**
 * Is this run's open gate mine to answer?
 *
 * The queue used to show every paused run to everyone, so "different team
 * members oversee" was one undifferentiated list and nobody could tell which
 * decisions were theirs. A gate that declares no role stays everyone's, and an
 * operator sees all of them as the backstop.
 */
const mineToAnswer = (r: WorkflowRun) => {
  const want = r.question?.role
  return !want || !role.value || role.value === 'operator' || role.value === want
}
const attention = computed(() => runs.value
  .filter(r => !r.dismissed && (isWaitingOnAPerson(r.status) || ['failed', 'interrupted'].includes(r.status) || r.ci?.status === 'failing'))
  // Only gates are laned. A failed or interrupted run is not addressed to
  // anyone, and hiding it would leave it for nobody.
  .filter(r => !isWaitingOnAPerson(r.status) || mineToAnswer(r))
  // Rank, then longest wait first - the inverse of sorting by recency. A gate
  // owed to you outranks a broken run, which outranks a failing PR, which
  // outranks somebody else's gate.
  .sort((a, b) => {
    const rank = (r: WorkflowRun) =>
      isWaitingOnAPerson(r.status) && mineToAnswer(r) ? 0
      : r.status === 'failed' || r.status === 'interrupted' ? 1
      : r.ci?.status === 'failing' ? 2
      : 3
    return rank(a) - rank(b) || waitedMs(b) - waitedMs(a)
  }))
const dismissing = ref(false)
async function dismiss(ids: string[]) {
  dismissing.value = true
  try {
    await Promise.all(ids.map(id => $fetch(`/api/runs/${id}/dismiss`, { method: 'POST' })))
    await refresh()
  } catch (e: any) {
    toast.add({ title: 'Could not dismiss', description: e.data?.message || e.message, color: 'error' })
  } finally { dismissing.value = false }
}
/** Everything settled in the queue; a run stopped on a person still needs one, so it stays. */
const dismissable = computed(() => attention.value.filter(r => !isWaitingOnAPerson(r.status)))
/**
 * My runs, most recently ACTIVE first - not most recently started.
 *
 * /api/runs sorts by startedAt, which is the right order for the run-history
 * table (it shows a Started column) and the wrong one here: a restart resumes
 * an old run id, so the run that just ran can be the one that started three
 * days ago, and sorting by startedAt buries it under runs that have done
 * nothing since. The timestamp shown on each row is the same figure this
 * sorts by, so the list reads in the order it is written in.
 */
const mine = computed(() => runs.value
  // QA can never start a run, so filtering on `startedBy` left them a section
  // that is empty by construction, forever. Their own history is the decisions
  // they took — which the record already carries.
  .filter(r => (role.value === 'qa'
    ? (r.decisions ?? []).some(d => d.by === me.value?.login)
    : r.startedBy && r.startedBy === me.value?.login))
  .sort((a, b) => runLastActivityAt(b) - runLastActivityAt(a))
  .slice(0, 8))

/** A run's first line, whole. Cutting at 60 characters in the markup produced
 *  "... routing f" with no ellipsis; the columns below truncate properly. */
const headline = (r: WorkflowRun) => r.initialPrompt.split('\n')[0] ?? ''
const ticket = ref('')
const starting = ref(false)
/** Where the registry would route this ticket; shown before Start so the wrong stack is never a surprise. */
interface Preflight { product: { name: string, suite: string | null, repos: string[], recipe: boolean } | null, checkout: { name: string, exists: boolean, git: boolean, branch?: string, dirty: number } | null, artifacts: { ok: boolean, path: string }, tokens: { github: boolean, jira: boolean } }
const preflight = ref<Preflight | undefined>(undefined)
const routing = computed(() => preflight.value === undefined ? undefined : preflight.value.product)
let routeTimer: ReturnType<typeof setTimeout> | null = null
watch(ticket, (t) => {
  if (routeTimer) clearTimeout(routeTimer)
  if (!t.trim()) { preflight.value = undefined; return }
  routeTimer = setTimeout(async () => {
    try { preflight.value = await $fetch<Preflight>('/api/registry/preflight', { query: { q: t.trim().slice(0, 2000) } }) }
    catch { preflight.value = undefined }
  }, 400)
})
// On by default: the pause-after-every-wave gate is useful when you are
// watching a run, and pure friction when you are not. A failed step, a
// PIPELINE-HALT or a monitor voting ABORT still stops the run either way.
const autoRun = ref(true)
// Which workflow the ticket runs. Defaults to the first runbook, but every
// workflow on the instance is offered: the dashboard used to run Runbook A
// and nothing else, so a second shipped runbook was unreachable from here.
const workflowSlug = ref<string | undefined>()
watch(workflows, (list) => { if (!list.some(w => w.slug === workflowSlug.value)) workflowSlug.value = (list.find(w => w.slug.startsWith('runbook')) ?? list[0])?.slug }, { immediate: true })
const runbook = computed(() => workflows.value.find(w => w.slug === workflowSlug.value))
async function startFromTicket() {
  if (!ticket.value.trim() || !runbook.value) return
  starting.value = true
  try {
    const run = await $fetch<WorkflowRun>(`/api/workflows/${runbook.value.slug}/runs`, { method: 'POST', body: { initialPrompt: ticket.value.trim(), autoRun: autoRun.value } })
    ticket.value = ''
    await navigateTo(`/workflows/${run.workflowSlug}?run=${run.id}`)
  } catch (e: any) {
    if (e?.statusCode === 409 && e?.data?.data?.runId) await navigateTo(`/workflows/${runbook.value.slug}?run=${e.data.data.runId}`)
    // The workflow declares inputs this box cannot collect. Open the run dialog,
    // which can: a toast alone would say what is missing and leave nowhere to
    // put it.
    else if (e?.statusCode === 400 && e?.data?.data?.missing?.length) {
      toast.add({ title: 'This workflow needs its inputs', description: e.data.message, color: 'warning' })
      await navigateTo(`/workflows/${runbook.value.slug}?start=1`)
    }
    else toast.add({ title: 'Could not start the run', description: e.data?.message || e.message, color: 'error' })
  } finally {
    starting.value = false
  }
}

/**
 * What this row is actually asking of the reader.
 *
 * The old `why()` built a sentence that stood in for the question - "paused
 * before Push + PR" - naming the step the run is about to take rather than the
 * decision a person owes. `question.text` was on the record the whole time and
 * rendered nowhere on this page. A queue that says a run wants you and refuses
 * to say what for is a queue you have to open every row of.
 */
const ask = (r: WorkflowRun): string => {
  // Gates are worded in one place, so this queue and /notifications ask the same question.
  if (isWaitingOnAPerson(r.status)) return gateAsk(r)
  if (r.status === 'failed') return r.error || `Failed at ${r.steps.find(s => s.status === 'failed')?.label ?? 'a step'}`
  if (r.status === 'interrupted') return 'Stopped when the server restarted'
  if (r.ci?.status === 'failing') {
    const bad = (r.ci.checks ?? []).filter(c => c.bucket !== 'pass').map(c => c.name)
    return bad.length ? `Its pull request is failing: ${bad.join(', ')}` : 'Its pull request is failing checks'
  }
  return ''
}


/** Hue cannot separate "a person is blocking this" from "the machine broke it",
 *  and those two want opposite actions from the reader. */
const kindIcon = (r: WorkflowRun) =>
  r.status === 'awaiting_review' ? 'i-lucide-gavel'
  : r.status === 'paused' ? 'i-lucide-hand'
  : r.status === 'completed' && r.ci?.status === 'failing' ? 'i-lucide-git-pull-request-closed'
  : 'i-lucide-alert-triangle'

/**
 * How long a PERSON has been owed - not how long ago the machine last moved.
 *
 * The queue sorted by `runLastActivityAt`, so a gate nobody had answered in six
 * hours sat below a CI check that flapped a minute ago. For a paused run the
 * honest clock is `question.askedAt`.
 */
const waitedMs = (r: WorkflowRun) => Date.now() - (r.question?.askedAt ?? runLastActivityAt(r))
const waitTier = (r: WorkflowRun) => {
  const ms = waitedMs(r)
  // A starting calibration. `decisions[].waitedMs` is the real distribution of
  // how long gates wait on this instance; set these from its median and p90.
  return ms >= 4 * 3_600_000 ? 'critical' : ms >= 3_600_000 ? 'high' : ms >= 900_000 ? 'warm' : 'cool'
}
const shortWait = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}
const ago = (ms: number) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago` }

/** Risk, rendered only where it changes what the reader has to do. Most rows
 *  carry no mark, so the ones that do are unmissable. */
const riskOf = (r: WorkflowRun) => oversightFor(r.blastRadius)

/**
 * At most two lines under the input: what you typed resolved to, and the single
 * worst unresolved thing. The rest collapse.
 *
 * Seven conditional hints could render at once, five of them coloured, before
 * the reader had pressed anything — and the one that is fatal (nothing can write
 * the evidence directory, so the run refuses to start) was a visual peer of the
 * one that is trivia (no Jira token). Amber and red are a budget; the page
 * overdrew it while nothing had gone wrong.
 */
interface PreflightNote { level: 'error' | 'warn' | 'info', text: string }
const preflightNotes = computed<PreflightNote[]>(() => {
  const p = preflight.value
  if (!p) return []
  const n: PreflightNote[] = []
  if (!p.artifacts.ok) n.push({ level: 'error', text: `Runs cannot start: nothing can write to ${p.artifacts.path}. An operator has to fix the run directory on this server.` })
  if (!p.tokens.github) n.push({ level: 'warn', text: 'This run gets as far as opening the pull request, then stops — you have no GitHub token. Sign in with GitHub to fix it.' })
  if (p.checkout?.git && p.checkout.dirty) n.push({ level: 'warn', text: `${p.checkout.dirty} uncommitted change(s) in ${p.checkout.name} will be included in this run. Review them first if they should not be.` })
  if (p.checkout && !p.checkout.exists) n.push({ level: 'info', text: `${p.checkout.name} is not cloned here yet — the run clones it first, so expect a slower start.` })
  if (!p.tokens.jira) n.push({ level: 'info', text: 'No Jira token on your profile, so a bare key is not expanded and no result is posted back to Jira. Paste the ticket text instead.' })
  return n
})
const topNote = computed(() => preflightNotes.value[0] ?? null)
const otherNotes = computed(() => preflightNotes.value.slice(1))
/** A control must not offer an action the system has already decided to refuse. */
const startBlocked = computed(() => !!preflight.value && !preflight.value.artifacts.ok)
const noteColour = (l: string) => (l === 'error' ? 'var(--error)' : l === 'warn' ? 'var(--warning)' : 'var(--text-tertiary)')

/** Per-role wording. QA holds `startRun: false`, so "no runs started by you yet"
 *  is permanently true for them and tells them nothing. */
const queueEmpty = computed(() => ({
  developer: 'No decisions waiting. Start a run below when you have a ticket.',
  qa: 'Nothing to verify. Runs appear here when they reach the verification gate.',
  manager: 'Nothing open.',
  operator: 'No open gates, and nothing failing.',
}[role.value ?? 'operator'] ?? 'Nothing waiting on you.'))
// The sidebar calls this page Home, and the toolbar title agrees with it for
// the two roles whose page it is. QA and a manager get their page's job instead.
const pageTitle = computed(() => (role.value === 'qa' ? 'Verification queue' : boardOnly.value ? 'Pipeline' : 'Home'))

/** Runs doing work right now, most recently active first. */
const live = computed(() => runs.value
  .filter(r => r.status === 'running' || r.status === 'joining')
  .sort((a, b) => runLastActivityAt(b) - runLastActivityAt(a)))

/** The step a run is on, for the row under its title. */
const stepLabel = (r: WorkflowRun) => currentStep(r)?.label ?? ''

/**
 * The page opens with one sentence: what is working, and what is waiting on
 * you. It replaces a 26px title and four boxed numbers, and answers the only
 * question a person arrives with before they have read anything else.
 */
const yourGates = computed(() => attention.value.filter(r => isWaitingOnAPerson(r.status) && mineToAnswer(r)))
const oldestGate = computed(() => yourGates.value.reduce((m, r) => Math.max(m, waitedMs(r)), 0))
/**
 * The queue on Home is the head of the queue, not all of it: at 101 rows it
 * pushed everything else on the page off the bottom. Notifications is where
 * the whole list lives.
 */
const QUEUE_HEAD = 6
const queueExpanded = ref(false)
const queueLimit = computed(() => (queueExpanded.value ? Infinity : QUEUE_HEAD))
const shownAttention = computed(() => attention.value.slice(0, queueLimit.value))
const shownEscalated = computed(() => escalated.value.slice(0, Math.max(0, queueLimit.value - attention.value.length)))

/** The first sentence of the ask, without the ticket key the row already leads with. */
const askLine = (r: WorkflowRun) => {
  let a = ask(r)
  if (r.ticketKey && a.startsWith(`${r.ticketKey}: `)) a = a.slice(r.ticketKey.length + 2)
  const stop = a.search(/\.\s/)
  return stop > 0 ? a.slice(0, stop + 1) : a
}

const longWait = (ms: number) => {
  const h = Math.floor(ms / 3_600_000)
  return h >= 48 ? `${Math.floor(h / 24)} days` : h >= 1 ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.max(1, Math.round(ms / 60000))} minutes`
}

// Not "Your runs" — that is the page's own title, and a section repeating its
// page's heading says the section has no subject of its own.
const minedTitle = computed(() => (role.value === 'qa' ? 'Runs you have decided on' : 'Recent'))
const minedEmpty = computed(() => (role.value === 'qa'
  ? 'You have not decided on a run yet. Your approvals and send-backs appear here.'
  : 'You have not started a run yet. Paste a ticket above to start one.'))
</script>


<template>
  <div>
    <PageHeader :title="pageTitle" />
    <!-- Flex with `order`, so the queue leads whenever anything is waiting. A
         five-hour-old money gate below a text box is the page saying the box
         matters more. -->
    <div class="page flex flex-col gap-7">
      <WelcomeOnboarding v-if="loaded && !hasContent" @created="(agent) => navigateTo(`/agents/${agent.slug}`)" />

      <p v-if="loaded && !loadError && !boardOnly" class="lead-sentence">
        <template v-if="live.length"><em>{{ live.length }} {{ live.length === 1 ? 'run' : 'runs' }}</em> {{ live.length === 1 ? 'is' : 'are' }} working. </template>
        <template v-if="yourGates.length"><em>{{ yourGates.length }} {{ yourGates.length === 1 ? 'decision' : 'decisions' }}</em> {{ yourGates.length === 1 ? 'is' : 'are' }} waiting on you, the oldest for {{ longWait(oldestGate) }}.</template>
        <template v-else-if="!live.length">Nothing is running and nothing is waiting on you.</template>
        <template v-else>Nothing is waiting on you.</template>
      </p>

      <!-- Needs attention -->
      <section v-if="!boardOnly" :class="attention.length || escalated.length ? 'order-1' : 'order-3'">
        <div class="group-head">
          <!-- "Needs attention" is an alert system's passive voice; this is the
               first-person form of the same idea. -->
          <h2>Waiting on you</h2>
          <span class="group-head__count">{{ attention.length + escalated.length }}</span>
          <button v-if="dismissable.length" class="t-small text-label underline focus-ring" :disabled="dismissing" @click="dismiss(dismissable.map(r => r.id))">Clear {{ dismissable.length }} finished</button>
          <NuxtLink to="/notifications" class="group-head__link focus-ring">Notifications</NuxtLink>
        </div>
        <div v-if="!loaded" class="space-y-2"><SkeletonCard v-for="i in 2" :key="i" /></div>

        <div v-else-if="loadError" class="inset-list">
          <div class="inset-row">
            <span class="inset-row__lead"><UIcon name="i-lucide-alert-circle" class="size-4" style="color: var(--error);" /></span>
            <span class="inset-row__body">
              <span class="inset-row__title" style="color: var(--error);">Could not load runs, so this queue may be incomplete.</span>
              <span class="inset-row__sub">{{ loadError }}</span>
            </span>
            <UButton size="xs" color="neutral" variant="soft" label="Retry" @click="refresh" />
          </div>
        </div>
        <p v-else-if="!attention.length && !escalated.length" class="t-ui text-label">{{ queueEmpty }}</p>
        <!-- Each row leads with a glyph for what kind of wait it is — a person
             owed a decision, a failure, a red PR — so the kind survives without
             colour. Rows that are someone else's gate are dimmed, not hidden:
             ownership that `mineToAnswer` used to only filter by, never show. -->
        <ul v-else class="inset-list">
          <li
            v-for="r in shownAttention" :key="r.id"
            class="inset-row"
            :style="{ opacity: isWaitingOnAPerson(r.status) && !mineToAnswer(r) ? 0.6 : undefined }"
          >
            <span class="inset-row__lead">
              <UIcon :name="kindIcon(r)" class="size-4" :class="`status-label--${statusKind(r.status === 'completed' ? 'failed' : r.status)}`" />
            </span>
            <span class="inset-row__body">
              <NuxtLink
                :to="`/runs/${r.id}`" class="inset-row__title focus-ring hover:underline"
                :aria-label="`${statusWord(r.status)} — ${r.ticketKey || headline(r)}: ${ask(r)}`"
              ><span v-if="r.ticketKey" class="font-mono">{{ r.ticketKey }}</span><template v-else>{{ headline(r) }}</template></NuxtLink>
              <span class="inset-row__sub" :title="ask(r)">{{ askLine(r) }}</span>
            </span>
            <span
              v-if="r.blastRadius && riskOf(r) !== 'auto'"
              class="t-small shrink-0" :style="{ color: riskOf(r) === 'justify' ? 'var(--warning)' : 'var(--text-tertiary)' }"
              :title="riskOf(r) === 'justify' ? 'Owner-gated: approving needs a written reason' : 'Stops for a person'"
            >{{ riskOf(r) === 'justify' ? 'Owner-gated' : r.blastRadius }}</span>
            <span
              class="inset-row__end"
              :style="waitTier(r) === 'critical' ? { color: 'var(--warning)', fontWeight: 600 } : undefined"
              :title="`Waiting ${shortWait(waitedMs(r))}`"
            >{{ shortWait(waitedMs(r)) }}</span>
            <span class="w-16 flex justify-end shrink-0">
              <UButton v-if="isWaitingOnAPerson(r.status) && mineToAnswer(r)" size="xs" :label="r.status === 'awaiting_review' ? 'Decide' : 'Answer'" :to="`/runs/${r.id}`" />
              <UButton
                v-else-if="!isWaitingOnAPerson(r.status)" size="xs" color="neutral" variant="ghost" icon="i-lucide-x" :disabled="dismissing"
                title="Remove this run from your queue"
                :aria-label="`Remove ${r.ticketKey || headline(r)} from your queue`"
                @click.stop="dismiss([r.id])"
              />
            </span>
          </li>
          <!-- Same row shape, so an escalation competes with the runs on wait
               rather than being appended below them in its own sorted list. The
               link goes to /watches only for roles whose nav includes it. -->
          <li v-for="t in shownEscalated" :key="t.watchId + t.key" class="inset-row">
            <span class="inset-row__lead"><UIcon name="i-lucide-radio-tower" class="size-4" style="color: var(--error);" /></span>
            <span class="inset-row__body">
              <NuxtLink :to="can('configure') ? '/watches' : `/runs?q=${encodeURIComponent(t.key)}`" class="inset-row__title font-mono focus-ring hover:underline">{{ t.key }}</NuxtLink>
              <span class="inset-row__sub" :title="t.lastError || ''">{{ t.lastError || 'Gave up after repeated failures' }}</span>
            </span>
            <span class="inset-row__end">{{ shortWait(Date.now() - t.updatedAt) }}</span>
            <span class="w-16 shrink-0" />
          </li>
          <li v-if="attention.length + escalated.length > QUEUE_HEAD" class="inset-row">
            <button class="t-small focus-ring" style="color: var(--accent);" @click="queueExpanded = !queueExpanded">
              {{ queueExpanded ? 'Show fewer' : `Show all ${attention.length + escalated.length}` }}
            </button>
          </li>
        </ul>
      </section>

      <section v-if="!boardOnly && live.length" class="order-2">
        <div class="group-head">
          <h2>Running now</h2><span class="group-head__count">{{ live.length }}</span>
          <NuxtLink to="/runs" class="group-head__link focus-ring">All runs</NuxtLink>
        </div>
        <div class="inset-list">
          <NuxtLink v-for="r in live.slice(0, 6)" :key="r.id" :to="`/runs/${r.id}`" class="inset-row focus-ring">
            <span class="inset-row__lead"><StatusLabel :status="r.status" icon-only /></span>
            <span class="inset-row__body">
              <span class="inset-row__title"><span v-if="r.ticketKey" class="font-mono mr-1.5">{{ r.ticketKey }}</span>{{ r.ticketKey ? '' : headline(r) }}<span v-if="r.ticketKey" class="font-normal">{{ headline(r).replace(r.ticketKey, '').replace(/^[:\s-]+/, '') }}</span></span>
              <RunProgressBar :steps="r.steps" class="mt-1.5 max-w-80" />
            </span>
            <span class="inset-row__end">{{ stepLabel(r) }} · {{ ago(runLastActivityAt(r)) }}</span>
          </NuxtLink>
        </div>
      </section>

      <form
        v-if="can('startRun')"
        class="group-card flex flex-wrap items-end gap-3"
        :class="attention.length || escalated.length ? 'order-3' : 'order-1'"
        @submit.prevent="startFromTicket"
      >
        <div class="flex-1 min-w-[16rem]">
          <label class="field-label" for="ticket">Start a run from a ticket</label>
          <input id="ticket" v-model="ticket" class="field-input w-full" placeholder="SCN-402, or paste the ticket text" :disabled="!runbook" />
          <select v-if="workflows.length > 1" v-model="workflowSlug" class="field-input field-select mt-2" aria-label="Workflow to run">
            <option v-for="w in workflows" :key="w.slug" :value="w.slug">{{ w.name }} ({{ w.steps.length }} steps)</option>
          </select>
          <span v-if="!runbook" class="field-hint block">No runbooks on this instance yet. <NuxtLink to="/workflows" class="underline">Create one</NuxtLink> before you can start a run.</span>
          <!-- Line 1: the answer to what you typed. Never suppressed, never
               competing — it is the only line the reader asked for by typing. -->
          <span v-if="routing" class="field-hint block" style="color: var(--success);">Runs against {{ routing.name }} — {{ routing.repos.join(', ') || 'no repos listed' }}{{ routing.recipe ? '' : '. No recipe yet, so the stack step improvises.' }}</span>
          <span v-else-if="routing === null" class="field-hint block" style="color: var(--warning);">No matching product — the run works from the ticket text alone. Add the project key to target a codebase.</span>
          <!-- Line 2: the single worst unresolved thing. Everything else collapses. -->
          <span v-if="topNote" class="field-hint block" :style="{ color: noteColour(topNote.level) }">{{ topNote.text }}</span>
          <details v-if="otherNotes.length" class="field-hint block">
            <summary class="cursor-pointer focus-ring">{{ otherNotes.length }} more thing(s) to know before this runs</summary>
            <span v-for="n in otherNotes" :key="n.text" class="block mt-1" :style="{ color: noteColour(n.level) }">{{ n.text }}</span>
          </details>
          <label class="flex items-center gap-2 cursor-pointer mt-2" title="A failed step or an aborting monitor still stops the run.">
            <input v-model="autoRun" type="checkbox" class="shrink-0" :disabled="!runbook">
            <span class="field-label mb-0">Don't stop at gates</span>
          </label>
        </div>
        <UButton
          type="submit" :label="starting ? 'Starting…' : 'Start run'" icon="i-lucide-play" :loading="starting"
          :disabled="!ticket.trim() || !runbook || startBlocked"
          :title="startBlocked ? 'Runs cannot start until the run directory is writable' : ''"
        />
      </form>

      <!-- The numbers and the history: below the queue for anyone with a queue,
           and the whole page for a manager. A failed load is reported by the
           queue, so the board stays out rather than showing zeros. -->
      <PipelineBoard v-if="loaded && !loadError" class="order-4" :runs="runs" :show-gates="boardOnly" />
      <p v-else-if="loadError && boardOnly" class="t-ui" style="color: var(--error);">Could not load runs: {{ loadError }} <button class="underline focus-ring" @click="refresh">Retry</button></p>

      <section v-if="!boardOnly" class="order-5">
        <div class="group-head"><h2>{{ minedTitle }}</h2></div>
        <!-- Branches on the error, like the queue above it does. -->
        <p v-if="loadError && !mine.length" class="t-ui" style="color: var(--error);">Could not load your runs.</p>
        <p v-else-if="loaded && !mine.length" class="t-ui text-label">{{ minedEmpty }}</p>
        <!-- Grid, not flex: the progress bar used to sit wherever the title
             ended, so it landed in a different place on every row. -->
        <div v-else class="inset-list inset-list--flush">
          <NuxtLink
            v-for="r in mine" :key="r.id" :to="`/runs/${r.id}`"
            class="inset-row focus-ring grid! grid-cols-[6.5rem_minmax(0,1fr)_7rem_4.5rem]"
          >
            <StatusLabel :status="r.status" />
            <span class="truncate" :title="headline(r)">{{ headline(r) }}</span>
            <RunProgressBar :steps="r.steps" />
            <span
              class="text-label text-right whitespace-nowrap t-small"
              :title="`Started ${new Date(r.startedAt).toLocaleString()}`"
            >{{ ago(runLastActivityAt(r)) }}</span>
          </NuxtLink>
        </div>
      </section>
    </div>
  </div>
</template>
