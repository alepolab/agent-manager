import { requireCapability } from '../../utils/session'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getClaudeDir } from '../../utils/claudeDir'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const id = getRouterParam(event, 'id')
  const query = getQuery(event)
  const scope = query.scope as string
  const workingDir = query.workingDir as string

  const globalDir = join(getClaudeDir(), 'output-styles')
  const projectDir = workingDir ? join(workingDir, '.claude', 'output-styles') : null
  
  const targetDir = scope === 'global' ? globalDir : projectDir
  if (!targetDir || !id) {
    throw createError({ statusCode: 400, message: 'Invalid request' })
  }

  const filePath = join(targetDir, `${id}.md`)
  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: 'Output style not found' })
  }

  unlinkSync(filePath)
  return { success: true }
})
