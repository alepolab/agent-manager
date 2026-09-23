<script setup lang="ts">
import type { DisplayChatMessage } from '~/types'

const props = defineProps<{
  messages: DisplayChatMessage[]
  isStreaming?: boolean
}>()

const emit = defineEmits<{
  (e: 'permissionRespond', permissionId: string, decision: 'allow' | 'deny', remember?: boolean, updatedInput?: any): void
  (e: 'openFile', filePath: string): void
}>()

// Track which user message is showing "copied" state
const copiedMessageId = ref<string | null>(null)

async function copyUserMessage(messageId: string, content: string) {
  try {
    await navigator.clipboard.writeText(content)
    copiedMessageId.value = messageId
    setTimeout(() => { copiedMessageId.value = null }, 2000)
  } catch (e) {
    console.error('Failed to copy:', e)
  }
}

// Group consecutive assistant messages together
interface MessageGroup {
  id: string
  role: 'user' | 'assistant'
  timestamp: string
  messages: DisplayChatMessage[]
}

const messageGroups = computed<MessageGroup[]>(() => {
  const groups: MessageGroup[] = []
  let currentGroup: MessageGroup | null = null

  for (const message of props.messages) {
    const messageRole = message.role || (message.kind === 'text' && message.content ? 'assistant' : 'assistant')

    // Check if we should continue the current group or start a new one
    if (currentGroup && currentGroup.role === messageRole) {
      // Same role - add to current group
      currentGroup.messages.push(message)
    } else {
      // Different role - push current group and start a new one
      if (currentGroup) {
        groups.push(currentGroup)
      }
      currentGroup = {
        id: message.id,
        role: messageRole,
        timestamp: message.timestamp,
        messages: [message]
      }
    }
  }

  if (currentGroup) {
    groups.push(currentGroup)
  }

  return groups
})

function handlePermissionRespond(permissionId: string, decision: 'allow' | 'deny', remember = false, updatedInput?: any) {
  emit('permissionRespond', permissionId, decision, remember, updatedInput)
}

function handleOpenFile(filePath: string) {
  emit('openFile', filePath)
}
</script>

<template>
  <div class="space-y-6">
    <!-- Message Groups -->
    <div
      v-for="group in messageGroups"
      :key="group.id"
      class="message-group min-w-0"
    >
      <!-- User Message Group.

           Both roles run down ONE column with one left edge, rather than the
           usual two-sided bubble chat. A transcript here is mostly long tool
           output and code, and right-aligning half of it while the other half
           is full width gives the eye two measures to track and cuts the
           readable width of whichever side is bubbled. What the reader needs
           instead is to tell the two apart at a glance without losing the
           line, which the rule and the label do at a fraction of the cost. -->
      <div v-if="group.role === 'user'" class="min-w-0 pl-3 border-l-2" style="border-color: var(--accent);">
        <div class="flex items-center gap-2 mb-1">
          <span class="t-small font-semibold" style="color: var(--accent);">You</span>
          <ClientOnly>
            <span class="t-small" style="color: var(--text-tertiary);">
              {{ new Date(group.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
            </span>
          </ClientOnly>
        </div>
        <div
          v-for="msg in group.messages"
          :key="msg.id"
          class="group relative min-w-0 mb-1.5 last:mb-0"
        >
          <div v-if="msg.images && msg.images.length > 0" class="flex flex-wrap gap-2 mb-2">
            <img v-for="(img, i) in msg.images" :key="i" :src="img" class="max-w-[160px] md:max-w-[200px] max-h-[160px] md:max-h-[200px] rounded-lg object-contain" style="background: var(--surface-raised);" />
          </div>
          <!-- Room is reserved for the copy button on the right rather than
               underneath: the old bubble padded every message's bottom to clear
               an absolutely-positioned button, which read as a blank line after
               everything the person had ever typed. -->
          <div v-if="msg.content" class="t-ui whitespace-pre-wrap break-words overflow-wrap-anywhere pr-8" style="color: var(--text-primary);">{{ msg.content }}</div>
          <button
            v-if="msg.content"
            class="absolute top-0 right-0 p-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity reveal-quiet focus-ring"
            title="Copy to clipboard"
            @click="copyUserMessage(msg.id, msg.content!)"
          >
            <UIcon
              :name="copiedMessageId === msg.id ? 'i-lucide-check' : 'i-lucide-copy'"
              class="size-3.5"
              :style="{ color: copiedMessageId === msg.id ? 'var(--success)' : 'var(--text-tertiary)' }"
            />
          </button>
        </div>
      </div>

      <!-- Assistant Message Group. Same left edge as the user's, so the
           conversation reads as one column. The avatar disc that used to sit
           here bought nothing a label does not: there are exactly two speakers
           and one of them is always Claude. -->
      <div v-else class="min-w-0 pl-3 border-l-2" style="border-color: var(--border-subtle);">
        <div class="flex items-center gap-2 mb-1">
          <span class="t-small font-semibold" style="color: var(--text-secondary);">Claude</span>
          <ClientOnly>
            <span class="t-small" style="color: var(--text-tertiary);">
              {{ new Date(group.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
            </span>
          </ClientOnly>
        </div>

        <div class="space-y-2 overflow-wrap-anywhere">
          <ChatV2MessageItem
            v-for="message in group.messages"
            :key="message.id"
            :message="message"
            :show-timestamp="false"
            @permission-respond="handlePermissionRespond"
            @open-file="handleOpenFile"
          />
        </div>
      </div>
    </div>

    <!-- Streaming indicator when streaming but no text yet -->
    <div
      v-if="isStreaming && messageGroups.length > 0 && !messageGroups[messageGroups.length - 1]?.messages.some(m => m.isStreaming)"
      class="min-w-0 pl-3 border-l-2"
      style="border-color: var(--border-subtle);"
    >
      <div class="flex items-center gap-2 mb-1">
        <span class="t-small font-semibold" style="color: var(--text-secondary);">Claude</span>
      </div>
      <div class="flex items-center gap-2 t-ui" style="color: var(--text-secondary);">
        <span class="thinking-dots">
          <span>●</span><span>●</span><span>●</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overflow-wrap-anywhere {
  overflow-wrap: anywhere;
  word-wrap: break-word;
  word-break: break-word;
}

/* Force content to respect container width */
.max-w-full {
  max-width: 100%;
}

.thinking-dots {
  display: inline-flex;
  gap: 3px;
}

.thinking-dots span {
  animation: thinking-bounce 1.4s infinite ease-in-out both;
  font-size: 8px;
}

.thinking-dots span:nth-child(1) {
  animation-delay: -0.32s;
}

.thinking-dots span:nth-child(2) {
  animation-delay: -0.16s;
}

.thinking-dots span:nth-child(3) {
  animation-delay: 0s;
}

@keyframes thinking-bounce {
  0%, 80%, 100% {
    transform: scale(0.6);
    opacity: 0.5;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}
</style>
