<script setup lang="ts">
import type { ScheduleRow } from '~/composables/useSchedules'

/**
 * One schedule, as both the global Schedules page and a workflow's own
 * Schedule tab render it.
 *
 * Shared rather than duplicated because this is where every non-obvious
 * decision shows: the unusable-expression chip, the colour-coded outcome, the
 * relative time, the link to the run, and the directory line. It is also the
 * thing an operator reads at 8am after a 2am fire went wrong, so two copies
 * drifting apart is a real cost, not a tidiness one.
 */
const props = defineProps<{
  schedule: ScheduleRow
  /** The workflow's display name. Omitted on the workflow's own page, where it
   *  is the page title and repeating it is noise. Always resolved by the
   *  parent from the live workflow list - never stored on the schedule, which
   *  would go stale the moment the workflow is renamed. */
  workflowName?: string
  /** True when the workflow list is loaded and this slug is not in it. The
   *  parent decides, because a card cannot tell "deleted" from "not fetched
   *  yet" and would accuse a healthy schedule during the first paint. */
  workflowMissing?: boolean
  firing?: boolean
}>()

const emit = defineEmits<{
  fire: []
  edit: []
  delete: []
  'update:enabled': [value: boolean]
}>()

const OUTCOME_COLOR: Record<string, string> = {
  started: 'var(--success, #22c55e)',
  skipped: 'var(--warning, #f59e0b)',
  error: 'var(--error, #ef4444)',
}

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : 'never - check the expression'
const ago = (ms?: number) => {
  if (!ms) return null
  const m = Math.round((Date.now() - ms) / 60000)
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`
}

/** Stated directory, or the derived one named as what it is. Shown because
 *  "it scanned nothing, because it worked in an empty directory of its own"
 *  is the failure a stated directory exists to remove - and an operator
 *  cannot see which of the two they have from anything else on the card. */
const directory = computed(() =>
  props.schedule.projectDir?.trim() ? props.schedule.workspace : 'its own directory')
</script>

<template>
  <div
    class="rounded-lg bg-card border border-subtle p-4 flex items-start gap-3"
    :style="schedule.enabled && !schedule.nextFireAt ? 'border-color: rgba(239, 68, 68, 0.35);' : ''"
    data-testid="schedule-card"
  >
    <div class="flex-1 min-w-0 space-y-1">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[13px] font-medium">{{ schedule.name }}</span>
        <span v-if="workflowName" class="text-[11px] font-mono text-meta">{{ workflowName }}</span>
        <span
          v-if="workflowMissing"
          class="text-[10px] font-mono px-1.5 py-0.5 rounded"
          style="background: rgba(245, 158, 11, 0.1); color: var(--warning);"
          title="The workflow this points at is not on this instance any more. Every fire will fail until it comes back or this schedule is deleted."
        >workflow missing</span>
        <span
          v-if="schedule.enabled && !schedule.nextFireAt"
          class="text-[10px] font-mono px-1.5 py-0.5 rounded"
          style="background: rgba(239, 68, 68, 0.1); color: var(--error);"
        >expression unusable</span>
      </div>

      <div class="flex items-center gap-3 text-[11px] text-meta font-mono flex-wrap">
        <span>{{ schedule.cron }}{{ schedule.timezone ? ` (${schedule.timezone})` : '' }}</span>
        <span v-if="schedule.enabled">next {{ when(schedule.nextFireAt) }}</span>
        <span v-else style="color: var(--text-disabled);">disabled</span>
        <span :title="schedule.workspace">works in {{ directory }}</span>
      </div>

      <div
        v-if="Object.keys(schedule.parameters ?? {}).length"
        class="flex flex-wrap gap-x-3 text-[11px] font-mono text-label"
      >
        <span v-for="(value, name) in schedule.parameters" :key="name">
          <span style="color: var(--text-tertiary);">{{ name }}:</span> {{ value }}
        </span>
      </div>

      <div v-if="schedule.state?.lastOutcome" class="text-[11px] font-mono">
        <span :style="{ color: OUTCOME_COLOR[schedule.state.lastOutcome] }">
          {{ schedule.state.lastOutcome }}
        </span>
        <span class="text-meta ml-1.5">{{ ago(schedule.state.lastFiredAt) }}</span>
        <NuxtLink
          v-if="schedule.state.lastRunId"
          :to="`/runs/${schedule.state.lastRunId}`"
          class="ml-2 underline"
          style="color: var(--accent);"
        >open run</NuxtLink>
        <span v-if="schedule.state.lastDetail" class="text-meta ml-1.5">— {{ schedule.state.lastDetail }}</span>
      </div>
    </div>

    <div class="flex items-center gap-3 shrink-0">
      <UButton
        label="Run now"
        icon="i-lucide-play"
        size="xs"
        variant="ghost"
        color="neutral"
        :loading="firing"
        title="Fire it now, without waiting for the next scheduled time. Works while it is disabled."
        @click="emit('fire')"
      />
      <label class="field-toggle" :title="schedule.enabled ? 'Enabled' : 'Disabled'">
        <input
          type="checkbox"
          :checked="schedule.enabled"
          @change="emit('update:enabled', ($event.target as HTMLInputElement).checked)"
        >
        <span class="field-toggle__track">
          <span class="field-toggle__thumb" />
        </span>
      </label>
      <UButton
        icon="i-lucide-pencil"
        size="xs"
        variant="ghost"
        color="neutral"
        title="Edit schedule"
        @click="emit('edit')"
      />
      <UButton
        icon="i-lucide-trash-2"
        size="xs"
        variant="ghost"
        color="error"
        title="Delete schedule"
        @click="emit('delete')"
      />
    </div>
  </div>
</template>
