import { requireCapability } from '../../utils/session'
import { readImportsRegistry, writeImportsRegistry, findImport } from '../../utils/github'
import { removeClone } from '../../utils/gitOps'
import { syncGithubImportSymlinks } from '../../utils/githubSkillSymlinks'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const { owner, repo, type } = await readBody<{ owner: string; repo: string; type: 'skills' | 'agents' }>(event)

  if (!type) throw createError({ statusCode: 400, message: 'type is required' })

  const registry = await readImportsRegistry(type)
  const entry = findImport(registry, owner, repo)

  if (!entry) {
    throw createError({ statusCode: 404, message: 'Import not found' })
  }

  try {
    await syncGithubImportSymlinks(entry, [...entry.selectedItems], [], type)
  } catch {
    // Best-effort: remove skill symlinks pointing at this clone before deleting it.
  }

  await removeClone(entry.localPath)
  registry.imports = registry.imports.filter(i => !(i.owner === owner && i.repo === repo))
  await writeImportsRegistry(type, registry)

  return { success: true }
})
