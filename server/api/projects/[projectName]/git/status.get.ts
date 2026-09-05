import { validateGitRepository, getCurrentBranchName, spawnAsync } from '../../../../utils/gitUtils'

/**
 * One shape, always. This handler used to return either a success object or a
 * bare `{ error, projectPath }`, and the union was inferred rather than
 * declared - so every field the panel reads (`branch`, `staged`, `modified`,
 * `untracked`, `deleted`) existed on only one arm and on neither as far as the
 * client was concerned. That produced 20 of this project's typecheck errors
 * from a single endpoint, and left the component reading properties TypeScript
 * could not prove were there.
 *
 * Declaring the shape here rather than narrowing at 20 call sites also gives
 * the panel something sane to render on failure: empty lists, not undefined.
 */
export interface GitStatusResponse {
  branch: string
  modified: string[]
  added: string[]
  deleted: string[]
  untracked: string[]
  staged: string[]
  projectPath: string
  /** Present only when the status could not be read. The lists are empty in
   *  that case, never absent, so a consumer can render without narrowing. */
  error?: string
}

const emptyStatus = (projectPath: string, error?: string): GitStatusResponse => ({
  branch: '', modified: [], added: [], deleted: [], untracked: [], staged: [], projectPath,
  ...(error ? { error } : {}),
})

export default defineEventHandler(async (event): Promise<GitStatusResponse> => {
  const projectName = getRouterParam(event, 'projectName')
  if (!projectName) {
    throw createError({ statusCode: 400, message: 'Project name is required' })
  }

  let projectPath: string
  try {
    const res = await $fetch<{ projectName: string | null }>(`/api/projects/resolve?name=${encodeURIComponent(projectName)}`)
    if (!res.projectName) {
      projectPath = projectName.replace(/-/g, '/')
    } else {
      const projects = await $fetch<any[]>('/api/projects')
      const project = projects.find(p => p.name === res.projectName)
      if (!project) throw new Error('Project not found')
      projectPath = project.path
    }
  } catch (e) {
    projectPath = projectName.replace(/-/g, '/')
  }

  try {
    await validateGitRepository(projectPath)
    const branch = await getCurrentBranchName(projectPath)
    
    const { stdout: statusOutput } = await spawnAsync('git', ['status', '--porcelain'], { cwd: projectPath })
    
    const modified: string[] = []
    const added: string[] = []
    const deleted: string[] = []
    const untracked: string[] = []
    const staged: string[] = []

    const lines = statusOutput.split('\n').filter(Boolean)
    for (const line of lines) {
      const status = line.slice(0, 2)
      const file = line.slice(3).replace(/^"|"$/g, '')

      if (status[0] !== ' ' && status[0] !== '?') {
        staged.push(file)
      }

      if (status === '??') untracked.push(file)
      else if (status[1] === 'M') modified.push(file)
      else if (status[1] === 'A') added.push(file)
      else if (status[1] === 'D') deleted.push(file)
    }

    return {
      branch,
      modified,
      added,
      deleted,
      untracked,
      staged,
      projectPath
    }
  } catch (error: unknown) {
    return emptyStatus(projectPath, error instanceof Error ? error.message : String(error))
  }
})
