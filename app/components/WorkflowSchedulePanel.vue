<script setup lang="ts">
import type { WorkflowParameter } from '~/types'
import type { ScheduleRow } from '~/composables/useSchedules'

/**
 * One workflow's schedules, on the workflow's own page.
 *
 * The point of this surface: a cron expression and the thing it runs used to
 * live in two places that knew nothing about each other, so you could not
 * look at a workflow and answer "does this run on its own, and when?".
 */
const props = defineProps<{
  workflowSlug: string
  workflowName: string
  /** The SAVED declaration, passed down rather than looked up - see
   *  ScheduleFormModal's `parameters` prop for why. */
  parameters: WorkflowParameter[]
  /** False when the workflow has no steps: the save route refuses those, so
   *  the button is disabled rather than the 400 being surfaced. */
  schedulable: boolean
  /** The Inputs editor has unsaved changes. Warned about, never blocked. */
  parametersDirty: boolean
}>()

const { loading, error, firing, setEnabled, fire, remove, forWorkflow } = useSchedules()
const toast = useToast()

const rows = forWorkflow(() => props.workflowSlug)

const showModal = ref(false)
const editing = ref<ScheduleRow | null>(null)
/** Set after a create, so the disabled-on-create rule is stated where the new
 *  row is rather than only in a toast that has already gone. */
const justCreated = ref(false)

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
    justCreated.value = false
  } catch (e: any) {
    toast.add({ title: 'Could not change it', description: e?.data?.message || e?.message, color: 'error' })
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
  <div class="p-6 space-y-3">
    <div class="flex items-start justify-between gap-4">
      <p class="text-[13px] leading-relaxed text-label max-w-2xl">
        Starts this workflow on a cron expression, with its inputs stated up front. A schedule
        works in its own directory unless you point it at a checkout, and a fire missed while the
        server was down does not replay.
      </p>
      <UButton
        label="New schedule"
        icon="i-lucide-plus"
        size="sm"
        class="shrink-0"
        :disabled="!schedulable"
        :title="schedulable ? undefined : 'Add a step and save the workflow before scheduling it'"
        @click="openCreate"
      />
    </div>

    <!-- Warned, not blocked: a schedule is checked against the SAVED
         declaration, so an input added but not yet saved cannot be stated on
         one. Gating on the whole page's dirtiness would cry wolf on every
         dragged node, so this watches the declaration only. -->
    <div
      v-if="parametersDirty"
      class="rounded-lg px-3 py-2 text-[12px] flex items-start gap-2"
      style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.16); color: var(--warning);"
    >
      <UIcon name="i-lucide-alert-triangle" class="size-4 shrink-0 mt-0.5" />
      <span>
        This workflow's inputs have unsaved changes. A schedule is checked against the saved
        version, so save the workflow first if you just added an input.
      </span>
    </div>

    <p v-if="error" class="field-error">{{ error }}</p>

    <div
      v-if="justCreated"
      class="rounded-lg px-3 py-2 text-[12px] flex items-start gap-2"
      style="background: var(--accent-muted); border: 1px solid var(--border-subtle);"
    >
      <UIcon name="i-lucide-info" class="size-4 shrink-0 mt-0.5" style="color: var(--accent);" />
      <span>Created disabled. Check the expression and the directory, then turn it on.</span>
    </div>

    <!-- Guarded on an empty list so a save's refetch does not blank rows that
         are already on screen. -->
    <div v-if="loading && !rows.length" class="space-y-3">
      <SkeletonCard v-for="i in 2" :key="i" />
    </div>

    <div v-else-if="!rows.length" class="flex flex-col items-center justify-center py-12 space-y-3">
      <UIcon name="i-lucide-calendar-clock" class="size-8 text-meta" />
      <p class="text-[13px] text-label">This workflow is not scheduled.</p>
      <p class="text-[12px] text-meta max-w-md text-center">
        A schedule starts a run on a cron expression with its inputs stated up front — either in a
        directory of its own, or in a checkout you name.
      </p>
      <UButton
        label="New schedule"
        icon="i-lucide-plus"
        size="sm"
        :disabled="!schedulable"
        :title="schedulable ? undefined : 'Add a step and save the workflow before scheduling it'"
        @click="openCreate"
      />
    </div>

    <div v-else class="space-y-3">
      <!-- No workflow name on these cards: it is the page title. -->
      <ScheduleCard
        v-for="schedule in rows"
        :key="schedule.id"
        :schedule="schedule"
        :firing="firing[schedule.id]"
        @fire="onFire(schedule)"
        @edit="openEdit(schedule)"
        @delete="onDelete(schedule)"
        @update:enabled="onToggleEnabled(schedule, $event)"
      />
    </div>

    <ScheduleFormModal
      :open="showModal"
      :schedule="editing"
      :locked-workflow-slug="workflowSlug"
      :locked-workflow-name="workflowName"
      :parameters="parameters"
      @update:open="showModal = $event"
      @saved="created => { if (created) justCreated = true }"
    />
  </div>
</template>
