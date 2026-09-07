import type { WorkflowRun } from '~~/shared/types/run'

/** One run by id: the record, its live output, and the actions on it. Streams while it is alive. */
export function useRun(id: string) {
  const run = ref<WorkflowRun | null>(null)
  const logs = ref<Record<string, string[]>>({})
  const error = ref<string | null>(null)
  let source: EventSource | null = null

  function listen() {
    source?.close()
    source = new EventSource(`/api/runs/${id}/stream`)
    source.onmessage = (e) => {
      try {
        const p = JSON.parse(e.data)
        if (p.type === 'run') run.value = p.run
        if (p.type === 'log-snapshot') logs.value = p.logs ?? {}
        if (p.type === 'log') logs.value = { ...logs.value, [p.stepId]: [...(logs.value[p.stepId] ?? []), p.line].slice(-400) }
        if (p.type === 'done') { source?.close(); source = null }
      } catch { /* a malformed frame self-heals on the next one */ }
    }
    source.onerror = () => { source?.close(); source = null }
  }
  async function load() {
    try { run.value = await $fetch<WorkflowRun>(`/api/runs/${id}`); error.value = null; listen() }
    catch (e: any) { error.value = e.data?.message || e.message }
  }
  const act = (path: string) => async (body?: Record<string, unknown>) => {
    run.value = await $fetch<WorkflowRun>(`/api/runs/${id}/${path}`, { method: 'POST', body })
    listen()
  }
  onScopeDispose(() => source?.close())
  return {
    run, logs, error, load,
    continueRun: (note?: string) => act('continue')(note?.trim() ? { note: note.trim() } : undefined),
    respond: (reply: string) => act('respond')({ reply }),
    sendNote: async (text: string) => { await $fetch(`/api/runs/${id}/note`, { method: 'POST', body: { text } }) },
    stop: () => act('stop')(),
    restart: (stepId: string, note?: string) => act('restart')({ stepId, note: note?.trim() || undefined }),
  }
}
