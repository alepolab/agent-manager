<script setup lang="ts">
const props = defineProps<{
  open: boolean
  /** Prefill from an existing run (clone). Absent means a blank modal. */
  initial?: { prompt: string, projectDir?: string, autoRun: boolean }
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  start: [prompt: string, projectDir: string | undefined, autoRun: boolean]
}>()

const { workingDir } = useWorkingDir()
const prompt = ref('')
const projectDir = ref(workingDir.value)
const autoRun = ref(false)

function onStart() {
  if (!prompt.value.trim()) return
  emit('start', prompt.value.trim(), projectDir.value.trim() || undefined, autoRun.value)
  prompt.value = ''
  projectDir.value = ''
  autoRun.value = false
}

function onCancel() {
  emit('update:open', false)
  prompt.value = ''
  projectDir.value = workingDir.value
  autoRun.value = false
}

// On open: prefill from `initial` when cloning, else the global working dir.
watch(() => props.open, (val) => {
  if (!val) return
  prompt.value = props.initial?.prompt ?? ''
  projectDir.value = props.initial?.projectDir ?? workingDir.value
  autoRun.value = props.initial?.autoRun ?? false
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
            <div class="field-group">
              <label class="field-label">
                Project folder
                <span class="text-[10px] font-normal ml-1" style="color: var(--text-disabled);">optional</span>
              </label>
              <input
                v-model="projectDir"
                placeholder="/Users/you/projects/my-app"
                class="field-input w-full"
              />
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
            <UButton type="submit" label="Start" icon="i-lucide-play" size="sm" :disabled="!prompt.trim()" />
          </div>
        </form>
      </div>
    </template>
  </UModal>
</template>
