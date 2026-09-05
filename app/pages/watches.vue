<script setup lang="ts">
import type { Watch, TicketState, TicketDisposition } from '~~/shared/types/watch'

const { watches, loading, error, states, polling, fetchAll, save, setEnabled, fetchState, poll, clearEscalation, remove } = useWatches()
const { workflows, fetchAll: fetchWorkflows } = useWorkflows()
const toast = useToast()

const expanded = ref<Record<string, boolean>>({})
const showCreateModal = ref(false)
const creating = ref(false)

const form = reactive({
  name: '',
  workflowSlug: undefined as string | undefined,
  intervalSeconds: 300,
  maxConcurrentRuns: 1,
  dailyDispatchCap: 20,
  query: '',
  projectDir: '',
  autoRun: false,
})

onMounted(async () => {
  await Promise.all([fetchAll(), fetchWorkflows()])
  // Counts and "escalated tickets first" need every watch's state up front,
  // not gated behind an expand click — an escalated ticket must be visible
  // without the operator guessing which card to open.
  await Promise.all(watches.value.map(w => fetchState(w.id).catch(() => {})))
  // Auto-expand any watch that already has an escalation waiting.
  for (const w of watches.value) {
    if (escalatedCount(w.id) > 0) expanded.value[w.id] = true
  }
})

const workflowOptions = computed(() =>
  workflows.value.map(w => ({ value: w.slug, label: w.name }))
)

function workflowName(slug: string): string {
  return workflows.value.find(w => w.slug === slug)?.name || slug
}

const DISPOSITION_ORDER: TicketDisposition[] = ['escalated', 'failed', 'dispatched', 'new', 'done']

const DISPOSITION_COLOR: Record<TicketDisposition, string> = {
  escalated: 'var(--error, #ef4444)',
  failed: 'var(--warning, #f59e0b)',
  dispatched: 'var(--info, #3b82f6)',
  new: 'var(--text-disabled, #9ca3af)',
  done: 'var(--success, #22c55e)',
}

function ticketsFor(watchId: string): TicketState[] {
  return Object.values(states.value[watchId] || {})
}

function countsFor(watchId: string): Record<TicketDisposition, number> {
  const counts: Record<TicketDisposition, number> = { new: 0, dispatched: 0, done: 0, failed: 0, escalated: 0 }
  for (const t of ticketsFor(watchId)) counts[t.disposition]++
  return counts
}

function escalatedCount(watchId: string): number {
  return countsFor(watchId).escalated
}

/** Escalated tickets first, then the rest of `DISPOSITION_ORDER`, newest
 *  update first within a group — the ordering the whole page exists to get right. */
function groupedTickets(watchId: string): { disposition: TicketDisposition, tickets: TicketState[] }[] {
  const all = ticketsFor(watchId)
  return DISPOSITION_ORDER
    .map(disposition => ({
      disposition,
      tickets: all.filter(t => t.disposition === disposition).sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .filter(g => g.tickets.length > 0)
}

/** Watches with an escalation waiting sort to the top — the list itself
 *  must not require scrolling past healthy watches to find the one that needs attention. */
const sortedWatches = computed(() => {
  return [...watches.value].sort((a, b) => escalatedCount(b.id) - escalatedCount(a.id))
})

function toggleExpanded(watchId: string) {
  expanded.value[watchId] = !expanded.value[watchId]
}

async function onToggleEnabled(watch: Watch, enabled: boolean) {
  try {
    await setEnabled(watch, enabled)
    toast.add({ title: enabled ? 'Watch enabled' : 'Watch disabled', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Failed to update watch', description: e?.data?.message || e?.message, color: 'error' })
  }
}

async function onPoll(watch: Watch) {
  try {
    const result = await poll(watch.id)
    toast.add({
      title: 'Poll complete',
      description: `dispatched ${result.dispatched.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`,
      color: result.failed.length ? 'warning' : 'success',
    })
    expanded.value[watch.id] = true
  } catch (e: any) {
    toast.add({ title: 'Poll failed', description: e?.data?.message || e?.message, color: 'error' })
  }
}

async function onClearEscalation(watch: Watch, key: string) {
  try {
    await clearEscalation(watch.id, key)
    toast.add({ title: `${key} cleared`, description: 'Eligible for a fresh attempt next cycle.', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Failed to clear escalation', description: e?.data?.message || e?.message, color: 'error' })
  }
}

/** Deleting a watch also deletes its ticket state (including any escalated
 *  tickets) — see the DELETE route's docstring for why. The confirm makes
 *  that explicit up front since it can't be undone; the toast reports what
 *  actually happened rather than assuming. */
async function onDelete(watch: Watch) {
  const confirmed = confirm(
    `Delete watch "${watch.name}"? This also deletes its ticket state, including any escalated tickets. This cannot be undone.`,
  )
  if (!confirmed) return
  try {
    const result = await remove(watch.id)
    toast.add({
      title: 'Watch deleted',
      description: result.stateDeleted ? 'Ticket state deleted too.' : 'No ticket state existed for this watch.',
      color: 'success',
    })
  } catch (e: any) {
    toast.add({ title: 'Failed to delete watch', description: e?.data?.message || e?.message, color: 'error' })
  }
}

function resetForm() {
  form.name = ''
  form.workflowSlug = undefined
  form.intervalSeconds = 300
  form.maxConcurrentRuns = 1
  form.dailyDispatchCap = 20
  form.query = ''
  form.projectDir = ''
  form.autoRun = false
}

async function onCreate() {
  if (!form.name.trim() || !form.workflowSlug) return
  creating.value = true
  try {
    const watch = await save({
      name: form.name.trim(),
      workflowSlug: form.workflowSlug,
      intervalSeconds: form.intervalSeconds,
      maxConcurrentRuns: form.maxConcurrentRuns,
      dailyDispatchCap: form.dailyDispatchCap,
      query: form.query.trim() || undefined,
      projectDir: form.projectDir.trim() || undefined,
      autoRun: form.autoRun,
    })
    await fetchState(watch.id)
    showCreateModal.value = false
    resetForm()
    toast.add({ title: 'Watch created', description: 'New watches start disabled — enable it once you have seen it behave.', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Failed to create watch', description: e?.data?.message || e?.message, color: 'error' })
  } finally {
    creating.value = false
  }
}

function relativeTime(ms: number): string {
  const secs = Math.round((Date.now() - ms) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}
</script>

<template>
  <div>
    <PageHeader title="Watches">
      <template #trailing>
        <span class="text-[12px] text-meta">{{ watches.length }}</span>
      </template>
      <template #right>
        <UButton label="New Watch" icon="i-lucide-plus" size="sm" @click="() => { showCreateModal = true }" />
      </template>
    </PageHeader>

    <div class="px-6 py-4">
      <p class="text-[13px] mb-4 leading-relaxed text-label">
        Polls a ticket source and starts a workflow run per new ticket. Three failed
        attempts and a ticket is escalated and permanently skipped — it never blocks the rest of the queue.
      </p>

      <!-- Error state -->
      <div
        v-if="error"
        class="rounded-xl px-4 py-3 mb-4 flex items-start gap-3"
        style="background: rgba(248, 113, 113, 0.06); border: 1px solid rgba(248, 113, 113, 0.12);"
      >
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0 mt-0.5" style="color: var(--error);" />
        <span class="text-[12px]" style="color: var(--error);">{{ error }}</span>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="space-y-3">
        <SkeletonCard v-for="i in 3" :key="i" />
      </div>

      <!-- Empty state -->
      <div v-else-if="!watches.length" class="flex flex-col items-center justify-center py-16 space-y-3">
        <UIcon name="i-lucide-eye" class="size-8 text-meta" />
        <p class="text-[13px] text-label">No watches configured yet.</p>
        <UButton label="New Watch" icon="i-lucide-plus" size="sm" @click="() => { showCreateModal = true }" />
      </div>

      <!-- Watch list -->
      <div v-else class="space-y-3">
        <div
          v-for="watch in sortedWatches"
          :key="watch.id"
          class="rounded-lg bg-card border border-subtle overflow-hidden"
          :style="escalatedCount(watch.id) > 0 ? 'border-color: rgba(239, 68, 68, 0.35);' : ''"
        >
          <div class="p-4 flex items-start gap-3">
            <button class="flex-1 min-w-0 text-left flex items-start gap-3" @click="toggleExpanded(watch.id)">
              <UIcon
                :name="expanded[watch.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                class="size-4 shrink-0 mt-0.5 text-meta"
              />
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-[13px] font-medium">{{ watch.name }}</span>
                  <span class="text-[11px] font-mono text-meta">{{ workflowName(watch.workflowSlug) }}</span>
                  <span
                    v-if="escalatedCount(watch.id) > 0"
                    class="text-[10px] font-mono px-1.5 py-0.5 rounded"
                    style="background: rgba(239, 68, 68, 0.1); color: var(--error);"
                  >
                    {{ escalatedCount(watch.id) }} escalated
                  </span>
                </div>
                <div class="flex items-center gap-3 mt-1 text-[11px] text-meta font-mono">
                  <span>every {{ watch.intervalSeconds }}s</span>
                  <span v-for="d in DISPOSITION_ORDER" :key="d" :style="{ color: countsFor(watch.id)[d] ? DISPOSITION_COLOR[d] : 'var(--text-disabled)' }">
                    {{ countsFor(watch.id)[d] }} {{ d }}
                  </span>
                </div>
              </div>
            </button>

            <div class="flex items-center gap-3 shrink-0">
              <UButton
                label="Poll now"
                icon="i-lucide-refresh-cw"
                size="xs"
                variant="ghost"
                color="neutral"
                :loading="polling[watch.id]"
                @click="onPoll(watch)"
              />
              <label class="field-toggle" :title="watch.enabled ? 'Enabled' : 'Disabled'">
                <input
                  type="checkbox"
                  :checked="watch.enabled"
                  @change="onToggleEnabled(watch, ($event.target as HTMLInputElement).checked)"
                >
                <span class="field-toggle__track">
                  <span class="field-toggle__thumb" />
                </span>
              </label>
              <UButton
                icon="i-lucide-trash-2"
                size="xs"
                variant="ghost"
                color="error"
                title="Delete watch"
                @click="onDelete(watch)"
              />
            </div>
          </div>

          <!-- Expanded: tickets grouped by disposition, escalated first -->
          <div v-if="expanded[watch.id]" class="border-t border-subtle px-4 py-3 space-y-3" style="border-color: var(--border-subtle);">
            <div v-if="!ticketsFor(watch.id).length" class="text-[12px] text-label">
              No tickets seen yet for this watch.
            </div>
            <div v-for="group in groupedTickets(watch.id)" :key="group.disposition" class="space-y-1.5">
              <p class="text-[10px] font-mono uppercase tracking-wide" :style="{ color: DISPOSITION_COLOR[group.disposition] }">
                {{ group.disposition }} ({{ group.tickets.length }})
              </p>
              <div
                v-for="ticket in group.tickets"
                :key="ticket.key"
                class="rounded-md px-3 py-2 text-[12px]"
                :style="group.disposition === 'escalated'
                  ? 'background: rgba(239, 68, 68, 0.06); border: 1px solid rgba(239, 68, 68, 0.18);'
                  : 'background: var(--surface-base); border: 1px solid var(--border-subtle);'"
              >
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-mono font-medium">{{ ticket.key }}</span>
                  <span class="text-[10px] text-meta">attempts {{ ticket.attempts }}</span>
                  <span v-if="ticket.lastRunId" class="text-[10px] font-mono text-meta">run {{ ticket.lastRunId }}</span>
                  <span class="text-[10px] text-meta ml-auto">{{ relativeTime(ticket.updatedAt) }}</span>
                  <UButton
                    v-if="ticket.disposition === 'escalated'"
                    label="Clear escalation"
                    size="xs"
                    color="error"
                    variant="soft"
                    @click="onClearEscalation(watch, ticket.key)"
                  />
                </div>
                <p v-if="ticket.lastError" class="mt-1 text-[11px]" style="color: var(--error);">
                  {{ ticket.lastError }}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Create modal -->
    <UModal v-model:open="showCreateModal">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">New Watch</h3>
          <p class="text-[12px] text-label">
            New watches always start disabled — enable it explicitly once you've watched it behave against a real cycle.
          </p>
          <form class="space-y-3" @submit.prevent="onCreate">
            <div class="field-group">
              <label class="field-label">Name</label>
              <input v-model="form.name" placeholder="e.g. CSUP triage" class="field-input w-full" required>
            </div>
            <div class="field-group">
              <label class="field-label">Workflow</label>
              <USelectDropdown v-model="form.workflowSlug" :options="workflowOptions" placeholder="Select a workflow..." />
            </div>
            <div class="grid grid-cols-3 gap-3">
              <div class="field-group">
                <label class="field-label">Interval (s)</label>
                <input v-model.number="form.intervalSeconds" type="number" min="1" class="field-input w-full">
              </div>
              <div class="field-group">
                <label class="field-label">Max concurrent</label>
                <input v-model.number="form.maxConcurrentRuns" type="number" min="1" class="field-input w-full">
              </div>
              <div class="field-group">
                <label class="field-label">Daily cap</label>
                <input v-model.number="form.dailyDispatchCap" type="number" min="1" class="field-input w-full">
              </div>
            </div>
            <div class="field-group">
              <label class="field-label">
                Query
                <span class="text-[10px] font-normal ml-1" style="color: var(--text-disabled);">optional, source-specific</span>
              </label>
              <input v-model="form.query" placeholder="e.g. a JQL filter" class="field-input w-full">
            </div>
            <div class="field-group">
              <label class="field-label">
                Project folder
                <span class="text-[10px] font-normal ml-1" style="color: var(--text-disabled);">optional</span>
              </label>
              <input v-model="form.projectDir" placeholder="/Users/you/projects/my-app" class="field-input w-full">
            </div>
            <div class="field-group">
              <label class="flex items-center gap-2 cursor-pointer">
                <input v-model="form.autoRun" type="checkbox" class="shrink-0">
                <span class="field-label mb-0">Run dispatched workflows to completion without pausing</span>
              </label>
            </div>
            <div class="flex justify-end gap-2 pt-2">
              <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showCreateModal = false }" />
              <UButton type="submit" label="Create" size="sm" :loading="creating" :disabled="!form.name.trim() || !form.workflowSlug" />
            </div>
          </form>
        </div>
      </template>
    </UModal>
  </div>
</template>
