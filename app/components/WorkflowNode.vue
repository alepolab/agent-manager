<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import { getAgentColor } from '~/utils/colors'
import { getModelLabel } from '~/utils/models'
import { SHORT_ROLE, ROLE_LABEL, type Role } from '~~/shared/types/role'

const props = defineProps<{
  data: {
    label: string
    agentSlug: string
    agentColor?: string
    agentModel?: string
    monitorLabel?: string
    maxVisits?: number
    approval?: boolean
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
    visits?: number
    monitorVerdict?: 'CONTINUE' | 'RETRY' | 'ABORT'
    /** Whose work this step is. Rendered as a chip; it decides nothing. */
    ownerRole?: Role
    /** Whose decision this step's gate is, when it has one. A fact about the
     *  gate, shown under that name - never relabelled as the owner, which is a
     *  different question and often a different person. */
    gateRole?: Role
  }
  /** Whether this node may be changed. False for anyone without `configure`,
   *  who can read the pipeline but not edit it. Defaults true so the existing
   *  callers keep their behaviour until they opt in. */
  editable?: boolean
}>()

const emit = defineEmits<{
  remove: []
  settings: []
}>()

const color = computed(() => getAgentColor(props.data.agentColor))

const modelLabel = computed(() => getModelLabel(props.data.agentModel) ?? 'Default')

const verdictColor: Record<string, string> = {
  CONTINUE: 'var(--success, #22c55e)',
  RETRY: 'var(--warning, #e5a93e)',
  ABORT: 'var(--error)',
}
</script>

<template>
  <div
    class="workflow-node relative rounded-xl overflow-hidden group"
    style="width: 170px; height: 88px; background: var(--surface-raised); border: 1px solid var(--border-subtle);"
    :class="{
      'workflow-node--running': data.status === 'running',
      'workflow-node--completed': data.status === 'completed',
      'workflow-node--failed': data.status === 'failed',
      'workflow-node--skipped': data.status === 'skipped',
    }"
  >
    <!-- Two source handles so a loop can leave from the left without crossing the node -->
    <Handle id="in" type="target" :position="Position.Left" />
    <Handle id="loop" type="source" :position="Position.Bottom" />
    <div class="absolute inset-x-0 top-0 h-[3px]" :style="{ background: color }" />
    <div class="p-2.5 h-full flex flex-col justify-between">
      <div class="flex items-center justify-between gap-1">
        <div class="flex items-center gap-1 min-w-0">
          <span
            v-if="(data.visits ?? 0) > 1"
            class="t-small font-mono px-1 rounded"
            style="background: var(--accent-glow, rgba(255,255,255,0.08)); color: var(--accent);"
            :title="`Ran ${data.visits} times`"
          >×{{ data.visits }}</span>
          <span v-if="data.approval" class="inline-flex items-center" title="Waits for your approval before running"><UIcon name="i-lucide-hand" class="size-2.5 -mt-px" /></span>
          <span
            v-if="data.monitorLabel"
            class="t-small truncate"
            :style="{ color: data.monitorVerdict ? verdictColor[data.monitorVerdict] : 'var(--text-disabled)' }"
            :title="`Monitored by ${data.monitorLabel}${data.monitorVerdict ? ` - ${data.monitorVerdict}` : ''}`"
          >
            <UIcon name="i-lucide-shield" class="size-2.5 -mt-px" />
          </span>
        </div>
        <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <NuxtLink :to="`/agents/${data.agentSlug}`" class="p-0.5 rounded focus-ring" style="color: var(--text-disabled);" :title="`Edit agent ${data.agentSlug}`" @click.stop>
            <UIcon name="i-lucide-pencil" class="size-3" />
          </NuxtLink>
          <button class="p-0.5 rounded focus-ring" style="color: var(--text-disabled);" title="Step settings" aria-label="Step settings" @click="emit('settings')">
            <UIcon name="i-lucide-settings-2" class="size-3" />
          </button>
          <button v-if="editable !== false" class="p-0.5 rounded focus-ring" style="color: var(--text-disabled);" title="Remove step" aria-label="Remove step" @click="emit('remove')">
            <UIcon name="i-lucide-x" class="size-3" />
          </button>
        </div>
      </div>
      <div class="t-small font-medium truncate" style="color: var(--text-primary);">{{ data.label }}</div>
      <div class="flex items-center justify-between">
        <span class="t-small truncate" style="color: var(--text-tertiary);">{{ modelLabel }}</span>
        <!-- Owner, and the gate owner when it is someone else. Two facts under
             their own names: the template's comments said three gates belong to
             three different people and the canvas showed none of it. -->
        <span
          v-if="data.ownerRole"
          data-testid="step-owner"
          class="t-label shrink-0 rounded px-1 ml-auto"
          style="background: var(--surface-inset); color: var(--text-secondary);"
          :title="`${ROLE_LABEL[data.ownerRole]}${data.gateRole && data.gateRole !== data.ownerRole ? ` Gate answered by ${data.gateRole}.` : ''}`"
        >{{ SHORT_ROLE[data.ownerRole] }}</span>
        <span v-if="data.maxVisits" class="t-small font-mono" style="color: var(--text-disabled);" title="Max visits per run">
          ≤{{ data.maxVisits }}
        </span>
      </div>
    </div>
    <Handle id="out" type="source" :position="Position.Right" />

    <!-- Status overlays -->
    <div v-if="data.status === 'completed'" class="absolute bottom-1 right-1">
      <UIcon name="i-lucide-check-circle" class="size-3.5" style="color: var(--success, #22c55e);" />
    </div>
    <div v-if="data.status === 'failed'" class="absolute bottom-1 right-1">
      <UIcon name="i-lucide-x-circle" class="size-3.5" style="color: var(--error);" />
    </div>
  </div>
</template>

<style scoped>
.workflow-node--running {
  border-color: var(--accent) !important;
  box-shadow: 0 0 15px var(--accent-glow);
  animation: nodePulse 1.5s ease-in-out infinite;
}
.workflow-node--completed { border-color: var(--success, #22c55e) !important; }
.workflow-node--failed { border-color: var(--error) !important; }
.workflow-node--skipped { opacity: 0.4; }

@keyframes nodePulse {
  0%, 100% { box-shadow: 0 0 10px var(--accent-glow); }
  50% { box-shadow: 0 0 25px var(--accent-glow); }
}
</style>
