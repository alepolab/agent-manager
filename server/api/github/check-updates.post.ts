import { requireCapability } from '../../utils/session'
import { readImportsRegistry, writeImportsRegistry } from '../../utils/github'
import { gitLsRemote } from '../../utils/gitOps'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const { type } = await readBody<{ type: 'skills' | 'agents' }>(event)
  if (!type) throw createError({ statusCode: 400, message: 'type is required' })

  const registry = await readImportsRegistry(type)
  const now = new Date().toISOString()

  await Promise.allSettled(
    registry.imports.map(async (entry) => {
      const remoteSha = await gitLsRemote(`https://github.com/${entry.owner}/${entry.repo}.git`)
      entry.lastChecked = now
      if (remoteSha) entry.remoteSha = remoteSha
    })
  )

  await writeImportsRegistry(type, registry)

  return {
    imports: registry.imports,
    updatesAvailable: registry.imports.filter(i => i.currentSha !== i.remoteSha).length,
  }
})
