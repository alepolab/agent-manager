<script setup lang="ts">
import type { NotificationItem } from '~~/shared/types/notification'

/**
 * A /cli tool-permission prompt, answered from the inbox.
 *
 * The chat that raised it only ever showed "Allow Bash?" with the input folded
 * away; here the input is the page, because it is the whole of what is being
 * decided. Answering goes through the same route the chat's own banner uses,
 * and the server tells that chat the question is settled.
 *
 * AskUserQuestion is shown but not answered here: it wants a structured answer
 * the chat's own form collects, and allow/deny would send it an empty one.
 */
const props = defineProps<{ item: Extract<NotificationItem, { kind: 'permission' }> }>()
const emit = defineEmits<{ decided: [] }>()
const toast = useToast()

const p = computed(() => props.item.permission)
const input = computed(() => (p.value.toolInput ?? {}) as Record<string, any>)
const tool = computed(() => p.value.toolName.toLowerCase())
const isQuestion = computed(() => ['askuserquestion', 'ask_user', 'askuser', 'ask_user_question'].includes(tool.value))
const questions = computed(() => Array.isArray(input.value.questions) ? input.value.questions as { question?: string, header?: string, options?: { label: string, description?: string }[] }[] : [])
const chatLink = computed(() => p.value.projectName && p.value.sessionId !== 'unknown'
  ? `/cli/project/${encodeURIComponent(p.value.projectName)}/session/${encodeURIComponent(p.value.sessionId)}`
  : '/cli')

// How long before it denies itself.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })
const left = computed(() => Math.max(0, p.value.expiresAt - now.value))
const leftLabel = computed(() => {
  const s = Math.ceil(left.value / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})

const answering = ref(false)
const gone = ref(false)
async function answer(decision: 'allow' | 'deny') {
  answering.value = true
  try {
    await $fetch('/api/v2/permissions/respond', { method: 'POST', body: { permissionId: p.value.id, decision } })
    toast.add({ title: decision === 'allow' ? `Allowed ${p.value.toolName}` : `Denied ${p.value.toolName}`, color: 'success' })
    emit('decided')
  } catch (e: any) {
    // 410: answered in the chat, or timed out, while this pane was open.
    if (e?.statusCode === 410 || e?.response?.status === 410) { gone.value = true; emit('decided') }
    else toast.add({ title: 'Could not answer it', description: e?.data?.message || e?.message, color: 'error' })
  } finally { answering.value = false }
}

/** The fields shown on their own, so the JSON fallback does not repeat them. */
const SHOWN = ['command', 'description', 'file_path', 'old_string', 'new_string', 'content', 'questions']
const rest = computed(() => {
  const r = Object.fromEntries(Object.entries(input.value).filter(([k]) => !SHOWN.includes(k)))
  return Object.keys(r).length ? JSON.stringify(r, null, 2) : ''
})
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-lg p-3 space-y-1" style="background: var(--accent-muted); border: 1px solid var(--accent);" role="alert">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-terminal-square" class="size-4 shrink-0" style="color: var(--accent);" />
        <span class="t-label" style="color: var(--text-secondary);">A /cli chat is asking to use a tool</span>
        <span class="ml-auto t-small font-mono tabular" :style="{ color: left < 60_000 ? 'var(--error)' : 'var(--text-tertiary)' }" :title="'Denied automatically if nobody answers'">
          {{ left > 0 ? `denies itself in ${leftLabel}` : 'timing out' }}
        </span>
      </div>
      <p class="t-head" style="color: var(--text-primary);">{{ isQuestion ? 'The chat has a question for you' : `Allow ${p.toolName}?` }}</p>
      <p class="t-small text-label font-mono truncate" :title="p.workingDir">in {{ p.workingDir }}</p>
    </div>

    <!-- What the person asked for, so a command they expected can be told from one they did not. -->
    <div v-if="p.prompt" class="rounded-lg p-3 space-y-1" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <p class="t-label text-label">The message that led to this</p>
      <p class="t-small whitespace-pre-wrap max-h-40 overflow-y-auto" style="color: var(--text-secondary);">{{ p.prompt }}</p>
    </div>

    <!-- The call itself. -->
    <div class="rounded-lg p-3 space-y-2" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
      <p class="t-label text-label">{{ p.toolName }}</p>
      <template v-if="isQuestion">
        <div v-for="(q, i) in questions" :key="i" class="space-y-1">
          <p v-if="q.header" class="t-small font-medium" style="color: var(--text-primary);">{{ q.header }}</p>
          <p class="t-small" style="color: var(--text-secondary);">{{ q.question }}</p>
          <ul v-if="q.options?.length" class="t-small space-y-0.5 pl-4 list-disc text-label">
            <li v-for="o in q.options" :key="o.label">{{ o.label }}<template v-if="o.description"> — {{ o.description }}</template></li>
          </ul>
        </div>
      </template>
      <template v-else>
        <p v-if="input.description" class="t-small" style="color: var(--text-secondary);">{{ input.description }}</p>
        <pre v-if="input.command" class="t-small font-mono whitespace-pre-wrap rounded p-2 overflow-x-auto" style="background: var(--surface-base); color: var(--text-primary);">{{ input.command }}</pre>
        <p v-if="input.file_path" class="t-small font-mono break-all" style="color: var(--text-primary);">{{ input.file_path }}</p>
        <div v-if="input.old_string !== undefined || input.new_string !== undefined" class="grid gap-2 sm:grid-cols-2">
          <div>
            <p class="t-label text-label mb-1">Replaces</p>
            <pre class="t-small font-mono whitespace-pre-wrap rounded p-2 max-h-72 overflow-auto" style="background: color-mix(in srgb, var(--error) 6%, var(--surface-base)); color: var(--text-secondary);">{{ input.old_string }}</pre>
          </div>
          <div>
            <p class="t-label text-label mb-1">With</p>
            <pre class="t-small font-mono whitespace-pre-wrap rounded p-2 max-h-72 overflow-auto" style="background: color-mix(in srgb, var(--success) 6%, var(--surface-base)); color: var(--text-secondary);">{{ input.new_string }}</pre>
          </div>
        </div>
        <pre v-if="typeof input.content === 'string'" class="t-small font-mono whitespace-pre-wrap rounded p-2 max-h-72 overflow-auto" style="background: var(--surface-base); color: var(--text-secondary);">{{ input.content }}</pre>
        <pre v-if="rest" class="t-small font-mono whitespace-pre-wrap rounded p-2 max-h-72 overflow-auto" style="background: var(--surface-base); color: var(--text-secondary);">{{ rest }}</pre>
      </template>
    </div>

    <p v-if="gone" class="t-small" style="color: var(--warning);">No longer waiting: it was answered in the chat, or it timed out.</p>
    <div class="flex flex-wrap items-center gap-2">
      <template v-if="!isQuestion">
        <UButton size="sm" label="Allow" icon="i-lucide-shield-check" :loading="answering" :disabled="answering || gone" @click="answer('allow')" />
        <UButton size="sm" variant="soft" color="error" label="Deny" icon="i-lucide-shield-x" :disabled="answering || gone" @click="answer('deny')" />
      </template>
      <UButton :to="chatLink" size="sm" :variant="isQuestion ? 'solid' : 'ghost'" color="neutral" trailing-icon="i-lucide-arrow-right" :label="isQuestion ? 'Answer in chat' : 'Open the chat'" />
    </div>
  </div>
</template>
