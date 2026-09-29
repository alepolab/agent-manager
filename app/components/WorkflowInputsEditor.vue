<script setup lang="ts">
import type { WorkflowParameter } from '~/types'
import { isValidParameterName, RESERVED_PARAM_PROJECT_DIR } from '~~/shared/utils/workflowParameters'

/**
 * Workflow inputs: what an operator (or a schedule) must state before a run
 * starts, instead of hoping it was buried in the prompt. Moved out of the
 * builder's old parameters modal. Every add, remove and edit emits a new
 * array; the declaration it was given is never changed in place.
 */
const props = defineProps<{
  modelValue: WorkflowParameter[]
  readOnly: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [WorkflowParameter[]] }>()

function addParameter() {
  emit('update:modelValue', [...props.modelValue, { name: '' }])
}

function removeParameter(index: number) {
  emit('update:modelValue', props.modelValue.filter((_, i) => i !== index))
}

function updateParameter(index: number, changes: Partial<WorkflowParameter>) {
  emit('update:modelValue', props.modelValue.map((p, i) => (i === index ? { ...p, ...changes } : p)))
}

/** A name that is not an identifier reads as two tokens in a step header and
 *  cannot be referred to, so it is flagged here rather than silently dropped
 *  on save. */
function parameterNameError(index: number): string | null {
  const param = props.modelValue[index]
  if (!param) return null
  const name = param.name.trim()
  if (!name) return null
  if (!isValidParameterName(name)) return 'Letters, digits and _ only, starting with a lowercase letter'
  if (props.modelValue.some((other, i) => i !== index && other.name.trim() === name)) return 'Declared twice'
  return null
}

const inputValue = (e: Event) => (e.target as HTMLInputElement).value
</script>

<template>
  <div class="space-y-4">
    <h3 class="text-page-title">Workflow inputs</h3>
    <p class="t-small text-label">
      Named values collected when a run starts and stated to every step. Declare what this
      workflow needs - which repository, which Jira project - so no agent has to work it out
      from the prompt.
    </p>

    <div v-if="!modelValue.length" class="t-small" style="color: var(--text-disabled);">
      No inputs declared. Runs are started with just the prompt.
    </div>

    <div v-for="(param, index) in modelValue" :key="index" class="field-group">
      <div class="flex items-start gap-2">
        <div class="flex-1 space-y-2">
          <input
            :value="param.name"
            :disabled="readOnly"
            placeholder="name, e.g. jira_project"
            class="field-input w-full"
            @input="(e) => { updateParameter(index, { name: inputValue(e) }) }"
          >
          <span v-if="parameterNameError(index)" class="field-hint" style="color: var(--error);">
            {{ parameterNameError(index) }}
          </span>
          <input
            :value="param.description"
            :disabled="readOnly"
            placeholder="what it is for (shown to whoever starts the run)"
            class="field-input w-full"
            @input="(e) => { updateParameter(index, { description: inputValue(e) }) }"
          >
          <div class="flex items-center gap-3">
            <input
              :value="param.default"
              :disabled="readOnly"
              placeholder="default (optional)"
              class="field-input flex-1"
              @input="(e) => { updateParameter(index, { default: inputValue(e) }) }"
            >
            <label class="flex items-center gap-2 cursor-pointer shrink-0">
              <input
                type="checkbox"
                class="shrink-0"
                :checked="!!param.required"
                :disabled="readOnly"
                @change="(e) => { updateParameter(index, { required: (e.target as HTMLInputElement).checked }) }"
              >
              <span class="field-label mb-0">Required</span>
            </label>
          </div>
          <span v-if="param.name.trim() === RESERVED_PARAM_PROJECT_DIR" class="field-hint">
            Reserved name: this one becomes the run's project folder, and replaces that field
            in the run dialog. Everything else is stated to the agents as text.
          </span>
        </div>
        <UButton
          v-if="!readOnly"
          icon="i-lucide-trash-2"
          size="sm"
          variant="ghost"
          color="error"
          aria-label="Remove input"
          @click="() => { removeParameter(index) }"
        />
      </div>
    </div>

    <div v-if="!readOnly" class="flex gap-2 pt-3">
      <UButton label="Add input" icon="i-lucide-plus" size="sm" variant="soft" @click="() => { addParameter() }" />
    </div>
  </div>
</template>
