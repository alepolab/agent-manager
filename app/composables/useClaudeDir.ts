export function useClaudeDir() {
  const claudeDir = useState<string | null>('claudeDir', () => null)
  const exists = useState<boolean>('claudeDirExists', () => true)
  const loading = useState('claudeDirLoading', () => false)
  const error = useState<string | null>('claudeDirError', () => null)
  const localDesktop = useState<boolean>('localDesktop', () => false)

  async function load() {
    loading.value = true
    error.value = null
    try {
      const data = await $fetch<{ claudeDir: string; exists: boolean; localDesktop?: boolean }>('/api/config')
      claudeDir.value = data.claudeDir || null
      exists.value = data.exists
      localDesktop.value = data.localDesktop === true
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load config'
      error.value = msg
      console.error('[useClaudeDir] load:', msg)
    } finally {
      loading.value = false
    }
  }

  // The config directory is fixed at boot (CLAUDE_DIR); a shared server must
  // never let one request repoint it for everyone.
  return { claudeDir, exists, loading, error, load, localDesktop }
}
