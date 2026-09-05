import type { GithubImport, GithubImportsRegistry, SkillScanResult, AgentScanResult } from '~/types'

export interface GithubSymlinkSync {
  linked: string[]
  removed: string[]
  skippedConflicts: string[]
  missingInClone: string[]
}

export function useGithubImports() {
  const skillImports = useState<GithubImport[]>('githubSkillImports', () => [])
  const agentImports = useState<GithubImport[]>('githubAgentImports', () => [])
  const loading = useState('githubImportsLoading', () => false)
  const scanning = useState('githubImportsScanning', () => false)
  const skillUpdatesAvailable = useState('githubSkillImportsUpdates', () => 0)
  const agentUpdatesAvailable = useState('githubAgentImportsUpdates', () => 0)

  async function fetchImports(type: 'skills' | 'agents') {
    loading.value = true
    try {
      const data = await $fetch<GithubImportsRegistry>(`/api/github/imports?type=${type}`)
      if (type === 'skills') skillImports.value = data.imports
      else agentImports.value = data.imports
    } catch (e) {
      console.error(`Failed to fetch ${type} imports:`, e)
    } finally {
      loading.value = false
    }
  }

  async function scanSkills(url: string): Promise<SkillScanResult> {
    scanning.value = true
    try {
      return await $fetch<SkillScanResult>('/api/github/scan-skills', {
        method: 'POST',
        body: { url },
      })
    } finally {
      scanning.value = false
    }
  }

  async function scanAgents(url: string): Promise<AgentScanResult> {
    scanning.value = true
    try {
      return await $fetch<AgentScanResult>('/api/github/scan-agents', {
        method: 'POST',
        body: { url },
      })
    } finally {
      scanning.value = false
    }
  }

  async function importRepo(params: {
    owner: string
    repo: string
    url: string
    targetPath: string
    selectedItems: string[]
    totalItems: number
    type: 'skills' | 'agents'
  }): Promise<GithubImport> {
    const entry = await $fetch<GithubImport>('/api/github/import', {
      method: 'POST',
      body: params,
    })
    if (params.type === 'skills') skillImports.value.push(entry)
    else agentImports.value.push(entry)
    return entry
  }

  async function checkUpdates(type: 'skills' | 'agents') {
    try {
      const data = await $fetch<{ imports: GithubImport[]; updatesAvailable: number }>(
        '/api/github/check-updates',
        { method: 'POST', body: { type } },
      )
      if (type === 'skills') {
        skillImports.value = data.imports
        skillUpdatesAvailable.value = data.updatesAvailable
      } else {
        agentImports.value = data.imports
        agentUpdatesAvailable.value = data.updatesAvailable
      }
    } catch {
      // Silently fail — cached state is fine
    }
  }

  async function updateImport(owner: string, repo: string, type: 'skills' | 'agents'): Promise<{ changedFiles: string[] }> {
    const data = await $fetch<{ entry: GithubImport; changedFiles: string[] }>(
      '/api/github/update',
      { method: 'POST', body: { owner, repo, type } },
    )
    const list = type === 'skills' ? skillImports : agentImports
    const idx = list.value.findIndex(i => i.owner === owner && i.repo === repo)
    if (idx !== -1) list.value[idx] = data.entry
    
    if (type === 'skills') {
      skillUpdatesAvailable.value = skillImports.value.filter(i => i.currentSha !== i.remoteSha).length
    } else {
      agentUpdatesAvailable.value = agentImports.value.filter(i => i.currentSha !== i.remoteSha).length
    }
    
    return { changedFiles: data.changedFiles }
  }

  async function getAvailableItems(owner: string, repo: string, type: 'skills' | 'agents') {
    const data = await $fetch<{
      entry: GithubImport
      // `category` is optional on the wire (older imports predate it) but the
      // consumer groups by it, so it belongs in the declared shape rather than
      // being cast in at the call site.
      availableSkills: { slug: string; name: string; description: string; selected: boolean; category?: string | null }[]
      availableAgents?: { slug: string; name: string; description: string; selected: boolean; category?: string | null }[]
    }>('/api/github/edit-selection', {
      method: 'POST',
      body: { owner, repo, type },
    })
    return { skills: data.availableSkills, agents: data.availableAgents || [] }
  }

  async function updateSelectedItems(owner: string, repo: string, type: 'skills' | 'agents', selectedItems: string[]) {
    const data = await $fetch<{ entry: GithubImport; symlinkSync: any }>(
      '/api/github/edit-selection',
      {
        method: 'POST',
        body: { owner, repo, type, selectedItems },
      },
    )
    const list = type === 'skills' ? skillImports : agentImports
    const idx = list.value.findIndex(i => i.owner === owner && i.repo === repo)
    if (idx !== -1) list.value[idx] = data.entry
    return { entry: data.entry, symlinkSync: data.symlinkSync }
  }

  async function removeImport(owner: string, repo: string, type: 'skills' | 'agents') {
    await $fetch('/api/github/remove', {
      method: 'POST',
      body: { owner, repo, type },
    })
    if (type === 'skills') {
      skillImports.value = skillImports.value.filter(i => !(i.owner === owner && i.repo === repo))
      skillUpdatesAvailable.value = skillImports.value.filter(i => i.currentSha !== i.remoteSha).length
    } else {
      agentImports.value = agentImports.value.filter(i => !(i.owner === owner && i.repo === repo))
      agentUpdatesAvailable.value = agentImports.value.filter(i => i.currentSha !== i.remoteSha).length
    }
  }

  return {
    skillImports,
    agentImports,
    loading,
    scanning,
    skillUpdatesAvailable,
    agentUpdatesAvailable,
    fetchImports,
    scanSkills,
    scanAgents,
    importRepo,
    checkUpdates,
    updateImport,
    removeImport,
    getAvailableItems,
    updateSelectedItems,
  }
}
