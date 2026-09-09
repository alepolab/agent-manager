<script setup lang="ts">
import type { WorkflowParameter } from '~/types'
import { RESERVED_PARAM_PROJECT_DIR } from '~~/shared/utils/workflowParameters'

const props = defineProps<{
  open: boolean
  /** Prefill from an existing run (clone). Absent means a blank modal. */
  initial?: { prompt: string, projectDir?: string, autoRun: boolean, parameters?: Record<string, string> }
  /** The workflow's declared inputs, collected here instead of left to the prompt. */
  parameters?: WorkflowParameter[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  start: [prompt: string, projectDir: string | undefined, autoRun: boolean, parameters: Record<string, string>]
}>()

const { workingDir } = useWorkingDir()
const prompt = ref('')
const projectDir = ref(workingDir.value)
const autoRun = ref(true)
/** One entry per declared parameter, keyed by name. */
const values = ref<Record<string, string>>({})

const declared = computed(() => props.parameters ?? [])
// The reserved name replaces the Project folder field rather than sitting
// beside it: two inputs for one directory is exactly the contradiction the
// reserved binding exists to remove.
const bindsProjectDir = computed(() => declared.value.some(p => p.name === RESERVED_PARAM_PROJECT_DIR))
const unfilled = computed(() =>
  declared.value.filter(p => p.required && !(values.value[p.name] ?? '').trim()).map(p => p.name))
const canStart = computed(() => !!prompt.value.trim() && !unfilled.value.length)

function reset() {
  prompt.value = props.initial?.prompt ?? ''
  projectDir.value = props.initial?.projectDir ?? workingDir.value
  autoRun.value = props.initial?.autoRun ?? true
  // A clone's own values win over the declaration's defaults: the point of
  // cloning is to run what the last one ran.
  values.value = Object.fromEntries(declared.value.map(p => [
    p.name, props.initial?.parameters?.[p.name] ?? p.default ?? '',
  ]))
}

function onStart() {
  if (!canStart.value) return
  const filled = Object.fromEntries(
    Object.entries(values.value).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v),
  )
  emit('start', prompt.value.trim(), projectDir.value.trim() || undefined, autoRun.value, filled)
  prompt.value = ''
  projectDir.value = ''
  autoRun.value = true
  values.value = {}
}

function onCancel() {
  emit('update:open', false)
  reset()
}

// On open: prefill from `initial` when cloning, else the declared defaults and
// the global working dir.
watch(() => props.open, (val) => {
  if (!val) return
  reset()
})
</script>

<template>
  <UModal :open="open" @update:open="emit('update:open', $event)">
    <template #content>
      <div class="p-6 space-y-4 bg-overlay">
        <h3 class="text-page-title">Run Workflow</h3>
        <p class="text-[12px] text-label">
          What should this workflow process? The output of each step becomes the input for the next.
        </p>
        <form @submit.prevent="onStart">
          <div class="space-y-4">
            <div class="field-group">
              <label class="field-label">Initial prompt</label>
              <textarea
                v-model="prompt"
                placeholder="e.g., Review the authentication module in src/auth/"
                rows="4"
                class="field-input w-full resize-none"
              />
            </div>

            <!-- Declared inputs. Stated to every step, so they are collected
                 here rather than left for an agent to dig out of the prompt. -->
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
                v-model="values[param.name]"
                :placeholder="param.default || (param.name === RESERVED_PARAM_PROJECT_DIR ? '/Users/you/projects/my-app' : '')"
                class="field-input w-full"
              >
              <span v-if="param.description" class="field-hint">{{ param.description }}</span>
              <span v-else-if="param.name === RESERVED_PARAM_PROJECT_DIR" class="field-hint">
                Agents will read and write files in this directory.
              </span>
            </div>

            <div v-if="!bindsProjectDir" class="field-group">
              <label class="field-label">
                Project folder
                <span class="text-[10px] font-normal ml-1" style="color: var(--text-disabled);">optional</span>
              </label>
              <input
                v-model="projectDir"
                placeholder="/Users/you/projects/my-app"
                class="field-input w-full"
              >
              <span class="field-hint">
                Agents will read and write files in this directory. Defaults to your global working directory, or the Claude config folder if unset.
              </span>
            </div>

            <div class="field-group">
              <label class="flex items-center gap-2 cursor-pointer">
                <input v-model="autoRun" type="checkbox" class="shrink-0">
                <span class="field-label mb-0">Run to completion without pausing</span>
              </label>
              <span class="field-hint">
                Each step starts as soon as the one before it finishes. A failed step or an
                aborting monitor still stops the run.
              </span>
            </div>
          </div>
          <div class="flex justify-end gap-2 pt-3">
            <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="onCancel" />
            <UButton
              type="submit"
              label="Start"
              icon="i-lucide-play"
              size="sm"
              :disabled="!canStart"
              :title="unfilled.length ? `Needs ${unfilled.join(', ')}` : undefined"
            />
          </div>
        </form>
      </div>
    </template>
  </UModal>
</template>
