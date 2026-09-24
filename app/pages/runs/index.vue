<script setup lang="ts">
import { isLiveStatus, isWaitingOnAPerson, type WorkflowRun } from '~~/shared/types/run'
import { RUN_STATUS_COLOR, runElapsedLabel, runStatusLabel } from '~/utils/runStatus'
import { gateIsMine } from '~~/shared/utils/notifications'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const runs = ref<WorkflowRun[]>([])
const loaded = ref(false)
const loadError = ref<string | null>(null)
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
const parent = computed(() => (typeof route.query.parent === 'string' ? route.query.parent : ''))
const openId = computed({
  get: () => (typeof route.query.open === 'string' ? route.query.open : ''),
  set: v => router.replace({ query: { ...route.query, open: v || undefined } }),
})

/** Group occupancy, so a queued row can say what it is waiting behind rather
 *  than only that it is waiting. Fetched alongside the runs, and only used by
 *  the in-flight section. */
const groups = ref<{ id: string, name: string, inFlight: number, maxConcurrent: number }[]>([])
const loadFor = (r: WorkflowRun) => groups.value.find(g => g.id === (r.group?.trim() || 'default'))

async function refresh() {
  try {
    runs.value = await $fetch<WorkflowRun[]>('/api/runs')
    // Best-effort: a queued row without its group's numbers still says it is
    // waiting, which is the load-bearing half.
    groups.value = await $fetch<typeof groups.value>('/api/workflow-groups').catch(() => groups.value)
    loadError.value = null
  } catch (e: any) {
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

const waitingOnMe = (r: WorkflowRun) => isWaitingOnAPerson(r.status) && gateIsMine(r.question?.role, role.value)
const VIEWS = [
  { value: '', label: 'All' },
  { value: 'waiting', label: 'Waiting on me' },
  { value: 'running', label: 'Running' },
  { value: 'failed', label: 'Failed' },
] as const
const inView = (r: WorkflowRun) =>
  view.value === 'waiting' ? waitingOnMe(r)
  : view.value === 'running' ? isLiveStatus(r.status)
  : view.value === 'failed' ? r.status === 'failed'
  : true
const countOf = (v: string) => runs.value.filter(r => (v === 'waiting' ? waitingOnMe(r) : v === 'running' ? isLiveStatus(r.status) : v === 'failed' ? r.status === 'failed' : true)).length

const shown = computed(() => runs.value.filter(r =>
  (!filter.value || [r.workflowName, r.initialPrompt.split('\n')[0] ?? '', r.startedBy ?? '', r.product?.name ?? '', r.ticketKey ?? ''].some(v => v.toLowerCase().includes(filter.value.toLowerCase())))
  && (!mine.value || r.startedBy === me.value?.login)
  && (!parent.value || r.parentRunId === parent.value)
  && inView(r)))

/** Wide screens open the run beside the list; narrow ones go to its page. */
function select(r: WorkflowRun) {
  if (window.matchMedia('(min-width: 1024px)').matches) openId.value = r.id
  else navigateTo(`/runs/${r.id}`)
}
watch(shown, (list) => {
  if (!openId.value && list[0] && window.matchMedia('(min-width: 1024px)').matches) openId.value = list[0].id
}, { immediate: false })

const title = (r: WorkflowRun) => {
  const first = (r.initialPrompt.split('\n')[0] ?? '').slice(0, 80)
  return r.ticketKey && !first.startsWith(r.ticketKey) ? `${r.ticketKey} · ${first}` : first || r.workflowName
}
/** What a live row is doing right now: the running step, its last tool, how long ago. */
function liveLine(r: WorkflowRun): string {
  if (r.status === 'queued') {
    const g = loadFor(r)
    return g ? `Queued behind ${g.name}: ${g.inFlight} of ${g.maxConcurrent} running` : 'Queued'
  }
  const s = r.steps.find(x => x.status === 'running')
  if (!s) return ''
  const ago = s.lastActivityAt ? `${Math.max(0, Math.round((now.value - s.lastActivityAt) / 1000))}s ago` : ''
  return [s.label, s.lastTool, ago].filter(Boolean).join(' · ')
}

// Execution time from the run clock, and it re-renders because `now` ticks:
// this column read `endedAt - startedAt`, so a run restarted an hour after it
// failed showed that hour as its duration.
const duration = (r: WorkflowRun) => runElapsedLabel(r, now.value)

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
  try {
    await $fetch(`/api/runs/${r.id}`, { method: 'DELETE' as any })
    await refresh()
    if (openId.value === r.id) openId.value = ''
  } catch (e: any) {
    toast.add({ title: 'Failed to delete', description: e.data?.message || e.message, color: 'error' })
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
  <div>
    <PageHeader title="Runs">
      <template #trailing>
        <span class="t-small text-meta">{{ runs.length }}</span>
      </template>
    </PageHeader>

    <div class="page space-y-4">
      <p class="t-ui leading-relaxed text-label">
        Every workflow run, newest first. Select one to see its steps, or filter to what is waiting on you.
      </p>

      <div class="flex flex-wrap gap-2 items-center">
        <button
          v-for="v in VIEWS" :key="v.value"
          class="t-small rounded-full px-3 py-1 focus-ring"
          :style="view === v.value ? 'background: var(--accent-muted); color: var(--text-accent); font-weight: 600;' : 'background: var(--surface-inset); color: var(--text-secondary);'"
          :aria-pressed="view === v.value" @click="view = v.value"
        >{{ v.label }} <span class="tabular-nums">{{ countOf(v.value) }}</span></button>
        <input v-model="filter" placeholder="Filter by ticket, workflow, product or person..." class="field-search max-w-xs" aria-label="Filter runs" />
        <label class="t-small text-label flex items-center gap-1.5"><input v-model="mine" type="checkbox"> Started by me</label>
        <UButton v-if="parent" size="xs" variant="soft" icon="i-lucide-x" :label="`Children of ${parent.slice(0, 8)}`" @click="() => { router.replace({ query: { ...route.query, parent: undefined } }) }" />
        <UButton
          v-if="failedShown.length" size="xs" class="ml-auto"
          :variant="confirmingBulk ? 'solid' : 'soft'" :color="confirmingBulk ? 'error' : 'neutral'"
          icon="i-lucide-trash-2" :loading="bulkDeleting"
          :label="confirmingBulk ? `Delete ${failedShown.length} failed — confirm` : `Delete ${failedShown.length} failed`"
          @click="deleteFailed"
        />
      </div>

      <div
        v-if="loadError"
        class="rounded-xl px-4 py-3 flex items-center gap-3"
        style="background: rgba(248, 113, 113, 0.06); border: 1px solid rgba(248, 113, 113, 0.12);"
      >
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" style="color: var(--error);" />
        <span class="t-small" style="color: var(--error);">{{ loadError }}</span>
        <UButton size="xs" variant="soft" label="Retry" class="ml-auto" @click="refresh" />
      </div>

      <div v-else-if="!loaded" class="space-y-2" aria-busy="true">
        <SkeletonCard v-for="i in 3" :key="i" />
      </div>

      <p v-else-if="!runs.length" class="t-ui text-label">
        No runs yet. Start one with the Run button on a <NuxtLink to="/workflows" class="underline">workflow card</NuxtLink>.
      </p>

      <p v-else-if="!shown.length" class="t-ui text-label">No runs match these filters.</p>

      <div v-else class="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)] items-start">
        <ul class="rounded-xl overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto" style="border: 1px solid var(--border-subtle);" aria-live="polite">
          <li v-for="r in shown" :key="r.id" style="border-top: 1px solid var(--border-subtle);" class="first:border-t-0">
            <button
              class="w-full text-left px-3 py-2.5 space-y-1 focus-ring"
              :style="openId === r.id ? 'background: var(--surface-hover); box-shadow: inset 3px 0 0 var(--accent);' : ''"
              :aria-current="openId === r.id" @click="select(r)"
            >
              <span class="flex items-center gap-2">
                <span class="t-ui font-medium truncate flex-1" style="color: var(--text-primary);" :title="r.initialPrompt">{{ title(r) }}</span>
                <span class="t-small font-mono shrink-0" :style="{ color: RUN_STATUS_COLOR[r.status] }">{{ waitingOnMe(r) ? 'Yours' : runStatusLabel(r.status) }}</span>
              </span>
              <span class="block t-small font-mono text-label truncate">{{ r.workflowName }} · {{ duration(r) }}{{ r.startedBy ? ` · ${r.startedBy}` : '' }}</span>
              <span v-if="liveLine(r)" class="block t-small font-mono truncate" style="color: var(--info);">{{ liveLine(r) }}</span>
              <RunProgressBar :steps="r.steps" />
            </button>
          </li>
        </ul>
        <section class="hidden lg:block min-w-0">
          <template v-if="openId">
            <div class="flex justify-end gap-2 mb-2">
              <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-external-link" label="Open run page" :to="`/runs/${openId}`" />
              <UButton
                v-if="shown.find(r => r.id === openId) && canDelete(shown.find(r => r.id === openId)!)"
                size="xs" variant="ghost" :color="confirmingDelete === openId ? 'error' : 'neutral'"
                :icon="confirmingDelete === openId ? undefined : 'i-lucide-trash-2'"
                :label="confirmingDelete === openId ? 'Confirm delete' : 'Delete'"
                @click="del(shown.find(r => r.id === openId)!)"
              />
            </div>
            <RunDetailPane :id="openId" :key="openId" @changed="refresh" />
          </template>
          <p v-else class="t-ui text-label">Select a run.</p>
        </section>
      </div>
    </div>
  </div>
</template>
