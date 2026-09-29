<script setup lang="ts">
import { isLiveStatus, isTestRun, isWaitingOnAPerson, type WorkflowRun } from '~~/shared/types/run'
import { runElapsedLabel, RUN_DURATION_HINT } from '~/utils/runStatus'
import { currentStep, isQuiet, shortDuration, stepsDone } from '~/utils/runActivity'
import { gateIsMine } from '~~/shared/utils/notifications'
import { runLastActivityAt } from '~~/shared/utils/runClock'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const runs = ref<WorkflowRun[]>([])
const loaded = ref(false)
const loadError = ref<string | null>(null)
const busy = ref<string | null>(null)
// `can`, not just `me`: this page rendered Restart, Stop, Clone and Delete to
// every role. Three of them 403 for a developer or QA, which teaches people to
// click and see what happens — and the fourth, Delete, did NOT 403, because its
// route checked identity and never capability. A manager could destroy a run and
// its evidence bundle from here.
const { me, can, role } = useUser()
const mine = computed({
  get: () => route.query.mine === '1',
  set: v => router.replace({ query: { ...route.query, mine: v ? '1' : undefined } }),
})

// Filters live in the URL so a filtered view can be shared or reloaded.
const filter = computed({
  get: () => (typeof route.query.q === 'string' ? route.query.q : ''),
  set: v => router.replace({ query: { ...route.query, q: v || undefined } }),
})
const view = computed({
  get: () => (typeof route.query.view === 'string' ? route.query.view : ''),
  set: v => router.replace({ query: { ...route.query, view: v || undefined } }),
})
const status = computed({
  get: () => (typeof route.query.status === 'string' ? route.query.status : ''),
  set: v => router.replace({ query: { ...route.query, status: v || undefined } }),
})

const parent = computed(() => (typeof route.query.parent === 'string' ? route.query.parent : ''))

/** Group occupancy, so a queued row can say what it is waiting behind rather
 *  than only that it is waiting. */
const groups = ref<{ id: string, name: string, inFlight: number, maxConcurrent: number }[]>([])
const loadFor = (r: WorkflowRun) => groups.value.find(g => g.id === (r.group?.trim() || 'default'))

async function refresh() {
  // A response for a view the page has since left would overwrite the new view's list.
  const forView = view.value
  try {
    // Test runs are only fetched for the Tests view: everywhere else they would
    // sit beside the real runs they test, and be counted with them.
    const list = await $fetch<WorkflowRun[]>(forView === 'tests' ? '/api/runs?tests=1' : '/api/runs')
    if (view.value !== forView) return
    runs.value = list
    // Best-effort: a queued row without its group's numbers still says it is
    // waiting, which is the load-bearing half.
    groups.value = await $fetch<typeof groups.value>('/api/workflow-groups').catch(() => groups.value)
    loadError.value = null
  } catch (e: any) {
    if (view.value !== forView) return
    loadError.value = e.data?.message || e.message || 'Failed to load runs'
  } finally {
    loaded.value = true
  }
}

// Poll only while something can change; a static list must not hammer the server.
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  refresh()
  timer = setInterval(() => {
    // `|| loadError` is the recovery path. Polling only while something is live
    // meant that after a failed load the list was empty, so `live` was empty, so
    // the poll never fired again — the page stayed broken until someone thought
    // to press Retry or reload, even once the server came back.
    if (live.value.length || loadError.value) refresh()
  }, 5000)
  clock = setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (clock) clearInterval(clock)
})
// The 5s poll stops once nothing is live; this picks up runs a watch, schedule or another tab starts.
useAutoRefresh(refresh)
// Switching to or from Tests swaps the list, so the selected run would be one it no longer shows.
watch(view, (v, was) => { if ((v === 'tests') !== (was === 'tests')) { select(null); refresh() } })

// Runs that can still change, newest first: the "what is happening now" list.
// Deliberately NOT filtered by the table's filters — those exist to search
// history, and hiding a live run behind a stale filter is how one gets
// forgotten.
// Includes `queued`: a run waiting for a slot can still change, so the 5s
// poll has to keep going or the moment it starts is never painted.
const live = computed(() => runs.value.filter(r => isLiveStatus(r.status)))

// The list refreshes every 5s; a run's idle time has to count up in between or
// a card that says "12s ago" for five seconds reads as frozen.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

/**
 * Five views instead of a status dropdown, a Mine checkbox and a filter box
 * side by side. `?status=` still narrows to one exact status for old links.
 */
const VIEWS = [
  { key: '', label: 'All' },
  { key: 'waiting', label: 'Waiting on me' },
  { key: 'running', label: 'Active' },
  { key: 'failed', label: 'Failed' },
  { key: 'tests', label: 'Tests' },
] as const
const waitingOnMe = (r: WorkflowRun) => isWaitingOnAPerson(r.status) && gateIsMine(r.question?.role, role.value)
// A test run matches only Tests, and Tests only test runs: the list holds both
// while that view is open, and neither may be counted as the other.
const matchesView = (r: WorkflowRun, v: string) =>
  v === 'tests' ? isTestRun(r)
  : isTestRun(r) ? false
  : v === 'waiting' ? waitingOnMe(r)
  : v === 'running' ? isLiveStatus(r.status) && !isWaitingOnAPerson(r.status)
  : v === 'failed' ? r.status === 'failed' || r.status === 'interrupted'
  : true
const inView = (r: WorkflowRun) => matchesView(r, view.value)
/** Like the views: test runs count only while Tests is the view. */
const headerCount = computed(() => runs.value.filter(r => view.value === 'tests' ? isTestRun(r) : !isTestRun(r)).length)

/** The selected run lives in the URL, so a run in the split view can be linked to. */
const selectedId = computed(() => (typeof route.query.run === 'string' ? route.query.run : null))
function select(id: string | null) { router.replace({ query: { ...route.query, run: id ?? undefined } }) }

const headline = (r: WorkflowRun) => {
  const first = r.initialPrompt.split('\n')[0] ?? ''
  const t = r.ticketKey && first.startsWith(r.ticketKey) ? first.slice(r.ticketKey.length).replace(/^[:\s·-]+/, '') : first
  return r.testOf ? `Test of #${r.testOf.sourceRunId.slice(0, 6)} · ${t}` : t
}
const ago = (ms: number) => { const m = Math.round((now.value - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago` }
/** The row's second line: where the run is, and whether it has gone quiet. */
const whereNow = (r: WorkflowRun) => {
  if (r.status === 'queued') {
    const g = loadFor(r)
    const waiting = `waiting ${shortDuration(now.value - (r.queuedAt ?? r.startedAt))}`
    return g ? `Queued behind ${g.name}: ${g.inFlight} of ${g.maxConcurrent} running · ${waiting}` : `Queued · ${waiting}`
  }
  const step = currentStep(r)
  // "Runbook A — Ticket to Evidence-Backed PR" on every row pushed the step
  // and the time off the end; the name before the dash is enough to tell runbooks apart.
  const bits = [r.workflowName.split(' — ')[0] ?? r.workflowName]
  if (step && isLiveStatus(r.status)) bits.push(isQuiet(r, step, now.value) ? `${step.label}, quiet` : step.label)
  bits.push(ago(runLastActivityAt(r)))
  return bits.join(' · ')
}

const shown = computed(() => runs.value.filter(r =>
  inView(r) &&
  (!filter.value || [r.workflowName, r.initialPrompt.split('\n')[0] ?? '', r.startedBy ?? '', r.product?.name ?? '', r.ticketKey ?? ''].some(v => v.toLowerCase().includes(filter.value.toLowerCase())))
  && (!status.value || r.status === status.value)
  && (!mine.value || r.startedBy === me.value?.login)
  && (!parent.value || r.parentRunId === parent.value))
  // Working runs lead: "what is happening right now" is the question this
  // page is opened with. Otherwise newest first, as the API returns them.
  .sort((a, b) => Number(isLiveStatus(b.status)) - Number(isLiveStatus(a.status))))

const selected = computed(() => runs.value.find(r => r.id === selectedId.value) ?? null)
// Open the first run when none is chosen, on a screen wide enough for both panes.
watch(shown, (list) => {
  if (selectedId.value || !list[0] || !import.meta.client) return
  if (window.matchMedia('(min-width: 1024px)').matches) select(list[0].id)
}, { immediate: true })

// Execution time from the run clock, and it re-renders because `now` ticks:
// this column read `endedAt - startedAt`, so a run restarted an hour after it
// failed showed that hour as its duration.
const duration = (r: WorkflowRun) => runElapsedLabel(r, now.value)
/** The step a one-click restart resumes from: the failed one, or what was executing. */
const restartPoint = (r: WorkflowRun) =>
  r.steps.find(s => s.status === 'failed')?.stepId
  ?? r.currentStepIds[0]
  // Not a skipped step. A run that died in preflight has every step skipped and
  // none failed, so this fell through to the first of them and offered a Restart
  // that the runner answers with a 409. Nothing here can be restarted; the run
  // has to be started again once whatever preflight objected to is fixed.
  ?? r.steps.find(s => s.status !== 'completed' && s.status !== 'skipped')?.stepId
// Each of these is "may this run take the action" AND "may this person take it".
// Folding the capability in here rather than at each button keeps the two
// buttons and the bulk control from drifting apart later.
const canRestart = (r: WorkflowRun) => can('runEngine') && ['failed', 'stopped', 'interrupted'].includes(r.status) && !!restartPoint(r)
async function act(r: WorkflowRun, path: 'restart', body?: Record<string, unknown>) {
  busy.value = r.id
  try {
    await $fetch(`/api/runs/${r.id}/${path}`, { method: 'POST', body })
    await refresh()
    navigateTo(`/workflows/${r.workflowSlug}?run=${r.id}`)
  } catch (e: any) {
    toast.add({ title: `Failed to ${path}`, description: e.data?.message || e.message, color: 'error' })
  } finally {
    busy.value = null
  }
}

// Deleting a run takes its evidence directory with it - the one irreversible act
// in this console, and the one that was open to everyone.
const canDelete = (r: WorkflowRun) => can('runEngine') && !isLiveStatus(r.status)

// Delete removes the run and its evidence for good: ask once inline, like Stop.
const confirmingDelete = ref<string | null>(null)
let deleteTimer: ReturnType<typeof setTimeout> | null = null
async function del(r: WorkflowRun) {
  if (confirmingDelete.value !== r.id) {
    confirmingDelete.value = r.id
    if (deleteTimer) clearTimeout(deleteTimer)
    deleteTimer = setTimeout(() => { confirmingDelete.value = null }, 4000)
    return
  }
  confirmingDelete.value = null
  busy.value = r.id
  try {
    await $fetch(`/api/runs/${r.id}`, { method: 'DELETE' as any })
    await refresh()
  } catch (e: any) {
    toast.add({ title: 'Failed to delete', description: e.data?.message || e.message, color: 'error' })
  } finally {
    busy.value = null
  }
}

// Bulk delete of every failed run currently shown. One confirm, then one request each.
const failedShown = computed(() => (can('runEngine') ? shown.value.filter(r => r.status === 'failed') : []))
const confirmingBulk = ref(false)
let bulkTimer: ReturnType<typeof setTimeout> | null = null
const bulkDeleting = ref(false)
async function deleteFailed() {
  if (!confirmingBulk.value) {
    confirmingBulk.value = true
    if (bulkTimer) clearTimeout(bulkTimer)
    bulkTimer = setTimeout(() => { confirmingBulk.value = false }, 4000)
    return
  }
  confirmingBulk.value = false
  bulkDeleting.value = true
  const targets = [...failedShown.value]
  let done = 0
  try {
    for (const r of targets) {
      try { await $fetch(`/api/runs/${r.id}`, { method: 'DELETE' as any }); done++ }
      catch { /* keep going; report the total at the end */ }
    }
    await refresh()
    toast.add({ title: `Deleted ${done} of ${targets.length} failed run(s)`, color: done === targets.length ? 'success' : 'warning' })
  } finally {
    bulkDeleting.value = false
  }
}
</script>

<template>
  <div class="h-full flex flex-col">
    <PageHeader title="Runs">
      <template #trailing>
        <span class="t-small text-meta font-normal">{{ headerCount }}</span>
      </template>
      <template #right>
        <UButton
          v-if="failedShown.length"
          size="xs" :variant="confirmingBulk ? 'solid' : 'ghost'" :color="confirmingBulk ? 'error' : 'neutral'"
          icon="i-lucide-trash-2" :loading="bulkDeleting"
          :label="confirmingBulk ? `Delete ${failedShown.length} failed — confirm` : `Delete ${failedShown.length} failed`"
          @click="deleteFailed"
        />
      </template>
    </PageHeader>

    <!-- A list for scanning and the selected run beside it. This was a live-run
         card stack over an eight-column table whose Actions column took a
         quarter of the width on every row. -->
    <div class="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[24rem_minmax(0,1fr)]">
      <div class="min-h-0 flex flex-col runs-pane" :class="{ 'hidden lg:flex': selectedId }">
        <div class="shrink-0 p-3 space-y-2" style="border-bottom: 0.5px solid var(--border-default);">
          <div class="flex items-center gap-2">
            <nav class="segmented w-full" aria-label="Show">
              <button
                v-for="v in VIEWS" :key="v.key"
                class="segmented__item focus-ring" :class="{ 'segmented__item--on': view === v.key }"
                :aria-pressed="view === v.key" @click="view = v.key"
              >{{ v.label }}</button>
            </nav>
          </div>
          <div class="flex items-center gap-2">
            <input v-model="filter" placeholder="Filter by ticket, workflow, product or person" class="field-input t-small flex-1 min-w-0" aria-label="Filter runs" />
            <label class="t-small text-label flex items-center gap-1.5 shrink-0"><input v-model="mine" type="checkbox" /> Mine</label>
          </div>
          <UButton v-if="parent" size="xs" variant="soft" color="neutral" icon="i-lucide-x" :label="`Children of ${parent.slice(0, 8)}`" @click="() => { router.replace({ query: { ...route.query, parent: undefined } }) }" />
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto" aria-live="polite">
          <div v-if="loadError" class="run-row">
            <span class="t-small flex-1" style="color: var(--error);">{{ loadError }}</span>
            <UButton size="xs" variant="soft" label="Retry" @click="refresh" />
          </div>
          <div v-else-if="!loaded" class="p-3 space-y-2" aria-busy="true"><SkeletonCard v-for="i in 3" :key="i" /></div>
          <p v-else-if="!runs.length" class="p-4 t-ui text-label">
            No runs yet. Start one from <NuxtLink to="/" class="underline">Home</NuxtLink> or a <NuxtLink to="/workflows" class="underline">workflow</NuxtLink>.
          </p>
          <p v-else-if="!shown.length" class="p-4 t-ui text-label">No runs match these filters.</p>
          <button
            v-for="r in shown" v-else :key="r.id"
            class="run-row focus-ring" :class="{ 'run-row--on': r.id === selectedId }"
            data-testid="run-history-row"
            :aria-current="r.id === selectedId ? 'true' : undefined"
            :title="r.error || undefined"
            @click="select(r.id)"
          >
            <span class="flex items-baseline gap-2 min-w-0">
              <span class="truncate font-medium flex-1 min-w-0"><span v-if="r.ticketKey" class="font-mono mr-1.5">{{ r.ticketKey }}</span><span class="font-normal">{{ headline(r) }}</span></span>
              <StatusLabel :status="r.status" :label="waitingOnMe(r) ? 'Yours' : undefined" class="shrink-0" />
            </span>
            <span class="t-small text-label truncate block">
              {{ whereNow(r) }} · <span data-testid="run-history-count">{{ stepsDone(r) }} of {{ r.steps.length }}</span>
              <template v-if="r.ci"> · <span :style="{ color: r.ci.status === 'failing' ? 'var(--error)' : r.ci.status === 'passing' ? 'var(--success)' : undefined }">CI {{ r.ci.status }}</span></template>
            </span>
            <RunProgressBar :steps="r.steps" class="mt-1.5" data-testid="run-history-bar" />
          </button>
        </div>
      </div>

      <div class="min-h-0 flex flex-col" :class="{ 'hidden lg:flex': !selectedId }">
        <template v-if="selected">
          <!-- The toolbar owns the run's actions; they were five buttons on every row. -->
          <div class="shrink-0 flex items-center gap-1 px-4 py-2" style="border-bottom: 0.5px solid var(--border-default);">
            <UButton class="lg:hidden" size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-left" label="Runs" @click="select(null)" />
            <span class="t-small text-label ml-1" :title="RUN_DURATION_HINT">{{ duration(selected) }} run time · started {{ new Date(selected.startedAt).toLocaleString() }}</span>
            <span class="flex-1" />
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-external-link" label="Open run page" :to="`/runs/${selected.id}`" />
            <UButton v-if="canRestart(selected)" size="xs" variant="ghost" color="neutral" icon="i-lucide-rotate-ccw" label="Restart" :loading="busy === selected.id" @click="act(selected, 'restart', { stepId: restartPoint(selected) })" />
            <!-- Stop, Resume and Clone are the run header's, inside the stack below. -->
            <UButton
              v-if="canDelete(selected)"
              size="xs" :variant="confirmingDelete === selected.id ? 'solid' : 'ghost'" :color="confirmingDelete === selected.id ? 'error' : 'neutral'"
              icon="i-lucide-trash-2" :label="confirmingDelete === selected.id ? 'Confirm delete' : undefined"
              :title="'Delete run and its evidence'"
              :aria-label="`Delete run ${selected.ticketKey || selected.workflowName} started ${new Date(selected.startedAt).toLocaleString()}, and its evidence`"
              :loading="busy === selected.id" @click="del(selected)"
            />
          </div>
          <div class="flex-1 min-h-0 overflow-y-auto px-6 py-5">
            <div class="max-w-4xl"><RunDetailPane :id="selected.id" :key="selected.id" @changed="refresh" /></div>
          </div>
        </template>
        <p v-else-if="loaded && shown.length" class="p-6 t-ui text-label">Choose a run on the left.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Five views across the 24rem list pane: share the width instead of padding each. */
.runs-pane .segmented > .segmented__item { flex: 1; padding-inline: 6px; text-align: center; }
.runs-pane {
  border-right: 0.5px solid var(--border-default);
  background: var(--surface-raised);
}
.run-row {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 14px;
  font-size: 13px;
  color: var(--text-primary);
  border-bottom: 0.5px solid var(--border-default);
}
.run-row:hover { background: var(--surface-hover); }
.run-row--on, .run-row--on:hover { background: var(--accent-muted); }
</style>
