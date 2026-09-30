<script setup lang="ts">
import type { NotificationItem } from '~~/shared/types/notification'

/**
 * Every decision waiting on a person, in one place, with what they need to take
 * it beside it.
 *
 * The decisions themselves were already answerable — a gate on its run page, a
 * tool prompt in the chat that raised it — but each lived where it was raised.
 * Finding them meant opening every paused run to learn what it wanted, and a
 * /cli prompt in a background tab was invisible until it denied itself. The
 * list here is the index; the pane beside it is the same controls the run page
 * and the chat use, so a decision taken here is the same decision.
 */
useHead({ title: 'Notifications | Agent Manager' })
const { items, loaded, error, fetchAll } = useNotifications()
const route = useRoute()
const router = useRouter()

onMounted(fetchAll)
// Faster than the default: a permission prompt has five minutes to live.
useAutoRefresh(fetchAll, { interval: 10_000 })

const mine = computed(() => items.value.filter(n => n.mine))
const others = computed(() => items.value.filter(n => !n.mine))

/** The selection is in the URL, so a decision can be linked to someone. */
const selectedId = computed(() => (route.query.item as string | undefined) ?? null)
const selected = computed(() => items.value.find(n => n.id === selectedId.value) ?? null)
function select(id: string | null) {
  router.replace({ query: { ...route.query, item: id ?? undefined } })
}
// Open the first thing that is mine when nothing is chosen, or when the chosen
// item has gone (decided here, elsewhere, or expired). A link to a decision
// already taken keeps its id in the URL and says so, rather than silently
// showing a different one.
const vanished = ref<string | null>(null)
watch([items, loaded], () => {
  if (!loaded.value) return
  if (selectedId.value && !selected.value) {
    if (vanished.value !== selectedId.value) vanished.value = selectedId.value
    return
  }
  // Only where the decision can sit beside the list: on a phone, opening one
  // unasked would hide the list the person came to read.
  if (!selectedId.value && mine.value[0] && import.meta.client && window.matchMedia('(min-width: 1024px)').matches) select(mine.value[0].id)
}, { immediate: true })

/** After a decision: refresh, then move to the next one that is mine. */
async function decided() {
  const before = selectedId.value
  await fetchAll()
  const next = mine.value.find(n => n.id !== before) ?? null
  vanished.value = null
  select(next?.id ?? null)
}

const icon = (n: NotificationItem) =>
  n.kind === 'permission' ? 'i-lucide-terminal-square' : n.review ? 'i-lucide-gavel' : 'i-lucide-hand'
const kindLabel = (n: NotificationItem) =>
  n.kind === 'permission' ? 'Tool permission' : n.review ? 'Review' : 'Gate'

/** The ask without the title the row already leads with, cut to its first sentence. */
const askLine = (n: NotificationItem) => {
  let a = n.ask
  if (a.startsWith(`${n.title}: `)) a = a.slice(n.title.length + 2)
  const stop = a.search(/\.\s/)
  return stop > 0 ? a.slice(0, stop + 1) : a
}
/** Ticket keys are data and read in mono; a prompt's first line is prose. */
const isKey = (t: string) => /^[A-Z][A-Z0-9]+-\d+$/.test(t)

// Ticks the wait figures and the prompt countdowns without refetching.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })

const shortWait = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}
/** Same calibration as the dashboard's queue. */
const waitTier = (n: NotificationItem) => {
  const ms = now.value - n.askedAt
  return ms >= 4 * 3_600_000 ? 'critical' : ms >= 3_600_000 ? 'high' : ms >= 900_000 ? 'warm' : 'cool'
}
</script>

<template>
  <div class="h-full flex flex-col">
    <PageHeader title="Notifications">
      <template #trailing>
        <span class="t-small text-meta font-normal">{{ mine.length }}</span>
      </template>
    </PageHeader>

    <!-- A split view: a scannable list and the decision beside it. The list
         used to sit in a padded column of bordered cards, each repeating its
         ticket key twice above a three-line ask. -->
    <div class="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[23rem_minmax(0,1fr)]">
      <div class="min-h-0 overflow-y-auto inbox-pane" :class="{ 'hidden lg:block': selectedId }">
        <!-- A failed poll keeps the list it had: an empty inbox that is empty
             because the API is down must not read as an all-clear. -->
        <div v-if="error" class="inbox-row">
          <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0 mt-0.5" style="color: var(--error);" />
          <span class="flex-1 t-small" style="color: var(--error);">Could not refresh, so this list may be out of date.</span>
          <button class="t-small underline focus-ring shrink-0" style="color: var(--error);" @click="fetchAll">Retry</button>
        </div>

        <div v-if="!loaded" class="p-4 space-y-2"><SkeletonCard v-for="i in 3" :key="i" /></div>
        <div v-else-if="!items.length && !error" class="flex flex-col items-center justify-center py-16 space-y-3">
          <UIcon name="i-lucide-inbox" class="size-8 text-meta" />
          <p class="t-ui text-label">Nothing needs a decision from you.</p>
        </div>

        <template v-else>
          <section v-for="group in [{ key: 'mine', label: 'Yours to decide', list: mine }, { key: 'others', label: 'Someone else\'s', list: others }]" :key="group.key">
            <template v-if="group.list.length">
              <h2 class="inbox-heading">{{ group.label }} <span class="font-normal">{{ group.list.length }}</span></h2>
              <ul>
                <li v-for="n in group.list" :key="n.id">
                  <button
                    class="inbox-row inbox-row--button focus-ring"
                    :class="{ 'inbox-row--selected': n.id === selectedId }"
                    :aria-current="n.id === selectedId ? 'true' : undefined"
                    :aria-label="`${kindLabel(n)} — ${n.title}: ${n.ask}`"
                    @click="select(n.id)"
                  >
                    <UIcon
                      :name="icon(n)" class="size-4 shrink-0 mt-0.5"
                      :style="{ color: n.kind === 'permission' ? 'var(--accent)' : 'var(--warning)' }"
                    />
                    <span class="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span class="flex items-baseline gap-2 min-w-0">
                        <span class="truncate font-medium" :class="{ 'font-mono': isKey(n.title) }">{{ n.title }}</span>
                        <span
                          class="t-small tabular-nums ml-auto shrink-0"
                          :style="waitTier(n) === 'critical' ? { color: 'var(--warning)', fontWeight: 600 } : { color: 'var(--text-tertiary)' }"
                          :title="`Waiting ${shortWait(now - n.askedAt)}`"
                        >{{ shortWait(now - n.askedAt) }}</span>
                      </span>
                      <span class="t-small text-label line-clamp-2">
                        {{ kindLabel(n) }}<template v-if="n.kind === 'gate' && n.role && !n.mine"> for {{ n.role }}</template> · {{ askLine(n) }}
                      </span>
                    </span>
                  </button>
                </li>
              </ul>
            </template>
          </section>
        </template>
      </div>

      <!-- The decision. Below `lg` it replaces the list rather than stacking under it. -->
      <div class="min-h-0 overflow-y-auto px-4 sm:px-6 py-5 flex flex-col" :class="{ 'hidden lg:flex': !selectedId }">
        <UButton class="lg:hidden mb-3 self-start" size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-left" label="Notifications" @click="select(null)" />
        <!-- A gate lays itself out across the pane, with its answer bar at the bottom. -->
        <div :class="selected?.kind === 'gate' ? 'flex-1 flex flex-col' : 'max-w-4xl'">
          <NotificationRunDetail v-if="selected?.kind === 'gate'" :key="selected.id" :item="selected" @decided="decided" />
          <NotificationPermissionDetail v-else-if="selected?.kind === 'permission'" :key="selected.id" :item="selected" @decided="decided" />
          <div v-else-if="vanished && loaded" class="group-card space-y-2">
            <p class="t-head" style="color: var(--text-primary);">No longer waiting</p>
            <p class="t-ui text-label">That decision was taken, or the prompt timed out, before you got to it.</p>
            <UButton v-if="mine[0]" size="sm" variant="soft" label="Next decision" @click="vanished = null; select(mine[0].id)" />
          </div>
          <p v-else-if="loaded && items.length" class="t-ui text-label py-4">Choose a decision on the left.</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inbox-pane {
  border-right: 0.5px solid var(--border-default);
  background: var(--surface-raised);
}
.inbox-heading {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 10px 16px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  background: color-mix(in srgb, var(--surface-raised) 90%, transparent);
  backdrop-filter: blur(12px);
}
.inbox-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 10px 16px;
  text-align: left;
  font-size: 13px;
  color: var(--text-primary);
  border-bottom: 0.5px solid var(--border-default);
}
.inbox-row--button:hover { background: var(--surface-hover); }
.inbox-row--selected, .inbox-row--selected:hover { background: var(--accent-muted); }
</style>
