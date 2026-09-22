<script setup lang="ts">
import type { OutputStyle, OutputStylePayload } from '~/types'

const props = defineProps<{
  initialData?: OutputStyle
}>()

const emit = defineEmits<{
  close: []
  save: [payload: OutputStylePayload]
}>()

const { workingDir } = useWorkingDir()

const form = ref<OutputStylePayload>({
  id: props.initialData?.id || '',
  name: props.initialData?.name || '',
  description: props.initialData?.description || '',
  keepCodingInstructions: props.initialData?.keepCodingInstructions ?? false,
  content: props.initialData?.content || '',
  scope: props.initialData?.scope || (workingDir.value ? 'project' : 'global')
})

const isEdit = !!props.initialData

function handleSubmit() {
  if (!form.value.id || !form.value.name || !form.value.content) {
    return
  }
  emit('save', {
    ...form.value,
    oldId: props.initialData?.id
  })
}
</script>

<template>
  <div class="p-6 space-y-5 bg-overlay rounded-2xl border border-subtle max-w-2xl w-full">
    <div class="flex items-center justify-between">
      <h3 class="text-page-title">{{ isEdit ? 'Edit' : 'New' }} Output Style</h3>
      <UButton icon="i-lucide-x" variant="ghost" color="neutral" size="sm" @click="emit('close')" />
    </div>

    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-1.5">
          <label class="field-label">ID (Filename)</label>
          <input
            v-model="form.id"
            type="text"
            placeholder="e.g. creative-writer"
            class="field-input font-mono"
            :disabled="isEdit"
          />
          <p class="field-hint">Used as the filename (without .md)</p>
        </div>
        <div class="space-y-1.5">
          <label class="field-label">Display Name</label>
          <input
            v-model="form.name"
            type="text"
            placeholder="e.g. Creative Writer"
            class="field-input"
          />
        </div>
      </div>

      <div class="space-y-1.5">
        <label class="field-label">Description</label>
        <input
          v-model="form.description"
          type="text"
          placeholder="Briefly describe what this style does"
          class="field-input"
        />
      </div>

      <div class="space-y-1.5">
        <label class="field-label">Scope</label>
        <div class="flex gap-4">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="radio" v-model="form.scope" value="global" class="accent-accent" />
            <span class="t-ui text-secondary">Global (~/.claude/output-styles)</span>
          </label>
          <label
            class="flex items-center gap-2 cursor-pointer"
            :class="{ 'opacity-50 cursor-not-allowed': !workingDir }"
            :title="!workingDir ? 'Set a working directory in the sidebar to use project scope' : ''"
          >
            <input type="radio" v-model="form.scope" value="project" :disabled="!workingDir" class="accent-accent" />
            <span class="t-ui text-secondary">Project (.claude/output-styles)</span>
          </label>
        </div>
        <p v-if="!workingDir" class="t-small text-meta italic">Project scope is disabled because no working directory is set.</p>
      </div>

      <div class="flex items-center justify-between p-3 rounded-xl border border-subtle bg-surface-base">
        <div class="space-y-0.5">
          <div class="t-ui font-medium">Keep Coding Instructions</div>
          <div class="t-small text-secondary">Whether Claude's default software engineering rules should remain active.</div>
        </div>
        <label class="field-toggle">
          <input type="checkbox" v-model="form.keepCodingInstructions" />
          <span class="field-toggle__track">
            <span class="field-toggle__thumb" />
          </span>
        </label>
      </div>

      <div class="space-y-1.5">
        <label class="field-label">Instructions (Markdown)</label>
        <textarea
          v-model="form.content"
          rows="10"
          placeholder="Enter the behavioral instructions for this style..."
          class="field-input font-mono t-small resize-none"
        ></textarea>
        <p class="field-hint">These instructions will be appended to the system prompt.</p>
      </div>
    </div>

    <div class="flex justify-end gap-3 pt-2">
      <UButton label="Cancel" variant="ghost" color="neutral" size="sm" @click="emit('close')" />
      <UButton
        :label="isEdit ? 'Update Style' : 'Create Style'"
        color="primary"
        size="sm"
        :disabled="!form.id || !form.name || !form.content"
        @click="handleSubmit"
      />
    </div>
  </div>
</template>

<style scoped>
.bg-overlay { background: var(--surface-raised); }
.border-subtle { border-color: var(--border-subtle); }
.text-primary { color: var(--text-primary); }
.text-secondary { color: var(--text-secondary); }
.field-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
}
.field-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--surface-base);
  border: 1px solid var(--border-subtle);
  border-radius: 0.5rem;
  font-size: 13px;
  color: var(--text-primary);
  outline: none;
  transition: all 0.2s;
}
.field-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(229, 169, 62, 0.1);
}
.field-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.field-hint {
  font-size: 11px;
  color: var(--text-tertiary);
}
.accent-accent {
  accent-color: var(--accent);
}
</style>
