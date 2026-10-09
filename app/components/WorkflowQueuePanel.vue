<script setup lang="ts">
/**
 * A workflow's run queue (server/utils/workflowQueue.ts): what runs next, what
 * ran, why it paused. Start / Pause, and reorder or drop items not started yet.
 * Shown only when the workflow has a queue; refreshes itself while it is on.
 */
interface QueueItem {
  prompt: string
  parameters?: Record<string, string>
  status: 'pending' | 'running' | 'done' | 'stopped'
  runId?: string
  startedAt?: number
  endedAt?: number
  note?: string
}
interface WorkflowQueue {
  enabled: boolean
  pausedReason?: string
  defaults: Record<string, unknown>
  items: QueueItem[]
}

const props = defineProps<{ slug: string, canEdit: boolean }>()

const queue = ref<WorkflowQueue | null>(null)
const busy = ref(false)
const open = ref(true)
const error = ref('')

async function load() {
  try {
    queue.value = (await $fetch<{ queue: WorkflowQueue | null }>(`/api/workflows/${props.slug}/queue`)).queue
    error.value = ''
  } catch (err: any) {
    error.value = err?.data?.message ?? err?.message ?? String(err)
  }
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  load()
  timer = setInterval(() => { if (queue.value?.enabled || queue.value?.items.some(i => i.status === 'running')) load() }, 15000)
})
onBeforeUnmount(() => clearInterval(timer))

async function act(action: 'start' | 'pause') {
  busy.value = true
  try {
    queue.value = (await $fetch<{ queue: WorkflowQueue }>(`/api/workflows/${props.slug}/queue/${action}`, { method: 'POST' })).queue
  } catch (err: any) {
    error.value = err?.data?.message ?? err?.message ?? String(err)
  } finally { busy.value = false }
}

async function saveItems(items: QueueItem[]) {
  if (!queue.value) return
  busy.value = true
  try {
    queue.value = (await $fetch<{ queue: WorkflowQueue }>(`/api/workflows/${props.slug}/queue`, { method: 'PUT', body: { ...queue.value, items } })).queue
  } catch (err: any) {
    error.value = err?.data?.message ?? err?.message ?? String(err)
  } finally { busy.value = false }
}

function move(index: number, by: -1 | 1) {
  const items = [...queue.value!.items]
  const to = index + by
  if (to < 0 || to >= items.length || items[to]!.status !== 'pending') return
  ;[items[index], items[to]] = [items[to]!, items[index]!]
  saveItems(items)
}
function drop(index: number) {
  const items = [...queue.value!.items]
  items.splice(index, 1)
  saveItems(items)
}
function retry(index: number) {
  const items = queue.value!.items.map((it, i) => i === index ? { prompt: it.prompt, parameters: it.parameters, status: 'pending' as const } : it)
  saveItems(items)
}

const counts = computed(() => {
  const c = { pending: 0, running: 0, done: 0, stopped: 0 }
  for (const i of queue.value?.items ?? []) c[i.status]++
  return c
})
const statusColor: Record<QueueItem['status'], string> = {
  pending: 'var(--text-tertiary)', running: 'var(--accent-primary)', done: 'var(--success)', stopped: 'var(--warning)',
}
</script>

<template>
  <section v-if="queue" data-testid="workflow-queue" class="mx-4 my-2 rounded-xl" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
    <header class="flex items-center gap-3 px-4 py-2">
      <button class="flex items-center gap-2 min-w-0 focus-ring" :aria-expanded="open" @click="open = !open">
        <UIcon :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4" />
        <span class="t-ui font-semibold text-strong">Run queue</span>
      </button>
      <span class="t-small" :style="{ color: queue.enabled ? 'var(--success)' : 'var(--text-tertiary)' }">
        {{ queue.enabled ? 'on' : 'paused' }}
      </span>
      <span class="t-small text-label truncate">
        {{ counts.done }} done · {{ counts.running }} running · {{ counts.pending }} to go<template v-if="counts.stopped"> · {{ counts.stopped }} stopped</template>
      </span>
      <span class="flex-1" />
      <template v-if="canEdit">
        <UButton v-if="!queue.enabled" label="Start" icon="i-lucide-play" size="xs" :loading="busy" @click="act('start')" />
        <UButton v-else label="Pause" icon="i-lucide-pause" size="xs" variant="soft" :loading="busy" @click="act('pause')" />
      </template>
    </header>
    <p v-if="queue.pausedReason && !queue.enabled" class="px-4 pb-2 t-small" style="color: var(--warning);">{{ queue.pausedReason }}</p>
    <p v-if="error" class="px-4 pb-2 t-small" style="color: var(--error);">{{ error }}</p>
    <ol v-if="open" class="m-0 px-2 pb-2 max-h-80 overflow-y-auto list-none">
      <li
        v-for="(item, i) in queue.items" :key="`${i}-${item.prompt}`"
        class="flex items-center gap-2 px-2 py-1 rounded-md t-small"
        :style="item.status === 'running' ? 'background: var(--surface-hover);' : ''"
      >
        <span class="w-14 shrink-0 font-medium" :style="{ color: statusColor[item.status] }">{{ item.status }}</span>
        <span class="truncate flex-1 min-w-0" :title="item.note || item.prompt">
          {{ item.prompt }}
          <span v-if="item.note" class="text-label"> - {{ item.note }}</span>
        </span>
        <NuxtLink v-if="item.runId" :to="`/runs/${item.runId}`" class="shrink-0 underline text-label">run {{ item.runId.slice(0, 8) }}</NuxtLink>
        <template v-if="canEdit && item.status === 'pending'">
          <UButton icon="i-lucide-arrow-up" size="xs" variant="ghost" aria-label="Move up" :disabled="busy || i === 0 || queue.items[i - 1]?.status !== 'pending'" @click="move(i, -1)" />
          <UButton icon="i-lucide-arrow-down" size="xs" variant="ghost" aria-label="Move down" :disabled="busy || i === queue.items.length - 1" @click="move(i, 1)" />
          <UButton icon="i-lucide-x" size="xs" variant="ghost" color="error" aria-label="Remove from queue" :disabled="busy" @click="drop(i)" />
        </template>
        <UButton v-if="canEdit && item.status === 'stopped'" icon="i-lucide-rotate-ccw" size="xs" variant="ghost" aria-label="Queue again" :disabled="busy" @click="retry(i)" />
      </li>
    </ol>
  </section>
</template>
