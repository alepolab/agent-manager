import { requireCapability } from '../../utils/session'
import { readImportsRegistry, writeImportsRegistry, findImport } from '../../utils/github'
import { gitPull, gitGetHead, gitDiffFiles } from '../../utils/gitOps'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const { owner, repo, type } = await readBody<{ owner: string; repo: string; type: 'skills' | 'agents' }>(event)

  if (!type) throw createError({ statusCode: 400, message: 'type is required' })

  const registry = await readImportsRegistry(type)
  const entry = findImport(registry, owner, repo)

  if (!entry) {
    throw createError({ statusCode: 404, message: 'Import not found' })
  }

  const oldSha = entry.currentSha
  await gitPull(entry.localPath)
  const newSha = await gitGetHead(entry.localPath)
  const changedFiles = oldSha ? await gitDiffFiles(entry.localPath, oldSha) : []

  entry.currentSha = newSha
  entry.remoteSha = newSha
  entry.lastChecked = new Date().toISOString()

  await writeImportsRegistry(type, registry)

  return { entry, changedFiles }
})
