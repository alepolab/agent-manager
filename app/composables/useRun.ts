import { isLiveStatus, type WorkflowRun } from '~~/shared/types/run'

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
  /** Background refresh. An open stream already keeps the run current; a closed one would miss a
   *  restart or continue made from another tab, so reopen it once the run is live again. */
  async function refresh() {
    if (source) return
    run.value = await $fetch<WorkflowRun>(`/api/runs/${id}`)
    error.value = null
    if (isLiveStatus(run.value.status)) listen()
  }
  const act = (path: string) => async (body?: Record<string, unknown>) => {
    run.value = await $fetch<WorkflowRun>(`/api/runs/${id}/${path}`, { method: 'POST', body })
    listen()
  }
  onScopeDispose(() => source?.close())
  return {
    run, logs, error, load, refresh,
    continueRun: (note?: string) => act('continue')(note?.trim() ? { note: note.trim() } : undefined),
    respond: (reply: string) => act('respond')({ reply }),
    sendNote: (text: string) => $fetch<{ delivered?: string[], queued?: string }>(`/api/runs/${id}/note`, { method: 'POST', body: { text } }),
    stop: () => act('stop')(),
    /** End the run at a gate. The note is required — see the route's doc comment. */
    reject: (note: string) => act('reject')({ note: note.trim() }),
    /**
     * Send the work back to a chosen earlier step, with the instruction that
     * step will work from. The run continues; `reject` is the one that ends it.
     */
    rework: (stepId: string, note: string) => act('rework')({ stepId, note: note.trim() }),
    restart: (stepId: string, note?: string) => act('restart')({ stepId, note: note?.trim() || undefined }),
  }
}

/**
 * The gate and run actions with the toasts that report them, shared by the run
 * page and the /notifications detail pane, so both say the same thing about
 * what a button just did.
 */
export function useRunActionToasts(r: Pick<ReturnType<typeof useRun>, 'run' | 'reject' | 'rework' | 'sendNote' | 'restart'>) {
  const toast = useToast()
  async function onReject(note: string) {
    try {
      await r.reject(note)
      // This toast used to say "Sent back", which described something the route
      // does not do: reject stops the run. Sending back to a step is `onRework`.
      toast.add({ title: 'Run rejected', description: 'The run is stopped and your reason is on the record.', color: 'success' })
    } catch (e: any) { toast.add({ title: 'Could not reject it', description: e.data?.message || e.message, color: 'error' }) }
  }
  async function onRework(stepId: string, note: string) {
    try {
      await r.rework(stepId, note)
      const label = r.run.value?.steps.find(s => s.stepId === stepId)?.label ?? 'that step'
      toast.add({ title: `Sent back to ${label}`, description: 'It restarts with your instruction.', color: 'success' })
    } catch (e: any) { toast.add({ title: 'Could not send it back', description: e.data?.message || e.message, color: 'error' }) }
  }
  async function onNote(text: string) {
    try {
      const res = await r.sendNote(text)
      toast.add({ title: res.delivered?.length ? `Sent to ${res.delivered.join(', ')}` : 'Note queued for the next step', color: 'success' })
    } catch (e: any) { toast.add({ title: 'Could not send the note', description: e.data?.message || e.message, color: 'error' }) }
  }
  async function onRestart(stepId: string, note?: string) {
    try { await r.restart(stepId, note) } catch (e: any) { toast.add({ title: 'Could not restart', description: e.data?.message || e.message, color: 'error' }) }
  }
  return { onReject, onRework, onNote, onRestart }
}
