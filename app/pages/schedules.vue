<script setup lang="ts">
import type { ScheduleRow } from '~/composables/useSchedules'

/**
 * Every schedule on this instance, across all workflows.
 *
 * A workflow's own Schedule tab is where a schedule is usually created, next
 * to the thing it runs. This page is the cross-workflow view: what fires
 * tonight, and what happened last night. Both read the same store, so they
 * cannot disagree.
 */
const { schedules, loading, error, firing, fetchAll, setEnabled, fire, remove } = useSchedules()
const { workflows, fetchAll: fetchWorkflows } = useWorkflows()
const toast = useToast()

const showModal = ref(false)
/** The schedule being edited, or null when creating. */
const editing = ref<ScheduleRow | null>(null)

onMounted(async () => {
  await Promise.all([fetchAll(), fetchWorkflows()])
})

function workflowName(slug: string): string {
  return workflows.value.find(w => w.slug === slug)?.name || slug
}

/** Only once the list has arrived: an empty list means "not fetched yet", and
 *  accusing every schedule of pointing at nothing during the first paint is
 *  worse than saying nothing. */
function workflowMissing(slug: string): boolean {
  return !!workflows.value.length && !workflows.value.some(w => w.slug === slug)
}

function openCreate() {
  editing.value = null
  showModal.value = true
}

function openEdit(schedule: ScheduleRow) {
  editing.value = schedule
  showModal.value = true
}

async function onToggleEnabled(schedule: ScheduleRow, enabled: boolean) {
  try {
    await setEnabled(schedule, enabled)
  } catch (e: any) {
    toast.add({ title: 'Could not change it', description: e?.data?.message || e?.message, color: 'error' })
    await fetchAll()
  }
}

async function onFire(schedule: ScheduleRow) {
  try {
    const result = await fire(schedule.id)
    if (result.lastOutcome === 'started') {
      toast.add({ title: 'Run started', description: result.lastRunId, color: 'success' })
    } else {
      toast.add({
        title: result.lastOutcome === 'skipped' ? 'Skipped' : 'Could not start it',
        description: result.lastDetail,
        color: result.lastOutcome === 'skipped' ? 'warning' : 'error',
      })
    }
  } catch (e: any) {
    toast.add({ title: 'Could not fire it', description: e?.data?.message || e?.message, color: 'error' })
  }
}

async function onDelete(schedule: ScheduleRow) {
  if (!confirm(`Delete the schedule "${schedule.name}"? Runs it already started are kept.`)) return
  try {
    await remove(schedule.id)
    toast.add({ title: 'Schedule deleted', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Could not delete it', description: e?.data?.message || e?.message, color: 'error' })
  }
}
</script>

<template>
  <div>
    <PageHeader title="Schedules">
      <template #trailing>
        <span class="text-[12px] text-meta">{{ schedules.length }}</span>
      </template>
      <template #right>
        <UButton label="New Schedule" icon="i-lucide-plus" size="sm" @click="openCreate" />
      </template>
    </PageHeader>

    <div class="px-6 py-4">
      <p class="text-[13px] mb-4 leading-relaxed text-label">
        Starts a workflow run on a cron expression, with its inputs stated up front. A schedule
        works in its own directory unless you point it at a checkout. A fire missed while the
        server was down does not replay. You can also schedule a workflow from its own page.
      </p>

      <div
        v-if="error"
        class="rounded-xl px-4 py-3 mb-4 flex items-start gap-3"
        style="background: rgba(248, 113, 113, 0.06); border: 1px solid rgba(248, 113, 113, 0.12);"
      >
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0 mt-0.5" style="color: var(--error);" />
        <span class="text-[12px]" style="color: var(--error);">{{ error }}</span>
      </div>

      <div v-if="loading && !schedules.length" class="space-y-3">
        <SkeletonCard v-for="i in 3" :key="i" />
      </div>

      <div v-else-if="!schedules.length" class="flex flex-col items-center justify-center py-16 space-y-3">
        <UIcon name="i-lucide-calendar-clock" class="size-8 text-meta" />
        <p class="text-[13px] text-label">Nothing scheduled yet.</p>
        <UButton label="New Schedule" icon="i-lucide-plus" size="sm" @click="openCreate" />
      </div>

      <div v-else class="space-y-3">
        <ScheduleCard
          v-for="schedule in schedules"
          :key="schedule.id"
          :schedule="schedule"
          :workflow-name="workflowName(schedule.workflowSlug)"
          :workflow-missing="workflowMissing(schedule.workflowSlug)"
          :firing="firing[schedule.id]"
          @fire="onFire(schedule)"
          @edit="openEdit(schedule)"
          @delete="onDelete(schedule)"
          @update:enabled="onToggleEnabled(schedule, $event)"
        />
      </div>
    </div>

    <ScheduleFormModal
      :open="showModal"
      :schedule="editing"
      :workflows="workflows"
      @update:open="showModal = $event"
    />
  </div>
</template>
