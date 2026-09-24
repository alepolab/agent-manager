<script setup lang="ts">
import type { PendingPermission } from '~/types'

const props = defineProps<{
  permissions: PendingPermission[]
}>()

const emit = defineEmits<{
  (e: 'respond', permissionId: string, decision: 'allow' | 'deny', remember?: boolean): void
}>()

// Show first permission (could expand to show list)
const firstPermission = computed(() => props.permissions[0])

// Check if this is an AskUserQuestion tool
const isAskUserQuestion = computed(() => {
  const tn = firstPermission.value?.toolName?.toLowerCase() || ''
  return ['askuserquestion', 'ask_user', 'askuser', 'ask_user_question', 'prompt', 'input_request'].includes(tn)
})

function handleAllow() {
  if (firstPermission.value) {
    emit('respond', firstPermission.value.id, 'allow', false)
  }
}

function handleDeny() {
  if (firstPermission.value) {
    emit('respond', firstPermission.value.id, 'deny', false)
  }
}
</script>

<template>
  <div
    v-if="permissions.length > 0"
    class="shrink-0 px-4 py-3 border-b flex flex-wrap items-center justify-between gap-4"
    style="background: rgba(var(--accent-rgb), 0.1); border-color: var(--accent);"
  >
    <div class="flex items-center gap-3 min-w-0">
      <UIcon name="i-lucide-shield-question" class="size-5 shrink-0" style="color: var(--accent);" />
      <div class="min-w-0">
        <div class="t-small font-semibold break-words" style="color: var(--text-primary);">
          Action Required
          <span
            v-if="permissions.length > 1"
            class="ml-2 px-1.5 py-0.5 rounded t-small inline-block"
            style="background: var(--accent); color: white;"
          >
            +{{ permissions.length - 1 }} more
          </span>
        </div>
        <div class="t-small break-words" style="color: var(--text-secondary);">
          <strong class="break-all">{{ firstPermission?.toolName }}</strong> {{ isAskUserQuestion ? 'is asking a question' : 'wants to perform an action' }}
        </div>
      </div>
    </div>

    <div class="flex items-center gap-2 shrink-0">
      <button
        class="px-3 py-1.5 rounded-lg t-small font-medium transition-all"
        style="background: var(--accent); color: white;"
        @click="handleAllow"
      >
        Submit
      </button>
      <button
        class="px-3 py-1.5 rounded-lg t-small font-medium transition-all"
        style="background: rgba(205, 49, 49, 0.1); color: #cd3131;"
        @click="handleDeny"
      >
        Cancel
      </button>
    </div>
  </div>
</template>
