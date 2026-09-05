import type { WorkflowRun } from '~~/shared/types/run'

/**
 * Subscribes to a server-owned run. It does not drive anything — the server
 * does. That is what lets a run outlive this tab.
 */
export function useWorkflowRun(slug: string) {
  const run = ref<WorkflowRun | null>(null)
  const runs = ref<WorkflowRun[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  let source: EventSource | null = null

  function listen(runId: string) {
    source?.close()
    source = new EventSource(`/api/runs/${runId}/stream`)
    source.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data)
        if (payload.type === 'run') run.value = payload.run
        if (payload.type === 'done') { source?.close(); source = null; refreshRuns() }
      } catch { /* a malformed frame self-heals on the next one */ }
    }
    source.onerror = () => { source?.close(); source = null }
  }

  async function refreshRuns() {
    runs.value = await $fetch<WorkflowRun[]>(`/api/workflows/${slug}/runs`)
  }

  /** Attach to whatever is already running, if anything. Called on page load. */
  async function attach() {
    await refreshRuns()
    const active = runs.value.find(r => r.status === 'running' || r.status === 'paused')
    if (active) { run.value = active; listen(active.id) }
  }

  async function start(initialPrompt: string, projectDir?: string, autoRun = false) {
    loading.value = true
    error.value = null
    try {
      const started = await $fetch<WorkflowRun>(`/api/workflows/${slug}/runs`, {
        method: 'POST', body: { initialPrompt, projectDir, autoRun },
      })
      run.value = started
      listen(started.id)
      await refreshRuns()
    } catch (e: any) {
      // 409 means a run is already going; attaching to it is more useful than an error.
      if (e?.statusCode === 409 && e?.data?.data?.runId) {
        run.value = await $fetch<WorkflowRun>(`/api/runs/${e.data.data.runId}`)
        listen(run.value.id)
      } else {
        error.value = e?.data?.message || e?.message || 'Failed to start run'
      }
    } finally {
      loading.value = false
    }
  }

  // listen() again after every action: a finished run has no open stream, so
  // without it a restart's progress would never reach the page.
  const act = (path: string) => async (body?: unknown) => {
    if (!run.value) return
    run.value = await $fetch<WorkflowRun>(`/api/runs/${run.value.id}/${path}`, { method: 'POST', body })
    listen(run.value.id)
  }

  onScopeDispose(() => source?.close())

  return {
    run, runs, loading, error, attach, start, refreshRuns,
    continueRun: () => act('continue')(),
    restart: (stepId: string, note?: string) => act('restart')({ stepId, note: note?.trim() || undefined }),
    respond: async (reply: string) => {
      if (!run.value) return
      run.value = await $fetch<WorkflowRun>(`/api/runs/${run.value.id}/respond`, { method: 'POST', body: { reply } })
    },
    stop: () => act('stop')(),
  }
}
