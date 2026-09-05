<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import { RUN_STATUS_COLOR } from '~/utils/runStatus'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const runs = ref<WorkflowRun[]>([])
const loaded = ref(false)
const loadError = ref<string | null>(null)
const busy = ref<string | null>(null)

// Filters live in the URL so a filtered view can be shared or reloaded.
const filter = computed({
  get: () => (typeof route.query.q === 'string' ? route.query.q : ''),
  set: v => router.replace({ query: { ...route.query, q: v || undefined } }),
})
const status = computed({
  get: () => (typeof route.query.status === 'string' ? route.query.status : ''),
  set: v => router.replace({ query: { ...route.query, status: v || undefined } }),
})

async function refresh() {
  try {
    runs.value = await $fetch<WorkflowRun[]>('/api/runs')
    loadError.value = null
  } catch (e: any) {
    loadError.value = e.data?.message || e.message || 'Failed to load runs'
  } finally {
    loaded.value = true
  }
}

// Poll only while something can change; a static list must not hammer the server.
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  refresh()
  timer = setInterval(() => {
    if (runs.value.some(r => r.status === 'running' || r.status === 'paused')) refresh()
  }, 5000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })

const STATUSES = ['running', 'paused', 'completed', 'failed', 'stopped', 'interrupted']
const shown = computed(() => runs.value.filter(r =>
  (!filter.value || r.workflowName.toLowerCase().includes(filter.value.toLowerCase()))
  && (!status.value || r.status === status.value)))

const duration = (r: WorkflowRun) => {
  const secs = Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000)
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
}
/** The step a one-click restart resumes from: the failed one, or what was executing. */
const restartPoint = (r: WorkflowRun) =>
  r.steps.find(s => s.status === 'failed')?.stepId
  ?? r.currentStepIds[0]
  ?? r.steps.find(s => s.status !== 'completed')?.stepId
const canRestart = (r: WorkflowRun) => ['failed', 'stopped', 'interrupted'].includes(r.status) && !!restartPoint(r)
const canStop = (r: WorkflowRun) => r.status === 'running' || r.status === 'paused'

// Stop is irreversible for the step in flight: ask once, inline, then forget.
const confirmingStop = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null
function stop(r: WorkflowRun) {
  if (confirmingStop.value !== r.id) {
    confirmingStop.value = r.id
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => { confirmingStop.value = null }, 4000)
    return
  }
  confirmingStop.value = null
  act(r, 'stop')
}

async function act(r: WorkflowRun, path: 'restart' | 'stop', body?: unknown) {
  busy.value = r.id
  try {
    await $fetch(`/api/runs/${r.id}/${path}`, { method: 'POST', body })
    await refresh()
    if (path === 'restart') navigateTo(`/workflows/${r.workflowSlug}?run=${r.id}`)
  } catch (e: any) {
    toast.add({ title: `Failed to ${path}`, description: e.data?.message || e.message, color: 'error' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div>
    <PageHeader title="Runs">
      <template #trailing>
        <span class="text-[12px] text-meta">{{ runs.length }}</span>
      </template>
    </PageHeader>

    <div class="px-6 py-4 space-y-4">
      <p class="text-[13px] leading-relaxed text-label">
        Every workflow run, newest first. Open a run in its builder, restart a failed one from the step that failed, or clone its inputs into a new run.
      </p>

      <div class="flex gap-2 items-center">
        <input v-model="filter" placeholder="Filter by workflow..." class="field-search max-w-xs" aria-label="Filter by workflow name" />
        <select v-model="status" class="field-input w-40" aria-label="Filter by status">
          <option value="">All statuses</option>
          <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>

      <div
        v-if="loadError"
        class="rounded-xl px-4 py-3 flex items-center gap-3"
        style="background: rgba(248, 113, 113, 0.06); border: 1px solid rgba(248, 113, 113, 0.12);"
      >
        <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" style="color: var(--error);" />
        <span class="text-[12px]" style="color: var(--error);">{{ loadError }}</span>
        <UButton size="xs" variant="soft" label="Retry" class="ml-auto" @click="refresh" />
      </div>

      <div v-else-if="!loaded" class="space-y-2" aria-busy="true">
        <SkeletonCard v-for="i in 3" :key="i" />
      </div>

      <p v-else-if="!runs.length" class="text-[13px] text-label">
        No runs yet. Start one with the Run button on a <NuxtLink to="/workflows" class="underline">workflow card</NuxtLink>.
      </p>

      <p v-else-if="!shown.length" class="text-[13px] text-label">No runs match these filters.</p>

      <div v-else class="overflow-x-auto rounded-xl" style="border: 1px solid var(--border-subtle);">
        <table class="w-full text-[12px]">
          <thead>
            <tr class="text-left text-label" style="background: var(--surface-raised);">
              <th class="px-3 py-2 font-medium">Workflow</th>
              <th class="px-3 py-2 font-medium">Status</th>
              <th class="px-3 py-2 font-medium">Started</th>
              <th class="px-3 py-2 font-medium">Duration</th>
              <th class="px-3 py-2 font-medium w-40">Steps</th>
              <th class="px-3 py-2 font-medium">Prompt</th>
              <th class="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody aria-live="polite">
            <tr v-for="r in shown" :key="r.id" style="border-top: 1px solid var(--border-subtle);">
              <td class="px-3 py-2 font-medium">{{ r.workflowName }}</td>
              <td class="px-3 py-2 font-mono uppercase text-[11px]" :style="{ color: RUN_STATUS_COLOR[r.status] }">{{ r.status }}</td>
              <td class="px-3 py-2 text-label whitespace-nowrap">{{ new Date(r.startedAt).toLocaleString() }}</td>
              <td class="px-3 py-2 text-label whitespace-nowrap">{{ duration(r) }}</td>
              <td class="px-3 py-2"><RunProgressBar :steps="r.steps" /></td>
              <td class="px-3 py-2 text-label truncate max-w-[12rem]" :title="r.initialPrompt">{{ r.initialPrompt }}</td>
              <td class="px-3 py-2">
                <div class="flex gap-1 justify-end">
                  <UButton size="xs" variant="ghost" label="Open" :to="`/workflows/${r.workflowSlug}?run=${r.id}`" />
                  <UButton v-if="canRestart(r)" size="xs" variant="soft" icon="i-lucide-rotate-ccw" label="Restart" :loading="busy === r.id" @click="act(r, 'restart', { stepId: restartPoint(r) })" />
                  <UButton size="xs" variant="ghost" icon="i-lucide-copy" label="Clone" :to="`/workflows/${r.workflowSlug}?clone=${r.id}`" />
                  <UButton
                    v-if="canStop(r)"
                    size="xs" :variant="confirmingStop === r.id ? 'solid' : 'ghost'" :color="confirmingStop === r.id ? 'error' : 'neutral'"
                    :label="confirmingStop === r.id ? 'Confirm stop' : 'Stop'" :loading="busy === r.id" @click="stop(r)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
