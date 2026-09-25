<script setup lang="ts">
import type { PickerChoice } from '~/utils/buildStack'
import { ACTION_LABEL, type ActionKind } from '~~/shared/utils/stackEdit'
import { STEP_KIND_ICON } from '~/utils/runStack'

/** The "+" between cards: what a step does, then (for an agent) which agent. */
const props = defineProps<{ agents: { slug: string, name: string }[], allowSplit: boolean, allowApproval: boolean }>()
const emit = defineEmits<{ choose: [PickerChoice] }>()
const open = ref(false)
const pickingAgent = ref(false)
const q = ref('')
const shown = computed(() => props.agents.filter(a => `${a.name} ${a.slug}`.toLowerCase().includes(q.value.toLowerCase())))
const RUNNER: ActionKind[] = ['jira', 'jira-create', 'notify', 'loop']
function choose(c: PickerChoice) { emit('choose', c); open.value = false; pickingAgent.value = false; q.value = '' }
</script>

<template>
  <UPopover v-model:open="open">
    <button class="size-6 rounded-full grid place-items-center t-small focus-ring" style="background: var(--surface-raised); border: 1px solid var(--border-default); color: var(--text-tertiary);" aria-label="Add a step here">+</button>
    <template #content>
      <div class="w-64 p-2 space-y-0.5 t-small" role="menu">
        <template v-if="!pickingAgent">
          <p class="t-label text-label px-2 py-1">Add a step</p>
          <button class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover-bg text-left" role="menuitem" @click="pickingAgent = true">
            <UIcon :name="STEP_KIND_ICON.agent" class="size-4" />{{ ACTION_LABEL.agent }}
          </button>
          <button v-for="k in RUNNER" :key="k" class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover-bg text-left" role="menuitem" @click="choose({ kind: 'action', action: k })">
            <UIcon :name="STEP_KIND_ICON[k]" class="size-4" />{{ ACTION_LABEL[k] }}
          </button>
          <button v-if="allowApproval" class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover-bg text-left" role="menuitem" @click="choose({ kind: 'approval' })">
            <UIcon name="i-lucide-hand" class="size-4" />Ask for approval
          </button>
          <button v-if="allowSplit" class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover-bg text-left" role="menuitem" @click="choose({ kind: 'split' })">
            <UIcon name="i-lucide-split" class="size-4" />Split into paths
          </button>
        </template>
        <template v-else>
          <button class="t-small text-label px-2 py-1 focus-ring" @click="pickingAgent = false">&larr; Back</button>
          <input v-model="q" class="field-search w-full" placeholder="Find an agent" aria-label="Find an agent">
          <div class="max-h-64 overflow-y-auto">
            <button v-for="a in shown" :key="a.slug" class="w-full text-left px-2 py-1.5 rounded hover-bg" role="menuitem" @click="choose({ kind: 'action', action: 'agent', agentSlug: a.slug })">
              <span class="block" style="color: var(--text-primary);">{{ a.name }}</span>
              <span class="block font-mono text-label">{{ a.slug }}</span>
            </button>
            <p v-if="!shown.length" class="px-2 py-1 text-label">No agent matches.</p>
          </div>
        </template>
      </div>
    </template>
  </UPopover>
</template>
