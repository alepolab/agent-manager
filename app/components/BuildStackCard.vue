<script setup lang="ts">
import { stepKind } from '~~/shared/utils/workflowStack'
import { BUILD_STACK_KEY } from '~/utils/buildStack'
import { STEP_KIND_ICON, STEP_KIND_LABEL } from '~/utils/runStack'

/** One step in the builder: what it is, what it's set to, and select/delete. */
const props = defineProps<{ stepId: string }>()
const ctx = inject(BUILD_STACK_KEY)!
const step = computed(() => ctx.stepOf(props.stepId))
const kind = computed(() => stepKind(step.value))
const selected = computed(() => ctx.isSelected(props.stepId))
const confirming = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null
function del() {
  if (!confirming.value) { confirming.value = true; timer = setTimeout(() => { confirming.value = false }, 4000); return }
  confirming.value = false
  ctx.remove(props.stepId)
}
onUnmounted(() => { if (timer) clearTimeout(timer) })
</script>

<template>
  <article
    v-if="step" :id="`build-step-${stepId}`" :data-step="stepId"
    class="w-full rounded-lg grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2"
    :style="{ background: 'var(--surface-raised)', border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`, boxShadow: selected ? '0 0 0 3px var(--accent-muted)' : 'none' }"
  >
    <UIcon :name="STEP_KIND_ICON[kind]" class="size-4 shrink-0" style="color: var(--text-accent);" />
    <button class="min-w-0 text-left focus-ring" :aria-pressed="selected" @click="ctx.select(stepId)">
      <span class="block t-small text-label">{{ STEP_KIND_LABEL[kind] }}</span>
      <span class="block t-ui font-medium truncate" style="color: var(--text-primary);">{{ step.label }}</span>
      <span class="block t-small text-label truncate">
        <template v-if="kind === 'agent'">{{ ctx.agentName(step.agentSlug) }}</template>
        <template v-if="step.monitorSlug"> · Check</template>
        <template v-if="step.produces?.length"> · {{ step.produces.length }} {{ step.produces.length === 1 ? 'file' : 'files' }}</template>
        <template v-if="(step.maxVisits ?? 0) > 1"> · retries up to {{ step.maxVisits }}</template>
      </span>
    </button>
    <UButton
      v-if="!ctx.readOnly.value" size="xs" :variant="confirming ? 'solid' : 'ghost'" :color="confirming ? 'error' : 'neutral'"
      :icon="confirming ? undefined : 'i-lucide-trash-2'" :label="confirming ? 'Confirm delete' : undefined"
      :aria-label="`Delete ${step.label}`" @click="del"
    />
  </article>
</template>
