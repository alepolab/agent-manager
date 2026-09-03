import type { Watch, TicketState } from '~~/shared/types/watch'

export interface WatchPayload {
  id?: string
  name: string
  workflowSlug: string
  intervalSeconds?: number
  enabled?: boolean
  maxConcurrentRuns?: number
  dailyDispatchCap?: number
  query?: string
  projectDir?: string
  autoRun?: boolean
}

export interface CycleResult {
  dispatched: string[]
  skipped: string[]
  failed: string[]
}

/**
 * Watches are keyed by `id`, not `slug`, and carry a second per-watch
 * resource (ticket state) the generic `useCrud` shape doesn't model — so
 * this composable is hand-rolled, following `useCrud`'s state/loading/error
 * pattern and `useWorkflowRun`'s "server owns the state, we subscribe to
 * it" shape rather than reusing either directly.
 */
export function useWatches() {
  const watches = useState<Watch[]>('watches', () => [])
  const loading = useState('watchesLoading', () => false)
  const error = useState<string | null>('watchesError', () => null)
  const states = useState<Record<string, Record<string, TicketState>>>('watchStates', () => ({}))
  const polling = useState<Record<string, boolean>>('watchesPolling', () => ({}))

  async function fetchAll() {
    loading.value = true
    error.value = null
    try {
      watches.value = await $fetch<Watch[]>('/api/watches')
    } catch (e: any) {
      error.value = e?.data?.message || e?.message || 'Failed to load watches'
    } finally {
      loading.value = false
    }
  }

  async function save(payload: WatchPayload): Promise<Watch> {
    const saved = await $fetch<Watch>('/api/watches', { method: 'POST', body: payload })
    const idx = watches.value.findIndex(w => w.id === saved.id)
    if (idx >= 0) watches.value[idx] = saved
    else watches.value.push(saved)
    return saved
  }

  /** Flip `enabled` on an existing watch — round-trips every other field
   *  unchanged so a toggle never silently resets caps or the query. */
  async function setEnabled(watch: Watch, enabled: boolean): Promise<Watch> {
    return await save({ ...watch, enabled })
  }

  async function fetchState(id: string): Promise<Record<string, TicketState>> {
    const state = await $fetch<Record<string, TicketState>>(`/api/watches/${id}/state`)
    states.value = { ...states.value, [id]: state }
    return state
  }

  /** Forces one cycle right now — how an operator tests a watch without
   *  waiting for `intervalSeconds`. Refreshes ticket state afterward so the
   *  page reflects whatever the cycle just did. */
  async function poll(id: string): Promise<CycleResult> {
    polling.value = { ...polling.value, [id]: true }
    try {
      const result = await $fetch<CycleResult>(`/api/watches/${id}/poll`, { method: 'POST' })
      await fetchState(id)
      return result
    } finally {
      polling.value = { ...polling.value, [id]: false }
    }
  }

  async function clearEscalation(id: string, key: string): Promise<TicketState> {
    const state = await $fetch<TicketState>(
      `/api/watches/${id}/tickets/${encodeURIComponent(key)}/clear`,
      { method: 'POST' },
    )
    states.value = { ...states.value, [id]: { ...states.value[id], [key]: state } }
    return state
  }

  return {
    watches,
    loading,
    error,
    states,
    polling,
    fetchAll,
    save,
    setEnabled,
    fetchState,
    poll,
    clearEscalation,
  }
}
