<script setup lang="ts">
import type { ChatMessage } from '~/types'

const props = defineProps<{
  agentSlug?: string
  agentName?: string
  commandSlug?: string
  skillSlug?: string
  isDraft?: boolean
}>()

const { messages, isStreaming, error, activity, toolCalls, sendMessage, stopStreaming, clearChat } = useStudioChat()
const { workingDir, displayPath: projectDisplayPath } = useWorkingDir()

const input = ref('')
const inputRef = ref<{ focus: () => void; resetHeight: () => void } | null>(null)
const messagesContainer = ref<HTMLElement | null>(null)
const streamingDots = ref(0)

const testName = computed(() => props.agentName || props.commandSlug || props.skillSlug || 'Entity')

let dotsInterval: ReturnType<typeof setInterval> | null = null
watch(isStreaming, (val) => {
  if (val) {
    dotsInterval = setInterval(() => { streamingDots.value = (streamingDots.value + 1) % 4 }, 400)
  } else {
    if (dotsInterval) clearInterval(dotsInterval)
    streamingDots.value = 0
  }
})
onUnmounted(() => { if (dotsInterval) clearInterval(dotsInterval) })

function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  })
}
watch(() => messages.value.length, scrollToBottom)
watch(() => messages.value[messages.value.length - 1]?.content, scrollToBottom)

const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading file', Write: 'Writing file', Edit: 'Editing file',
  Glob: 'Searching files', Grep: 'Searching code', Bash: 'Running command',
}

const statusText = computed(() => {
  if (!isStreaming.value) return messages.value.length ? 'Ready' : 'Online'
  const a = activity.value
  if (!a) return 'Starting' + '.'.repeat(streamingDots.value)
  if (a.type === 'thinking') return 'Thinking' + '.'.repeat(streamingDots.value)
  if (a.type === 'tool') return (TOOL_LABELS[a.name] || a.name) + '.'.repeat(streamingDots.value)
  if (a.type === 'writing') return 'Responding' + '.'.repeat(streamingDots.value)
  return 'Executing' + '.'.repeat(streamingDots.value)
})

function isLastAssistantStreaming(idx: number): boolean {
  return isStreaming.value && idx === messages.value.length - 1
}

async function handleSend() {
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  inputRef.value?.resetHeight()
  
  // Construct options with all possible entity identifiers
  const options: any = { projectDir: workingDir.value || undefined }
  if (props.agentSlug) options.agentSlug = props.agentSlug
  if (props.commandSlug) options.commandSlug = props.commandSlug
  if (props.skillSlug) options.skillSlug = props.skillSlug

  await sendMessage(text, options)
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="shrink-0 px-4 py-2.5 flex items-center justify-between border-b" style="border-color: var(--border-subtle);">
      <div class="flex items-center gap-2">
        <span class="t-small font-medium" style="color: var(--text-primary);">Test</span>
        <span v-if="isDraft" class="t-small font-mono px-1.5 py-px rounded-full" style="background: rgba(var(--accent-rgb), 0.1); color: var(--accent);">Draft</span>
        <span class="t-small font-mono tracking-widest uppercase px-1.5 py-px rounded-full transition-all" :style="{ background: isStreaming ? 'var(--accent-muted)' : 'var(--badge-subtle-bg)', color: isStreaming ? 'var(--accent)' : 'var(--text-disabled)' }">{{ statusText }}</span>
      </div>
      <button v-if="messages.length" class="p-1 rounded-md hover-bg transition-all" style="color: var(--text-disabled);" title="Clear conversation" @click="clearChat">
        <UIcon name="i-lucide-rotate-ccw" class="size-3" />
      </button>
    </div>

    <div ref="messagesContainer" class="flex-1 overflow-y-auto px-4 py-3 space-y-4">
      <div v-if="!messages.length" class="flex flex-col items-center justify-center h-full gap-3">
        <UIcon name="i-lucide-message-square" class="size-8" style="color: var(--text-disabled); opacity: 0.5;" />
        <p class="t-small text-center max-w-[200px]" style="color: var(--text-tertiary);">Test your {{ agentSlug ? 'agent' : commandSlug ? 'command' : 'skill' }} here. Changes to instructions are reflected immediately.</p>
      </div>

      <template v-for="(msg, idx) in messages" :key="msg.id">
        <ChatMessage :message="(msg as ChatMessage)" :is-streaming="isLastAssistantStreaming(idx)" :activity="activity" :status-text="statusText" />
      </template>

      <div v-if="error" class="t-small rounded-lg px-3 py-2" style="background: rgba(248, 113, 113, 0.06); color: var(--error);">{{ error }}</div>
    </div>

    <ChatInput ref="inputRef" v-model="input" :placeholder="`Ask ${testName} something...`" :disabled="isStreaming" :is-streaming="isStreaming" :project-display-path="projectDisplayPath" @send="handleSend" @stop="stopStreaming" />
  </div>
</template>
