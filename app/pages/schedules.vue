<script setup lang="ts">
import type { WorkflowParameter } from '~/types'
import { RESERVED_PARAM_PROJECT_DIR } from '~~/shared/utils/workflowParameters'
import type { ScheduleRow } from '~/composables/useSchedules'

const { schedules, loading, error, firing, fetchAll, save, setEnabled, fire, remove } = useSchedules()
const { workflows, fetchAll: fetchWorkflows } = useWorkflows()
const toast = useToast()

const showModal = ref(false)
const saving = ref(false)
/** The schedule being edited, or null when creating. One form serves both:
 *  the fields are identical, and two of them is how one quietly stops
 *  matching the backend. */
const editing = ref<ScheduleRow | null>(null)
const isEditing = computed(() => editing.value !== null)

const form = reactive({
  name: '',
  workflowSlug: undefined as string | undefined,
  cron: '0 2 * * *',
  timezone: '',
  initialPrompt: '',
  autoRun: true,
  parameters: {} as Record<string, string>,
})

onMounted(async () => {
  await Promise.all([fetchAll(), fetchWorkflows()])
})

const workflowOptions = computed(() => workflows.value.map(w => ({ value: w.slug, label: w.name })))

function workflowName(slug: string): string {
  return workflows.value.find(w => w.slug === slug)?.name || slug
}

/**
 * The selected workflow's declared inputs, minus the reserved one: a scheduled
 * run's directory is derived from its id, so offering a projectDir field here
 * would be offering a setting that does nothing.
 */
const declared = computed<WorkflowParameter[]>(() => {
  const workflow = workflows.value.find(w => w.slug === form.workflowSlug)
  return (workflow?.parameters ?? []).filter(p => p.name !== RESERVED_PARAM_PROJECT_DIR)
})

const unstated = computed(() =>
  declared.value.filter(p => p.required && !(form.parameters[p.name] ?? '').trim()).map(p => p.name))

const canSave = computed(() =>
  !!form.name.trim() && !!form.workflowSlug && !!form.cron.trim()
  && !!form.initialPrompt.trim() && !unstated.value.length)

// Prefill each declared input with its default when the workflow changes, so
// switching workflow does not leave the previous one's values behind.
watch(() => form.workflowSlug, () => {
  const next: Record<string, string> = {}
  for (const param of declared.value) {
    next[param.name] = form.parameters[param.name] ?? param.default ?? ''
  }
  form.parameters = next
})

function openCreate() {
  editing.value = null
  Object.assign(form, {
    name: '', workflowSlug: undefined, cron: '0 2 * * *', timezone: '',
    initialPrompt: '', autoRun: true, parameters: {},
  })
  showModal.value = true
}

function openEdit(schedule: ScheduleRow) {
  editing.value = schedule
  Object.assign(form, {
    name: schedule.name,
    workflowSlug: schedule.workflowSlug,
    cron: schedule.cron,
    timezone: schedule.timezone ?? '',
    initialPrompt: schedule.initialPrompt,
    autoRun: schedule.autoRun,
    parameters: { ...(schedule.parameters ?? {}) },
  })
  showModal.value = true
}

async function onSave() {
  if (!canSave.value) return
  saving.value = true
  try {
    await save({
      ...(editing.value ? { id: editing.value.id } : {}),
      name: form.name.trim(),
      workflowSlug: form.workflowSlug!,
      cron: form.cron.trim(),
      timezone: form.timezone.trim() || undefined,
      initialPrompt: form.initialPrompt.trim(),
      autoRun: form.autoRun,
      parameters: Object.fromEntries(
        Object.entries(form.parameters).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v),
      ),
    })
    showModal.value = false
    toast.add({
      title: isEditing.value ? 'Schedule saved' : 'Schedule created, disabled',
      description: isEditing.value
        ? undefined
        : 'Check what it will do, then enable it. New schedules never fire until you turn them on.',
      color: 'success',
    })
  } catch (e: any) {
    toast.add({ title: 'Could not save', description: e?.data?.message || e?.message, color: 'error' })
  } finally {
    saving.value = false
  }
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
        Starts a workflow run on a cron expression, with its inputs stated up front. Each schedule
        works in its own directory, so it never competes with a run you started by hand. A fire
        missed while the server was down does not replay.
      </p>

      <div
        v-if="error"
        class="rounded-xl px-4 py-3 mb-4 flex items-start gap-3"
        style="background: rgba(248, 113, 113, 0.06); border: 1px solid rgba(248, 113, 113, 0.12);"
      >
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0 mt-0.5" style="color: var(--error);" />
        <span class="text-[12px]" style="color: var(--error);">{{ error }}</span>
      </div>

      <div v-if="loading" class="space-y-3">
        <SkeletonCard v-for="i in 3" :key="i" />
      </div>

      <div v-else-if="!schedules.length" class="flex flex-col items-center justify-center py-16 space-y-3">
        <UIcon name="i-lucide-calendar-clock" class="size-8 text-meta" />
        <p class="text-[13px] text-label">Nothing scheduled yet.</p>
        <UButton label="New Schedule" icon="i-lucide-plus" size="sm" @click="openCreate" />
      </div>

      <div v-else class="space-y-3">
        <div
          v-for="schedule in schedules"
          :key="schedule.id"
          class="rounded-lg bg-card border border-subtle p-4 flex items-start gap-3"
          :style="schedule.enabled && !schedule.nextFireAt ? 'border-color: rgba(239, 68, 68, 0.35);' : ''"
        >
          <div class="flex-1 min-w-0 space-y-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-[13px] font-medium">{{ schedule.name }}</span>
              <span class="text-[11px] font-mono text-meta">{{ workflowName(schedule.workflowSlug) }}</span>
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
              :loading="firing[schedule.id]"
              title="Fire it now, without waiting for the next scheduled time. Works while it is disabled."
              @click="onFire(schedule)"
            />
            <label class="field-toggle" :title="schedule.enabled ? 'Enabled' : 'Disabled'">
              <input
                type="checkbox"
                :checked="schedule.enabled"
                @change="onToggleEnabled(schedule, ($event.target as HTMLInputElement).checked)"
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
              @click="openEdit(schedule)"
            />
            <UButton
              icon="i-lucide-trash-2"
              size="xs"
              variant="ghost"
              color="error"
              title="Delete schedule"
              @click="onDelete(schedule)"
            />
          </div>
        </div>
      </div>
    </div>

    <UModal :open="showModal" @update:open="showModal = $event">
      <template #content>
        <div class="p-6 space-y-4 bg-overlay">
          <h3 class="text-page-title">{{ isEditing ? 'Edit schedule' : 'New schedule' }}</h3>

          <form @submit.prevent="onSave">
            <div class="space-y-4">
              <div class="field-group">
                <label class="field-label">Name</label>
                <input v-model="form.name" placeholder="Nightly security scan" class="field-input w-full">
              </div>

              <div class="field-group">
                <label class="field-label">Workflow</label>
                <USelectDropdown v-model="form.workflowSlug" :options="workflowOptions" placeholder="Pick a workflow" />
              </div>

              <div class="field-group">
                <label class="field-label">Cron expression</label>
                <input v-model="form.cron" placeholder="0 2 * * *" class="field-input w-full font-mono">
                <span class="field-hint">
                  Five fields (minute hour day month weekday), or six to include seconds.
                  <code>0 2 * * *</code> is 2am daily; <code>0 9 * * 1-5</code> is 9am on weekdays.
                  Refused on save if this server cannot parse it.
                </span>
              </div>

              <div class="field-group">
                <label class="field-label">
                  Timezone
                  <span class="text-[10px] font-normal ml-1" style="color: var(--text-disabled);">optional</span>
                </label>
                <input v-model="form.timezone" placeholder="Asia/Kolkata" class="field-input w-full">
                <span class="field-hint">An IANA zone name. Empty means this server's local time.</span>
              </div>

              <div class="field-group">
                <label class="field-label">Initial prompt</label>
                <textarea
                  v-model="form.initialPrompt"
                  rows="3"
                  placeholder="Scan the repository for OWASP top ten issues"
                  class="field-input w-full resize-none"
                />
              </div>

              <div v-for="param in declared" :key="param.name" class="field-group">
                <label class="field-label">
                  {{ param.name }}
                  <span
                    v-if="!param.required"
                    class="text-[10px] font-normal ml-1"
                    style="color: var(--text-disabled);"
                  >optional</span>
                </label>
                <input
                  v-model="form.parameters[param.name]"
                  :placeholder="param.default || ''"
                  class="field-input w-full"
                >
                <span v-if="param.description" class="field-hint">{{ param.description }}</span>
              </div>

              <div class="field-group">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input v-model="form.autoRun" type="checkbox" class="shrink-0">
                  <span class="field-label mb-0">Run to completion without pausing</span>
                </label>
                <span class="field-hint">
                  Nobody is watching at 2am, so a schedule that pauses for approval waits until
                  morning. Leave this on unless a step in the workflow must be approved.
                </span>
              </div>
            </div>

            <div class="flex justify-end gap-2 pt-3">
              <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="() => { showModal = false }" />
              <UButton
                type="submit"
                :label="isEditing ? 'Save' : 'Create'"
                icon="i-lucide-save"
                size="sm"
                :loading="saving"
                :disabled="!canSave"
                :title="unstated.length ? `Needs ${unstated.join(', ')}` : undefined"
              />
            </div>
          </form>
        </div>
      </template>
    </UModal>
  </div>
</template>
