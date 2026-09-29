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
  if (!selectedId.value && mine.value[0]) select(mine.value[0].id)
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
const rail = (n: NotificationItem) => n.kind === 'permission' ? 'var(--accent)' : 'var(--warning)'

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
        <span class="t-small text-meta">{{ mine.length }}</span>
      </template>
      <template #subtitle>
        <p class="t-small text-label">Decisions waiting on you, with what you need to take them.</p>
      </template>
    </PageHeader>

    <div class="flex-1 min-h-0 w-full grid gap-4 page page--wide grid-cols-1 lg:grid-cols-[minmax(20rem,2fr)_minmax(0,3fr)]">
      <!-- The list -->
      <div class="min-h-0 overflow-y-auto space-y-4 pr-1">
        <!-- A failed poll keeps the list it had: an empty inbox that is empty
             because the API is down must not read as an all-clear. -->
        <div v-if="error" class="rounded-lg px-3 py-2 flex items-center gap-3 t-small" style="background: rgba(248,113,113,0.06); border: 1px solid rgba(248,113,113,0.12);">
          <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" style="color: var(--error);" />
          <span style="color: var(--error);">Could not refresh, so this list may be out of date.</span>
          <button class="ml-auto underline focus-ring shrink-0" style="color: var(--error);" @click="fetchAll">Retry</button>
        </div>

        <div v-if="!loaded" class="space-y-2"><SkeletonCard v-for="i in 3" :key="i" /></div>
        <div v-else-if="!items.length && !error" class="flex flex-col items-center justify-center py-16 space-y-3">
          <UIcon name="i-lucide-bell-off" class="size-8 text-meta" />
          <p class="t-ui text-label">Nothing needs a decision from you.</p>
        </div>

        <template v-else>
          <section v-for="group in [{ key: 'mine', label: 'Yours to decide', list: mine }, { key: 'others', label: 'Someone else\'s', list: others }]" :key="group.key">
            <template v-if="group.list.length">
              <h2 class="text-section-label mb-2">{{ group.label }} <span class="text-meta font-normal">{{ group.list.length }}</span></h2>
              <ul class="attn-list">
                <li
                  v-for="n in group.list" :key="n.id"
                  class="inbox-row t-ui"
                  :class="[`attn-row--${waitTier(n)}`, { 'attn-row--mine': n.mine, 'inbox-row--selected': n.id === selectedId }]"
                  :style="{ '--rail': rail(n) }"
                >
                  <span class="attn-rail" aria-hidden="true" />
                  <button
                    class="inbox-body focus-ring"
                    :aria-current="n.id === selectedId ? 'true' : undefined"
                    :aria-label="`${kindLabel(n)} — ${n.title}: ${n.ask}`"
                    @click="select(n.id)"
                  >
                    <span class="flex items-center gap-2 min-w-0">
                      <UIcon :name="icon(n)" class="size-3.5 shrink-0" :style="{ color: rail(n) }" />
                      <span class="attn-key">{{ n.title }}</span>
                      <span class="t-label text-meta shrink-0">{{ kindLabel(n) }}</span>
                      <span v-if="n.kind === 'gate' && n.role && !n.mine" class="t-label text-meta shrink-0">· {{ n.role }}</span>
                      <span class="attn-wait tabular ml-auto shrink-0" :title="`Waiting ${shortWait(now - n.askedAt)}`">{{ shortWait(now - n.askedAt) }}</span>
                    </span>
                    <span class="attn-ask block text-left">{{ n.ask }}</span>
                  </button>
                </li>
              </ul>
            </template>
          </section>
        </template>
      </div>

      <!-- The decision -->
      <div class="min-h-0 overflow-y-auto pr-1">
        <NotificationRunDetail v-if="selected?.kind === 'gate'" :key="selected.id" :item="selected" @decided="decided" />
        <NotificationPermissionDetail v-else-if="selected?.kind === 'permission'" :key="selected.id" :item="selected" @decided="decided" />
        <div v-else-if="vanished && loaded" class="rounded-lg p-4 space-y-2" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
          <p class="t-head" style="color: var(--text-primary);">No longer waiting</p>
          <p class="t-ui text-label">That decision was taken, or the prompt timed out, before you got to it.</p>
          <UButton v-if="mine[0]" size="sm" variant="soft" label="Next decision" @click="vanished = null; select(mine[0].id)" />
        </div>
        <p v-else-if="loaded && items.length" class="t-ui text-label py-4">Choose a decision on the left.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The dashboard's attention row, stacked on two lines: this list sits in a
   side column, where that row's eight tracks do not fit. */
.inbox-row {
  display: grid;
  grid-template-columns: 3px minmax(0, 1fr);
  border-bottom: 1px solid var(--border-subtle);
}
.inbox-row:last-child { border-bottom: 0; }
.inbox-row:hover { background: var(--surface-hover); }
.inbox-row--selected { background: var(--surface-hover); }
.inbox-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 10px;
  text-align: left;
}
</style>
