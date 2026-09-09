import type { Schedule, ScheduleState } from '~~/shared/types/schedule'

export interface SchedulePayload {
  id?: string
  name: string
  workflowSlug: string
  cron: string
  timezone?: string
  /** See Schedule.projectDir. Omitted keeps the stored value; '' clears it
   *  back to the derived directory. */
  projectDir?: string
  enabled?: boolean
  initialPrompt: string
  parameters?: Record<string, string>
  autoRun?: boolean
}

/** A schedule as the list route returns it: the record plus the two things a
 *  reader cannot derive from it. */
export interface ScheduleRow extends Schedule {
  /** ISO, or null when the expression will not parse. */
  nextFireAt: string | null
  /** The directory its runs will actually work in: the one it states
   *  (`projectDir`), else the one derived from its id. Server-derived, so it
   *  cannot disagree with where the run takes its lock. */
  workspace: string
  state: ScheduleState
}

export interface DeleteScheduleResult {
  deleted: boolean
  id: string
  stateDeleted: boolean
}

/**
 * Schedules are keyed by `id` and carry per-schedule state the generic
 * `useCrud` shape does not model, so this is hand-rolled the way `useWatches`
 * is, and follows the same state/loading/error pattern.
 */
export function useSchedules() {
  const schedules = useState<ScheduleRow[]>('schedules', () => [])
  const loading = useState('schedulesLoading', () => false)
  const error = useState<string | null>('schedulesError', () => null)
  const firing = useState<Record<string, boolean>>('schedulesFiring', () => ({}))

  async function fetchAll() {
    loading.value = true
    error.value = null
    try {
      schedules.value = await $fetch<ScheduleRow[]>('/api/schedules')
    } catch (e: any) {
      error.value = e?.data?.message || e?.message || 'Failed to load schedules'
    } finally {
      loading.value = false
    }
  }

  /** The POST returns the saved record without state, so the list is refetched
   *  rather than patched: `nextFireAt` and `workspace` are server-derived and
   *  guessing them here would put two answers in the UI. */
  async function save(payload: SchedulePayload): Promise<void> {
    await $fetch('/api/schedules', { method: 'POST', body: payload })
    await fetchAll()
  }

  /** Flip `enabled`, round-tripping every other field so a toggle can never
   *  silently reset the expression or the stated inputs. */
  async function setEnabled(schedule: ScheduleRow, enabled: boolean): Promise<void> {
    await save({
      id: schedule.id,
      name: schedule.name,
      workflowSlug: schedule.workflowSlug,
      cron: schedule.cron,
      timezone: schedule.timezone,
      projectDir: schedule.projectDir,
      initialPrompt: schedule.initialPrompt,
      parameters: schedule.parameters,
      autoRun: schedule.autoRun,
      enabled,
    })
  }

  /** Fires one now — how an operator checks a schedule does what they meant
   *  without waiting for 2am. Works on a disabled schedule on purpose. */
  async function fire(id: string): Promise<ScheduleState> {
    firing.value = { ...firing.value, [id]: true }
    try {
      const result = await $fetch<ScheduleState>(`/api/schedules/${id}/fire`, { method: 'POST' })
      await fetchAll()
      return result
    } finally {
      firing.value = { ...firing.value, [id]: false }
    }
  }

  async function remove(id: string): Promise<DeleteScheduleResult> {
    const result = await $fetch<DeleteScheduleResult>(`/api/schedules/${id}`, { method: 'DELETE' })
    schedules.value = schedules.value.filter(s => s.id !== id)
    const next = { ...firing.value }
    delete next[id]
    firing.value = next
    return result
  }

  return { schedules, loading, error, firing, fetchAll, save, setEnabled, fire, remove }
}
