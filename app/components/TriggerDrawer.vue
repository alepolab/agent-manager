<script setup lang="ts">
import type { WorkflowParameter } from '~/types'

/**
 * What the trigger card opens: when this workflow runs on its own (schedules
 * and Jira watches), the inputs a run is started with, and the settings that
 * are stated about the workflow rather than about one run. Inputs, group and
 * channel are the page's unsaved state, so they come in and go out as models
 * and are saved by the page's Save.
 */
const props = defineProps<{
  workflowSlug: string
  workflowName: string
  /** The SAVED declaration, for the schedules - see WorkflowSchedulePanel. */
  savedParameters: WorkflowParameter[]
  /** False when the workflow has no steps. */
  schedulable: boolean
  /** As `/api/workflow-groups` returns them. */
  groups: { id: string, name: string, maxConcurrent: number, inFlight: number, waiting: number, implicit: boolean }[]
  /** As `/api/channels` returns them; only the name is stored on the workflow. */
  channels: { name: string, kind: string, host?: string }[]
  readOnly: boolean
}>()

const tab = defineModel<'triggers' | 'inputs' | 'settings'>('tab', { required: true })
const parameters = defineModel<WorkflowParameter[]>('parameters', { required: true })
/** '' is ungrouped, which means the default group. */
const group = defineModel<string>('group', { required: true })
/** '' means the channel called `default`, then SLACK_WEBHOOK_URL. */
const notifyChannel = defineModel<string>('notifyChannel', { required: true })

const TABS = [
  { id: 'triggers', label: 'Triggers' },
  { id: 'inputs', label: 'Inputs' },
  { id: 'settings', label: 'Settings' },
] as const

/** The same comparison the page makes, so the schedules can warn that they
 *  will run with the saved inputs, not these. */
const parametersDirty = computed(() =>
  JSON.stringify(parameters.value.filter(p => p.name.trim())) !== JSON.stringify(props.savedParameters))

const { watches, fetchAll: fetchWatches } = useWatches()
const workflowWatches = computed(() => watches.value.filter(w => w.workflowSlug === props.workflowSlug))
const clip = (text: string | undefined, max: number) => {
  const t = text ?? ''
  return t.length > max ? `${t.slice(0, max)}…` : t
}
onMounted(() => { void fetchWatches().catch(() => {}) })

/** What the picked group means right now, so the cap is not a number with no
 *  context. Names the default group's cap for an ungrouped workflow, because
 *  ungrouped is capped too - it is not "unlimited". */
const groupHint = computed(() => {
  const g = props.groups.find(x => x.id === (group.value || 'default'))
  if (!g) return 'Runs of this workflow share slots with the default group'
  return `${g.name}: ${g.maxConcurrent} run${g.maxConcurrent === 1 ? '' : 's'} at once`
    + ` (${g.inFlight} running, ${g.waiting} waiting). Automated starts over the cap queue; a run started here does not wait, but does occupy a slot.`
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex gap-4 border-b" style="border-color: var(--border-subtle);" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.id"
        role="tab"
        :data-testid="`trigger-tab-${t.id}`"
        :aria-selected="tab === t.id"
        class="t-small py-1.5 -mb-px focus-ring"
        :style="tab === t.id ? 'border-bottom: 2px solid var(--accent); color: var(--text-primary);' : 'color: var(--text-tertiary);'"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
    </div>

    <div v-if="tab === 'triggers'" class="space-y-4">
      <WorkflowSchedulePanel
        :workflow-slug="workflowSlug"
        :workflow-name="workflowName"
        :parameters="savedParameters"
        :schedulable="schedulable"
        :parameters-dirty="parametersDirty"
      />

      <div class="space-y-2">
        <h4 class="t-ui font-medium">Jira watches</h4>
        <p v-if="!workflowWatches.length" class="t-small" style="color: var(--text-disabled);">
          No Jira watch starts this workflow.
        </p>
        <NuxtLink
          v-for="w in workflowWatches"
          :key="w.id"
          to="/watches"
          class="block rounded-md p-2 focus-ring"
          style="border: 1px solid var(--border-subtle);"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="t-small font-medium truncate">{{ w.name }}</span>
            <span class="t-small shrink-0" :style="w.enabled ? 'color: var(--success);' : 'color: var(--text-tertiary);'">
              {{ w.enabled ? 'Enabled' : 'Disabled' }}
            </span>
          </div>
          <p v-if="w.query" class="t-small font-mono truncate" style="color: var(--text-tertiary);">{{ clip(w.query, 80) }}</p>
        </NuxtLink>
        <UButton to="/watches" label="Add Jira watch" icon="i-lucide-plus" size="sm" variant="ghost" color="neutral" />
      </div>
    </div>

    <WorkflowInputsEditor v-else-if="tab === 'inputs'" v-model="parameters" :read-only="readOnly" />

    <div v-else class="space-y-4 t-small">
      <!-- Which runs this workflow's runs share slots with. -->
      <div class="field-group">
        <label class="field-label" for="trigger-concurrency-group">Concurrency group</label>
        <select
          id="trigger-concurrency-group"
          v-model="group"
          class="field-input"
          :disabled="readOnly"
        >
          <option value="">Ungrouped (default)</option>
          <option v-for="g in groups.filter(x => !x.implicit)" :key="g.id" :value="g.id">
            {{ g.name }} - {{ g.maxConcurrent }} at once
          </option>
        </select>
        <span class="field-hint">{{ groupHint }}</span>
      </div>
      <!-- Where this workflow's runs announce themselves. -->
      <div class="field-group">
        <label class="field-label" for="trigger-notify-channel">Notification channel</label>
        <select
          id="trigger-notify-channel"
          v-model="notifyChannel"
          class="field-input"
          :disabled="readOnly"
          title="Where this workflow's runs announce that they paused, finished or failed"
        >
          <option value="">Default channel</option>
          <option v-for="c in channels" :key="c.name" :value="c.name">Announce to {{ c.name }}</option>
        </select>
        <span class="field-hint">Where this workflow's runs announce that they paused, finished or failed.</span>
      </div>
    </div>
  </div>
</template>
