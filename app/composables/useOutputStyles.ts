import type { OutputStyle, OutputStylePayload } from '~/types'

export function useOutputStyles() {
  const styles = useState<OutputStyle[]>('output-styles', () => [])
  const loading = ref(false)
  const error = ref<string | null>(null)
  
  const { workingDir } = useWorkingDir()
  const toast = useToast()

  async function fetchStyles() {
    loading.value = true
    error.value = null
    try {
      const data = await $fetch<OutputStyle[]>('/api/output-styles', {
        query: { workingDir: workingDir.value }
      })
      styles.value = data
    } catch (err: any) {
      error.value = err.message || 'Failed to fetch output styles'
      toast.add({ title: 'Failed to load output styles', description: error.value ?? undefined, color: 'error' })
    } finally {
      loading.value = false
    }
  }

  async function fetchStyle(id: string, scope: 'global' | 'project') {
    try {
      return await $fetch<OutputStyle>(`/api/output-styles/${encodeURIComponent(id)}`, {
        query: { scope, workingDir: workingDir.value }
      })
    } catch (err: any) {
      toast.add({ title: 'Failed to fetch output style', description: err.message, color: 'error' })
      throw err
    }
  }

  async function saveStyle(payload: Partial<OutputStyle> & { oldId?: string }) {
    try {
      const res = await $fetch('/api/output-styles', {
        method: 'POST',
        body: {
          ...payload,
          workingDir: workingDir.value
        }
      })
      const isUpdate = !!payload.oldId
      toast.add({ 
        title: `Output style ${payload.name} ${isUpdate ? 'updated' : 'added'} successfully`, 
        color: 'success' 
      })
      await fetchStyles()
      return res
    } catch (err: any) {
      const message = err.data?.message || err.message || 'Failed to save output style'
      toast.add({ title: 'Failed to save output style', description: message, color: 'error' })
      throw err
    }
  }

  async function removeStyle(id: string, scope: 'global' | 'project') {
    try {
      await $fetch(`/api/output-styles/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        query: { scope, workingDir: workingDir.value }
      })
      toast.add({ title: `Output style removed`, color: 'success' })
      await fetchStyles()
    } catch (err: any) {
      toast.add({ title: 'Failed to remove output style', description: err.message, color: 'error' })
      throw err
    }
  }

  return {
    styles,
    loading,
    error,
    fetchStyles,
    fetchStyle,
    saveStyle,
    removeStyle
  }
}
