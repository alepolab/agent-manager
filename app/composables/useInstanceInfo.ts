/**
 * What this instance is actually running, read-only.
 *
 * Lifted out of the old settings page so the pipeline route and the instance
 * route share one fetch: `pinned` decides how half the pipeline form behaves,
 * and someone who deep-links straight to /settings/pipeline must not depend on
 * /settings/instance having been opened first.
 */
export interface InstanceInfo {
  pinned: Record<string, string>
  automations: { name: string, envVar: string, enabled: boolean, detail?: string }[]
  paths: { claudeDir: string, agentRunsDir: string, workspaceRoot: string, usersDir: string }
  secrets: { name: string, set: boolean }[]
  identity: { authDisabled: boolean, githubOrg: string | null, managerUrl: string | null, clientIdSet: boolean }
}

export function useInstanceInfo() {
  const instance = useState<InstanceInfo | null>('instanceInfo', () => null)

  async function load() {
    try { instance.value = await $fetch<InstanceInfo>('/api/instance') }
    catch { instance.value = null }
  }

  /** The value an env var is forcing on this field, or undefined when the saved setting wins. */
  const pinnedBy = (envVar: string) => instance.value?.pinned?.[envVar]
  const pinnedNote = (envVar: string) => {
    const value = pinnedBy(envVar)
    return value ? `Pinned by ${envVar}=${value} on this instance; the value here is ignored until that is unset.` : ''
  }

  return { instance, load, pinnedBy, pinnedNote }
}
