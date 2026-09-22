<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import type { Role } from '~~/shared/types/role'
import { RUN_STATUS_COLOR } from '~/utils/runStatus'
import { runLastActivityAt } from '~~/shared/utils/runClock'
import { oversightFor } from '~~/shared/utils/oversight'

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
const { me, can, role, viewingAs, viewAs } = useUser()

// A manager's only question — where is the pipeline stuck, how often does work
// come back, what does it cost — is answered by /board with real figures. This
// page was a weaker copy of it for them: no verbs, no gates they can answer.
watch(role, (r) => { if (r === 'manager') navigateTo('/board') }, { immediate: true })
const switching = ref(false)
async function lookAs(next: string | null) {
  switching.value = true
  try { await viewAs(next as any) } finally { switching.value = false }
}
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
  timer = setInterval(() => { if (runs.value.some(r => r.status === 'running' || r.status === 'paused')) refresh() }, 10_000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })

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
  .filter(r => !r.dismissed && (['paused', 'failed', 'interrupted'].includes(r.status) || r.ci?.status === 'failing'))
  // Only gates are laned. A failed or interrupted run is not addressed to
  // anyone, and hiding it would leave it for nobody.
  .filter(r => r.status !== 'paused' || mineToAnswer(r))
  // Rank, then longest wait first — the inverse of sorting by recency. A gate
  // owed to you outranks a broken run, which outranks a failing PR, which
  // outranks somebody else's gate.
  .sort((a, b) => {
    const rank = (r: WorkflowRun) =>
      r.status === 'paused' && mineToAnswer(r) ? 0
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
/** Everything settled in the queue; a paused run still needs a decision, so it stays. */
const dismissable = computed(() => attention.value.filter(r => r.status !== 'paused'))
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
  // A role that cannot start a run has no `startedBy` of its own, so filtering
  // on it left them a section that is empty by construction, forever. Their
  // history is the decisions they took — which the record already carries.
  // Keyed on the capability rather than on `role === 'qa'`, or every reviewer
  // role added after QA inherits the empty section QA was rescued from.
  .filter(r => (!can('startRun')
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
    else toast.add({ title: 'Could not start the run', description: e.data?.message || e.message, color: 'error' })
  } finally {
    starting.value = false
  }
}

/**
 * What this row is actually asking of the reader.
 *
 * The old `why()` built a sentence that stood in for the question — "paused
 * before Push + PR" — naming the step the run is about to take rather than the
 * decision a person owes. `question.text` was on the record the whole time and
 * rendered nowhere on this page. A queue that says a run wants you and refuses
 * to say what for is a queue you have to open every row of.
 */
const ask = (r: WorkflowRun): string => {
  if (r.status === 'paused') {
    if (r.question?.reason === 'budget') return 'Out of budget — approve more, or stop it'
    return r.question?.text || 'Paused — open it to see why'
  }
  if (r.status === 'failed') return r.error || `Failed at ${r.steps.find(s => s.status === 'failed')?.label ?? 'a step'}`
  if (r.status === 'interrupted') return 'Stopped when the server restarted'
  if (r.ci?.status === 'failing') {
    const bad = (r.ci.checks ?? []).filter(c => c.bucket !== 'pass').map(c => c.name)
    return bad.length ? `Its pull request is failing: ${bad.join(', ')}` : 'Its pull request is failing checks'
  }
  return ''
}

/** The runner's vocabulary is not a person's: `interrupted` is what the codebase
 *  calls a process that died, and nobody outside it says that. */
const STATUS_WORD: Record<string, string> = {
  paused: 'Waiting', failed: 'Failed', interrupted: 'Stopped',
  running: 'Running', completed: 'Done', stopped: 'Stopped',
}
const statusWord = (s: string) => STATUS_WORD[s] ?? s

/** Hue cannot separate "a person is blocking this" from "the machine broke it",
 *  and those two want opposite actions from the reader. */
const kindIcon = (r: WorkflowRun) =>
  r.status === 'paused' ? 'i-lucide-hand'
  : r.status === 'completed' && r.ci?.status === 'failing' ? 'i-lucide-git-pull-request-closed'
  : 'i-lucide-alert-triangle'

/**
 * How long a PERSON has been owed — not how long ago the machine last moved.
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
  'product-owner': 'Nothing to decide. Stories appear here when they reach the readiness or acceptance gate.',
  developer: 'No decisions waiting. Start a run below when you have a ticket.',
  qa: 'Nothing to verify. Runs appear here when they reach the verification gate.',
  architect: 'Nothing to review. Runs appear here when they reach a schema, contract or migration gate.',
  designer: 'Nothing to accept. Runs appear here when they reach the design gate.',
  security: 'Nothing to clear. Runs appear here when they touch authorization, crypto, personal data, payment or a dependency.',
  manager: 'Nothing open.',
  cto: 'Nothing escalated. Runs appear here only when they cross the escalation threshold.',
  operator: 'No open gates, and nothing failing.',
}[role.value ?? 'operator'] ?? 'Nothing waiting on you.'))
/** The queue's name is the reviewer's job, so each reviewing role gets its own. */
const REVIEW_QUEUE_TITLE: Partial<Record<Role, string>> = {
  qa: 'Verification queue',
  architect: 'Architecture review queue',
  designer: 'Design review queue',
}
const pageTitle = computed(() => REVIEW_QUEUE_TITLE[role.value ?? 'operator'] ?? 'Your runs')
// Not "Your runs" — that is the page's own title, and a section repeating its
// page's heading says the section has no subject of its own.
const minedTitle = computed(() => (can('startRun') ? 'Recent' : 'Runs you have decided on'))
const minedEmpty = computed(() => (can('startRun')
  ? 'You have not started a run yet. Paste a ticket above to start one.'
  : 'You have not decided on a run yet. Your approvals and send-backs appear here.'))
</script>

<template>
  <div>
    <!-- "Dashboard" is a furniture name: the same word for four jobs, telling
         nobody anything. -->
    <PageHeader :title="pageTitle" />
    <!-- Flex with `order`, so the queue leads whenever anything is waiting. A
         five-hour-old money gate below a text box is the page saying the box
         matters more. -->
    <div class="page flex flex-col gap-6">
      <WelcomeOnboarding v-if="loaded && !hasContent" @created="(agent) => navigateTo(`/agents/${agent.slug}`)" />

      <!-- Only while impersonating. A console with controls silently missing is
           indistinguishable from a broken one, so that state earns a banner —
           but the rest of the time this row spent the most valuable line on the
           page telling people their own job title, every load, forever. The
           "view as" switcher is an operator's occasional tool and belongs with
           the other role settings, not above the queue. -->
      <div v-if="viewingAs" class="flex flex-wrap items-center gap-2 t-small rounded-lg px-3 py-2" style="background: var(--accent-muted); border: 1px solid var(--accent);">
        <span style="color: var(--text-primary);">You are seeing this as a <span class="font-mono">{{ role }}</span>. Controls you normally have are hidden.</span>
        <button class="ml-auto underline focus-ring" :disabled="switching" @click="lookAs(null)">Back to your own view</button>
      </div>

      <form v-if="can('startRun')" class="rounded-xl p-4 flex flex-wrap items-end gap-3" :class="attention.length || escalated.length ? 'order-2' : 'order-1'" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);" @submit.prevent="startFromTicket">
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

      <!-- Needs attention -->
      <section :class="attention.length || escalated.length ? 'order-1' : 'order-2'">
        <div class="flex items-center gap-3 mb-2">
          <!-- "Needs attention" is an alert system's passive voice. /board
               already says "Waiting on a person"; this is the first-person form
               of the same idea. "Settled" is the codebase's word, not a reader's. -->
          <h2 class="text-section-label">Waiting on you <span class="text-meta font-normal">{{ attention.length + escalated.length }}</span></h2>
          <button v-if="dismissable.length" class="t-small text-label underline focus-ring" :disabled="dismissing" @click="dismiss(dismissable.map(r => r.id))">Clear {{ dismissable.length }} finished</button>
        </div>
        <div v-if="!loaded" class="space-y-2"><SkeletonCard v-for="i in 2" :key="i" /></div>
        <div v-else-if="loadError" class="rounded-lg px-3 py-2 flex items-center gap-3 t-small" style="background: rgba(248,113,113,0.06); border: 1px solid rgba(248,113,113,0.12);">
          <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" style="color: var(--error);" />
          <span style="color: var(--error);">Could not load runs, so this queue may be incomplete.</span>
          <span class="text-label truncate">{{ loadError }}</span>
          <button class="ml-auto underline focus-ring shrink-0" style="color: var(--error);" @click="refresh">Retry</button>
        </div>
        <p v-else-if="!attention.length && !escalated.length" class="t-ui text-label">{{ queueEmpty }}</p>
        <!-- Status moved off the text and onto a rail: a coloured word inside a
             grid cell is not scannable down a stack, and it encoded status twice
             since the word was already tinted. Solid rail = yours to answer,
             washed = someone else's — ownership that `mineToAnswer` previously
             only filtered by, never showed. -->
        <ul v-else class="attn-list">
          <li
            v-for="r in attention" :key="r.id"
            class="attn-row t-ui"
            :class="[`attn-row--${waitTier(r)}`, { 'attn-row--mine': r.status === 'paused' && mineToAnswer(r) }]"
            :style="{ '--rail': RUN_STATUS_COLOR[r.status] }"
          >
            <span class="attn-rail" aria-hidden="true" />
            <UIcon :name="kindIcon(r)" class="size-3.5 shrink-0" :style="{ color: RUN_STATUS_COLOR[r.status] }" />
            <!-- The status word is gone from the row, so it goes into the
                 accessible name instead: dropping a channel must not drop it
                 from the accessibility tree. -->
            <NuxtLink
              :to="`/runs/${r.id}`" class="attn-key focus-ring"
              :aria-label="`${statusWord(r.status)} — ${r.ticketKey || headline(r)}: ${ask(r)}`"
            >{{ r.ticketKey || headline(r) }}</NuxtLink>
            <span class="attn-ask" :title="ask(r)">{{ ask(r) }}</span>
            <span
              v-if="r.blastRadius && riskOf(r) !== 'auto'"
              class="attn-risk t-label" :class="{ 'attn-risk--justify': riskOf(r) === 'justify' }"
              :title="riskOf(r) === 'justify' ? 'Owner-gated: approving needs a written reason' : 'Stops for a person'"
            >{{ r.blastRadius }}</span>
            <span v-else />
            <RunProgressBar :steps="r.steps" />
            <span class="attn-wait tabular" :title="`Waiting ${shortWait(waitedMs(r))}`">{{ shortWait(waitedMs(r)) }}</span>
            <span class="attn-act">
              <UButton v-if="r.status === 'paused' && mineToAnswer(r)" size="xs" variant="soft" label="Answer" :to="`/runs/${r.id}`" />
              <button
                v-else-if="r.status !== 'paused'" class="attn-dismiss focus-ring" :disabled="dismissing"
                title="Remove this run from your queue"
                :aria-label="`Remove ${r.ticketKey || headline(r)} from your queue`"
                @click.stop="dismiss([r.id])"
              ><UIcon name="i-lucide-x" class="size-3.5" /></button>
            </span>
          </li>
          <!-- Same row shape, so an escalation competes with the runs on wait
               rather than being appended below them in its own sorted list. The
               link goes to /watches only for roles whose nav includes it: QA and
               manager were being sent to a page they cannot open. -->
          <li v-for="t in escalated" :key="t.watchId + t.key" class="attn-row t-ui attn-row--high" style="--rail: var(--error);">
            <span class="attn-rail" aria-hidden="true" />
            <UIcon name="i-lucide-radio-tower" class="size-3.5 shrink-0" style="color: var(--error);" />
            <NuxtLink :to="can('configure') ? '/watches' : `/runs?q=${encodeURIComponent(t.key)}`" class="attn-key focus-ring">{{ t.key }}</NuxtLink>
            <span class="attn-ask" :title="t.lastError || ''">{{ t.lastError || 'Gave up after repeated failures' }}</span>
            <span />
            <span />
            <span class="attn-wait tabular">{{ shortWait(Date.now() - t.updatedAt) }}</span>
            <span class="attn-act" />
          </li>
        </ul>
      </section>

      <!-- The Setup card that used to sit beside this — four counts of static
           configuration, linking to four pages already in the sidebar — is gone.
           Nothing on a triage screen is decided by "31 commands", and it was a
           third of the page width below the primary action. -->
      <div class="order-3">
        <section>
          <h2 class="text-section-label mb-2">{{ minedTitle }}</h2>
          <!-- Branches on the error, like the queue above it does. This said
               "No runs started by you yet" when the fetch had failed — the same
               defect as the queue's, twelve lines away and still live. -->
          <p v-if="loadError && !mine.length" class="t-ui" style="color: var(--error);">Could not load your runs.</p>
          <p v-else-if="loaded && !mine.length" class="t-ui text-label">{{ minedEmpty }}</p>
          <!-- Grid, not flex: the progress bar used to sit wherever the title
               ended, so it landed in a different place on every row. Fixed
               columns line the four fields up down the list. -->
          <div v-else class="space-y-1">
            <NuxtLink
              v-for="r in mine" :key="r.id" :to="`/runs/${r.id}`"
              class="grid grid-cols-[5rem_minmax(0,1fr)_6rem_4.5rem] items-center gap-3 rounded-lg px-3 py-2 t-small focus-ring"
              style="background: var(--surface-raised); border: 1px solid var(--border-subtle);"
            >
              <span class="font-mono t-label truncate" :style="{ color: RUN_STATUS_COLOR[r.status] }">{{ statusWord(r.status) }}</span>
              <span class="truncate" style="color: var(--text-primary);" :title="headline(r)">{{ headline(r) }}</span>
              <RunProgressBar :steps="r.steps" />
              <span
                class="text-label text-right whitespace-nowrap"
                :title="`Started ${new Date(r.startedAt).toLocaleString()}`"
              >{{ ago(runLastActivityAt(r)) }}</span>
            </NuxtLink>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
