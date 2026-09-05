import { invalidate } from '../../utils/memo'
import { unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveAgentFilePath } from '../../utils/agentUtils'

export default defineEventHandler(async (event) => {
  invalidate('agents'); invalidate('relationships')
  const slug = getRouterParam(event, 'slug')!
  const filePath = resolveAgentFilePath(slug)

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: `Agent not found: ${slug}` })
  }

  try {
    await unlink(filePath)
  } catch {
    throw createError({ statusCode: 500, message: `Failed to delete agent: ${slug}` })
  }

  return { deleted: true, slug }
})
