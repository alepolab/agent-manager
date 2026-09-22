<script setup lang="ts">
import type { QueueTask } from '~~/shared/types/queue'

/**
 * The whole project, always visible.
 *
 * A run only exists while it is executing, so before this page the only thing
 * anyone could see was the one task currently running — the other forty were
 * in a plan document. Listing every task, including the ones deliberately not
 * being run, is the point: "what are we doing" and "what is executing right
 * now" are different questions and the second one was the only one the app
 * could answer.
 */
type Row = QueueTask & { ready?: boolean }

const { can } = useUser()
const toast = useToast()
const queue = ref<{ project: string, tasks: Row[] } | null>(null)
const loadError = ref<string | null>(null)
const dispatching = ref(false)
const held = ref<Record<string, string>>({})

async function load() {
  try {
    queue.value = await $fetch('/api/queue')
    loadError.value = null
  } catch (e: any) {
    loadError.value = e.data?.message || e.message
  }
}
onMounted(load)
// A run settling dispatches the next task server-side, so the page has to look
// again to see it. Ten seconds: the work takes minutes, not seconds.
const timer = setInterval(load, 10_000)
onUnmounted(() => clearInterval(timer))

async function dispatch() {
  dispatching.value = true
  try {
    const r = await $fetch<{ started: string[], held: Record<string, string> }>('/api/queue/dispatch', { method: 'POST' })
    held.value = r.held
    toast.add({
      title: r.started.length ? `Started ${r.started.join(', ')}` : 'Nothing could start right now',
      description: r.started.length ? undefined : Object.values(r.held)[0],
      color: r.started.length ? 'success' : 'info',
    })
    await load()
  } catch (e: any) {
    toast.add({ title: 'Dispatch failed', description: e.data?.message || e.message, color: 'error' })
  } finally {
    dispatching.value = false
  }
}

async function retry(task: Row) {
  try {
    await $fetch(`/api/queue/${task.id}`, { method: 'PATCH', body: { status: 'pending' } })
    await load()
  } catch (e: any) {
    toast.add({ title: 'Could not requeue', description: e.data?.message || e.message, color: 'error' })
  }
}

const STATUS_ORDER: QueueTask['status'][] = ['running', 'pending', 'failed', 'done', 'skipped']
const counts = computed(() => {
  const c: Record<string, number> = {}
  for (const t of queue.value?.tasks ?? []) c[t.status] = (c[t.status] ?? 0) + 1
  return c
})
const grouped = computed(() => STATUS_ORDER
  .map(status => ({ status, tasks: (queue.value?.tasks ?? []).filter(t => t.status === status).sort((a, b) => a.order - b.order) }))
  .filter(g => g.tasks.length))

const COLOR: Record<QueueTask['status'], string> = {
  running: 'var(--accent)', pending: 'var(--text-secondary)', failed: 'var(--error)',
  done: 'var(--success)', skipped: 'var(--text-disabled)',
}
const LABEL: Record<QueueTask['status'], string> = {
  running: 'Running', pending: 'Waiting', failed: 'Failed', done: 'Done', skipped: 'Not run by an agent',
}
/** Why a waiting task is waiting, in the words the server used. */
function why(t: Row): string {
  if (t.status !== 'pending') return t.note ?? ''
  if (held.value[t.id]) return held.value[t.id]!
  if (!t.ready) return `waiting for ${t.deps.join(', ')}`
  return 'ready — will start when a slot frees'
}
</script>

<template>
  <div>
    <PageHeader :title="queue?.project || 'Work queue'">
      <template #subtitle>
        <p class="t-small text-meta">
          Every task in the project, including the ones no agent will run. Runs are minted one at a
          time as checkouts and capacity free up.
        </p>
      </template>
      <template #right>
        <UButton
          v-if="can('startRun')"
          label="Start what can start"
          icon="i-lucide-play"
          size="sm"
          :loading="dispatching"
          @click="dispatch"
        />
      </template>
    </PageHeader>

    <div class="page space-y-5">
      <div v-if="loadError" class="rounded-xl px-4 py-3 t-small" style="background: rgba(248,113,113,0.06); border: 1px solid rgba(248,113,113,0.2); color: var(--error);" role="alert">
        {{ loadError }}
      </div>

      <div v-else-if="!queue" class="space-y-2" aria-busy="true"><SkeletonCard v-for="i in 2" :key="i" /></div>

      <div v-else-if="!queue.tasks.length" class="t-ui text-label py-10 text-center">
        No queue yet. Create one with <span class="font-mono t-small">POST /api/queue</span>, or
        <span class="font-mono t-small">node scripts/blossom-runs.mjs --queue</span>.
      </div>

      <template v-else>
        <div class="flex flex-wrap gap-3 t-small">
          <span v-for="s in STATUS_ORDER" :key="s" v-show="counts[s]" class="rounded-lg px-3 py-1.5" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
            <span :style="{ color: COLOR[s] }">{{ LABEL[s] }}</span>
            <span class="ml-2 tabular-nums">{{ counts[s] }}</span>
          </span>
        </div>

        <section v-for="g in grouped" :key="g.status">
          <h2 class="text-section-label mb-2">
            {{ LABEL[g.status] }} <span class="text-meta font-normal">{{ g.tasks.length }}</span>
          </h2>
          <div class="space-y-1">
            <div
              v-for="t in g.tasks"
              :key="t.id"
              class="flex items-start gap-3 px-3 py-2.5 rounded-lg"
              style="background: var(--surface-raised); border: 1px solid var(--border-subtle);"
            >
              <span class="font-mono t-small font-medium w-16 shrink-0" :style="{ color: COLOR[t.status] }">{{ t.id }}</span>
              <div class="min-w-0 flex-1">
                <div class="t-ui">{{ t.title }}</div>
                <div class="t-small text-label mt-0.5">
                  <span v-if="t.module" class="font-mono">{{ t.module }}</span>
                  <span v-if="t.module && why(t)"> · </span>
                  <span>{{ why(t) }}</span>
                </div>
              </div>
              <NuxtLink v-if="t.runId" :to="`/runs/${t.runId}`" class="t-small underline shrink-0 focus-ring">run</NuxtLink>
              <UButton
                v-if="t.status === 'failed' && can('startRun')"
                label="Requeue" size="xs" variant="ghost" color="neutral" class="shrink-0"
                @click="retry(t)"
              />
            </div>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
