<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import { getAgentColor } from '~/utils/colors'
import { getModelLabel } from '~/utils/models'

const props = defineProps<{
  data: {
    label: string
    agentSlug: string
    agentColor?: string
    agentModel?: string
    monitorLabel?: string
    maxVisits?: number
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
    visits?: number
    monitorVerdict?: 'CONTINUE' | 'RETRY' | 'ABORT'
  }
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
            class="text-[9px] font-mono px-1 rounded"
            style="background: var(--accent-glow, rgba(255,255,255,0.08)); color: var(--accent);"
            :title="`Ran ${data.visits} times`"
          >×{{ data.visits }}</span>
          <span
            v-if="data.monitorLabel"
            class="text-[9px] truncate"
            :style="{ color: data.monitorVerdict ? verdictColor[data.monitorVerdict] : 'var(--text-disabled)' }"
            :title="`Monitored by ${data.monitorLabel}${data.monitorVerdict ? ` - ${data.monitorVerdict}` : ''}`"
          >
            <UIcon name="i-lucide-shield" class="size-2.5 -mt-px" />
          </span>
        </div>
        <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button class="p-0.5 rounded" style="color: var(--text-disabled);" title="Step settings" @click="emit('settings')">
            <UIcon name="i-lucide-settings-2" class="size-3" />
          </button>
          <button class="p-0.5 rounded" style="color: var(--text-disabled);" title="Remove step" @click="emit('remove')">
            <UIcon name="i-lucide-x" class="size-3" />
          </button>
        </div>
      </div>
      <div class="text-[11px] font-medium truncate" style="color: var(--text-primary);">{{ data.label }}</div>
      <div class="flex items-center justify-between">
        <span class="text-[9px]" style="color: var(--text-disabled);">{{ modelLabel }}</span>
        <span v-if="data.maxVisits" class="text-[9px] font-mono" style="color: var(--text-disabled);" title="Max visits per run">
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
