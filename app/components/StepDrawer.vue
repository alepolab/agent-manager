<script setup lang="ts">
import type { WorkflowStep } from '~/types'
import { stepKind } from '~~/shared/utils/workflowStack'
import { ACTION_LABEL } from '~~/shared/utils/stackEdit'
import { ROLES, type Role } from '~~/shared/types/role'

/**
 * One step's settings, in two tabs: Setup (what the step is, which agent, its
 * approval), Configure (the fields for its kind) and Test (run it again
 * against a finished run, with the config as it stands here). A step's kind is fixed
 * once added: to change it, add the other kind and delete this one.
 */
const props = defineProps<{
  step: WorkflowStep
  agents: { slug: string, name: string, description?: string }[]
  /** As `/api/channels` returns them. */
  channels: { name: string, kind: string, host?: string }[]
  parameterNames: string[]
  readOnly: boolean
  workflowSlug: string
}>()
const emit = defineEmits<{ patch: [Partial<WorkflowStep>] }>()
const tab = ref<'setup' | 'configure' | 'test'>('setup')
watch(() => props.step.id, () => { tab.value = 'setup' })
const kind = computed(() => stepKind(props.step))
const agentOptions = computed(() => props.agents.map(a => ({ value: a.slug, label: a.name })))
</script>

<template>
  <div class="space-y-3">
    <div>
      <p class="t-label text-label">{{ ACTION_LABEL[kind] }}</p>
      <input
        :value="step.label" :disabled="readOnly" class="field-input w-full t-ui font-medium" aria-label="Step name"
        @change="(e) => { emit('patch', { label: (e.target as HTMLInputElement).value.trim() || step.label }) }"
      >
    </div>
    <div class="flex gap-4 border-b" style="border-color: var(--border-subtle);" role="tablist">
      <button v-for="t in (['setup', 'configure', 'test'] as const)" :key="t" role="tab" :aria-selected="tab === t" class="t-small py-1.5 -mb-px focus-ring" :style="tab === t ? 'border-bottom: 2px solid var(--accent); color: var(--text-primary);' : 'color: var(--text-tertiary);'" @click="tab = t">
        {{ t === 'setup' ? 'Setup' : t === 'configure' ? 'Configure' : 'Test' }}
      </button>
    </div>

    <div v-if="tab === 'setup'" class="space-y-3 t-small">
      <div v-if="kind === 'agent'" class="field-group">
        <label class="field-label">Agent</label>
        <div class="flex items-center gap-2">
          <USelectMenu :model-value="step.agentSlug" :items="agentOptions" value-key="value" :disabled="readOnly" class="flex-1" @update:model-value="(v: string) => { if (v) emit('patch', { agentSlug: v }) }" />
          <UButton :to="`/agents/${step.agentSlug}`" size="sm" variant="ghost" color="neutral" icon="i-lucide-pencil" label="Edit agent" />
        </div>
        <span class="field-hint">The agent that runs this step. Editing changes its prompt for every workflow that uses it; a promoted agent changes it for the team.</span>
      </div>
      <p v-else class="text-label">Runs in the pipeline itself, with no model call.</p>
      <div class="field-group">
        <label class="flex items-center gap-2">
          <input type="checkbox" :checked="!!step.approval" :disabled="readOnly" @change="(e) => { emit('patch', (e.target as HTMLInputElement).checked ? { approval: true } : { approval: undefined, gateRole: undefined }) }">
          Ask for approval before this step runs
        </label>
        <span class="field-hint">The run pauses on the run page until it is approved, even when running to completion. Use it for steps with an outward effect, such as pushing and opening the pull request.</span>
      </div>
      <div v-if="step.approval" class="field-group">
        <label class="field-label">Who approves</label>
        <select class="field-input" :value="step.gateRole ?? ''" :disabled="readOnly" @change="(e) => { emit('patch', { gateRole: ((e.target as HTMLSelectElement).value || undefined) as Role | undefined }) }">
          <option value="">Anyone who can answer gates</option>
          <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
        </select>
      </div>
    </div>

    <StepTestPanel v-else-if="tab === 'test'" :workflow-slug="workflowSlug" :step="step" />
    <StepConfigFields v-else :step="step" :kind="kind" :agents="agents" :channels="channels" :parameter-names="parameterNames" :read-only="readOnly" @patch="(p) => { emit('patch', p) }" />
  </div>
</template>
