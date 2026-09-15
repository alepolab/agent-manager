import type { Settings } from '~/types'

export function useSettings() {
  const settings = useState<Settings | null>('settings', () => null)
  const loading = useState('settingsLoading', () => false)
  const error = useState<string | null>('settingsError', () => null)

  async function load({ silent = false } = {}) {
    if (!silent) {
      loading.value = true
      error.value = null
    }
    try {
      const next = await $fetch<Settings>('/api/settings')
      // Watchers on `settings` rewrite form inputs, so an unchanged background load must not reassign it.
      if (silent && JSON.stringify(next) === JSON.stringify(settings.value)) return
      settings.value = next
    } catch (e: unknown) {
      if (silent) return
      const msg = e instanceof Error ? e.message : 'Failed to load settings'
      error.value = msg
      console.error('[useSettings] load:', msg)
    } finally {
      if (!silent) loading.value = false
    }
  }

  async function save(data: Settings) {
    settings.value = await $fetch<Settings>('/api/settings', { method: 'PUT', body: data })
  }

  return { settings, loading, error, load, save }
}
