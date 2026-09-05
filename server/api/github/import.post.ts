import { invalidate } from '../../utils/memo'
import { resolveClaudePath } from '../../utils/claudeDir'
import { 
  readImportsRegistry, 
  findImport, 
  writeImportsRegistry 
} from '../../utils/github'
import { 
  gitClone, 
  gitGetHead, 
  removeClone 
} from '../../utils/gitOps'
import { syncGithubImportSymlinks } from '../../utils/githubSkillSymlinks'

export default defineEventHandler(async (event) => {
  invalidate('skills'); invalidate('relationships')
  const { owner, repo, url, targetPath, selectedItems, totalItems, type } = await readBody<{
    owner: string
    repo: string
    url: string
    targetPath: string
    selectedItems: string[]
    totalItems: number
    type: 'skills' | 'agents'
  }>(event)

  if (!owner || !repo || !url || !type) {
    const missing = []
    if (!owner) missing.push('owner')
    if (!repo) missing.push('repo')
    if (!url) missing.push('url')
    if (!type) missing.push('type')
    throw createError({ 
      statusCode: 400, 
      message: `Missing required fields: ${missing.join(', ')}` 
    })
  }

  const registry = await readImportsRegistry(type)

  if (findImport(registry, owner, repo)) {
    throw createError({
      statusCode: 409,
      data: { error: 'already_exists', message: `This repository is already imported as ${type}` },
    })
  }

  // Use type-specific local path to allow same repo to be imported for both types without conflict
  const localPath = resolveClaudePath('github', type, owner, repo)
  const repoUrl = `https://github.com/${owner}/${repo}.git`

  await gitClone(repoUrl, localPath)

  let sha: string
  try {
    sha = await gitGetHead(localPath)
  } catch {
    sha = ''
  }

  const now = new Date().toISOString()
  
  const entry = {
    owner,
    repo,
    url,
    targetPath: targetPath || '',
    localPath,
    importedAt: now,
    lastChecked: now,
    currentSha: sha,
    remoteSha: sha,
    selectedItems: selectedItems || [],
    totalItems: totalItems || 0,
  }

  registry.imports.push(entry)

  try {
    await writeImportsRegistry(type, registry)
  } catch {
    await removeClone(localPath)
    throw createError({ statusCode: 500, message: 'Failed to save import registry' })
  }

  try {
    await syncGithubImportSymlinks(entry, [], entry.selectedItems, type)
  } catch {
    // Registry import succeeded; symlinks are best-effort (permissions, layout).
  }

  return entry
})
