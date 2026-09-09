<script setup lang="ts">
import type { Workflow, WorkflowParameter } from '~/types'
import { RESERVED_PARAM_PROJECT_DIR } from '~~/shared/utils/workflowParameters'
import type { ScheduleRow } from '~/composables/useSchedules'

/**
 * Create or edit one schedule. One form serves both, and both surfaces - the
 * global Schedules page with a workflow picker, and a workflow's own Schedule
 * tab with the workflow pinned.
 *
 * It saves and raises its own toasts rather than emitting a payload. If it
 * emitted one, both consumers would duplicate the payload assembly AND the
 * "created, disabled" wording - which is the exact pair of things that
 * quietly stops matching between two copies.
 */
const props = defineProps<{
  open: boolean
  /** The schedule being edited, or null to create. */
  schedule: ScheduleRow | null
  /** Options for the picker, in unlocked (global) mode. */
  workflows?: Workflow[]
  /** Pins the workflow: no picker, and create lands on this slug. */
  lockedWorkflowSlug?: string
  /**
   * The declared inputs to collect, when the caller already holds them.
   *
   * The workflow page passes its own SAVED declaration rather than letting
   * this look the workflow up: useWorkflows()'s store is not populated by
   * fetchOne, and app.vue's fetchWorkflows() is fire-and-forget, so a hard
   * reload of the tab would race it and prefill nothing. Passing them also
   * means the `unstated` guard below and the server's `missing` 400 are
   * checking the same declaration.
   */
  parameters?: WorkflowParameter[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** Raised after a successful save. `created` is false for an edit. */
  saved: [created: boolean]
}>()

const { save } = useSchedules()
const toast = useToast()
const saving = ref(false)

const isEditing = computed(() => props.schedule !== null)

const form = reactive({
  name: '',
  workflowSlug: undefined as string | undefined,
  cron: '0 2 * * *',
  timezone: '',
  projectDir: '',
  initialPrompt: '',
  autoRun: true,
  parameters: {} as Record<string, string>,
})

const workflowOptions = computed(() => (props.workflows ?? []).map(w => ({ value: w.slug, label: w.name })))

const lockedWorkflowName = computed(() =>
  (props.workflows ?? []).find(w => w.slug === props.lockedWorkflowSlug)?.name || props.lockedWorkflowSlug)

/**
 * The declared inputs, minus the reserved one: a directory is collected by the
 * Working directory field, so offering a second `projectDir` box would be two
 * inputs for one thing - the contradiction the reserved name exists to remove.
 */
const declared = computed<WorkflowParameter[]>(() => {
  const source = props.parameters
    ?? (props.workflows ?? []).find(w => w.slug === form.workflowSlug)?.parameters
    ?? []
  return source.filter(p => p.name !== RESERVED_PARAM_PROJECT_DIR)
})

const unstated = computed(() =>
  declared.value.filter(p => p.required && !(form.parameters[p.name] ?? '').trim()).map(p => p.name))

const canSave = computed(() =>
  !!form.name.trim() && !!form.workflowSlug && !!form.cron.trim()
  && !!form.initialPrompt.trim() && !unstated.value.length)

/** Each declared input gets its stated value, else its declared default. */
function prefillParameters() {
  const next: Record<string, string> = {}
  for (const param of declared.value) {
    next[param.name] = form.parameters[param.name] ?? param.default ?? ''
  }
  form.parameters = next
}

// Switching workflow must not leave the previous one's values behind.
watch(() => form.workflowSlug, prefillParameters)

/**
 * Called from `open` rather than left to the watcher above, which is the bug
 * this shape fixes: with the workflow pinned, form.workflowSlug never changes,
 * so the watcher never fired - no default was ever prefilled, `canSave` stayed
 * false for any workflow with a required input, and reopening create kept the
 * previous session's values.
 */
function reset() {
  const s = props.schedule
  Object.assign(form, {
    name: s?.name ?? '',
    workflowSlug: s?.workflowSlug ?? props.lockedWorkflowSlug,
    cron: s?.cron ?? '0 2 * * *',
    timezone: s?.timezone ?? '',
    projectDir: s?.projectDir ?? '',
    initialPrompt: s?.initialPrompt ?? '',
    autoRun: s?.autoRun ?? true,
    // Copied by value: assigning the row's own map would make editing the form
    // edit the cached list row, so Cancel could not roll anything back.
    parameters: { ...(s?.parameters ?? {}) },
  })
  prefillParameters()
}

watch(() => props.open, (isOpen) => { if (isOpen) reset() })

async function onSave() {
  if (!canSave.value) return
  saving.value = true
  try {
    await save({
      ...(props.schedule ? { id: props.schedule.id } : {}),
      name: form.name.trim(),
      workflowSlug: form.workflowSlug!,
      cron: form.cron.trim(),
      timezone: form.timezone.trim() || undefined,
      // Always sent, never omitted: the route keeps the stored value for an
      // absent key, so omitting a cleared field would silently keep the old
      // directory. An empty string is how it goes back to derived.
      projectDir: form.projectDir.trim(),
      initialPrompt: form.initialPrompt.trim(),
      autoRun: form.autoRun,
      parameters: Object.fromEntries(
        Object.entries(form.parameters).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v),
      ),
    })
    emit('update:open', false)
    emit('saved', !isEditing.value)
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
</script>

<template>
  <UModal :open="open" @update:open="emit('update:open', $event)">
    <template #content>
      <div class="p-6 space-y-4 bg-overlay">
        <h3 class="text-page-title">{{ isEditing ? 'Edit schedule' : 'New schedule' }}</h3>

        <form @submit.prevent="onSave">
          <div class="space-y-4">
            <div class="field-group">
              <label class="field-label">Name</label>
              <input v-model="form.name" placeholder="Nightly security scan" class="field-input w-full">
            </div>

            <!-- Pinned: shown rather than hidden, so the person can see what
                 they are scheduling. -->
            <div v-if="lockedWorkflowSlug" class="field-group">
              <label class="field-label">Workflow</label>
              <p class="text-[12px] font-mono text-label">{{ lockedWorkflowName }}</p>
            </div>
            <div v-else class="field-group">
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
              <label class="field-label">
                Working directory
                <span class="text-[10px] font-normal ml-1" style="color: var(--text-disabled);">optional</span>
              </label>
              <input
                v-model="form.projectDir"
                placeholder="leave empty for a directory of its own"
                class="field-input w-full font-mono"
              >
              <span class="field-hint">
                Empty gives this schedule its own directory, which nothing else touches but which
                starts empty - so the workflow has to clone whatever it needs. Point it at a
                checkout to work on a real repository instead. Its agents write there, and a fire
                landing while another run is working in it is skipped rather than queued.
              </span>
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
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="emit('update:open', false)" />
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
</template>
