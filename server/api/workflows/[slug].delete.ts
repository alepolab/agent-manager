import { unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudeFile } from '../../utils/claudeDir'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  const filePath = resolveClaudeFile('workflows', slug)

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: 'Workflow not found' })
  }

  await unlink(filePath)
  return { deleted: true }
})
