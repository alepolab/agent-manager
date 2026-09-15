import type { Plugin, PluginDetail, SkillFrontmatter } from '~/types'

export function usePlugins() {
  const plugins = useState<Plugin[]>('plugins', () => [])
  const loading = useState('pluginsLoading', () => false)
  const error = useState<string | null>('pluginsError', () => null)

  async function fetchAll({ silent = false } = {}) {
    if (!silent) {
      loading.value = true
      error.value = null
    }
    try {
      const next = await $fetch<Plugin[]>('/api/plugins')
      // An unchanged background refresh must not hand consumers new objects: /graph rebuilds its layout from them.
      if (silent && JSON.stringify(next) === JSON.stringify(plugins.value)) return
      plugins.value = next
    } catch (e: unknown) {
      if (silent) return
      const msg = e instanceof Error ? e.message : 'Failed to load plugins'
      error.value = msg
      console.error('[usePlugins] fetchAll:', msg)
    } finally {
      if (!silent) loading.value = false
    }
  }

  async function fetchOne(id: string) {
    return await $fetch<PluginDetail>(`/api/plugins/${encodeURIComponent(id)}`)
  }

  async function toggleEnabled(id: string, enabled: boolean) {
    const { save, settings } = useSettings()
    if (!settings.value) return

    const updated = {
      ...settings.value,
      enabledPlugins: {
        ...(settings.value.enabledPlugins as Record<string, boolean> | undefined),
        [id]: enabled,
      },
    }
    await save(updated)

    const idx = plugins.value.findIndex(p => p.id === id)
    if (idx >= 0) {
      plugins.value[idx] = Object.assign({}, plugins.value[idx], { enabled })
    }
  }

  async function uninstall(id: string) {
    await $fetch(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' })
    plugins.value = plugins.value.filter(p => p.id !== id)
  }

  async function updateSkill(pluginId: string, skill: string, frontmatter: SkillFrontmatter, body: string) {
    return await $fetch('/api/plugins/skills/update', {
      method: 'PUT',
      body: { pluginId, skill, frontmatter, body },
    })
  }

  return { plugins, loading, error, fetchAll, fetchOne, toggleEnabled, uninstall, updateSkill }
}
