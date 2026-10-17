import type { Machine } from '~/types'

/** The machines a run's agents can execute on, and which one is the default. See server/utils/machines.ts. */
export function useMachines() {
  const machines = useState<Machine[]>('machines', () => [])
  const defaultMachineId = useState<string | null>('machinesDefault', () => null)
  const loading = useState('machinesLoading', () => false)

  async function load({ silent = false } = {}) {
    if (!silent) loading.value = true
    try {
      const r = await $fetch<{ machines: Machine[], defaultMachineId: string | null }>('/api/machines')
      machines.value = r.machines
      defaultMachineId.value = r.defaultMachineId
    } catch {
      if (!silent) { machines.value = []; defaultMachineId.value = null }
    } finally {
      if (!silent) loading.value = false
    }
  }

  async function save(body: Record<string, unknown>, id?: string): Promise<Machine> {
    const saved = id
      ? await $fetch<Machine>(`/api/machines/${id}`, { method: 'PUT', body })
      : await $fetch<Machine>('/api/machines', { method: 'POST', body })
    await load({ silent: true })
    return saved
  }

  async function remove(id: string) {
    await $fetch(`/api/machines/${id}`, { method: 'DELETE' })
    await load({ silent: true })
  }

  async function check(id: string) {
    const verdict = await $fetch<NonNullable<Machine['lastCheck']>>(`/api/machines/${id}/check`, { method: 'POST' })
    await load({ silent: true })
    return verdict
  }

  async function setDefault(id: string | null) {
    await $fetch('/api/machines/default', { method: 'PUT', body: { machineId: id } })
    defaultMachineId.value = id
  }

  /** The name a run, a workflow or the list should show for an id. */
  const nameOf = (id: string | null | undefined) => {
    if (!id) return null
    if (id === 'local') return 'This server'
    return machines.value.find(m => m.id === id)?.name ?? `${id.slice(0, 8)} (removed)`
  }

  return { machines, defaultMachineId, loading, load, save, remove, check, setDefault, nameOf }
}
