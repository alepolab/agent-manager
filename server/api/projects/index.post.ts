import { existsSync } from 'node:fs'
import { addManualProject } from '../../utils/claudeCodeHistory'
import { requireCapability } from '../../utils/session'

export default defineEventHandler(async (event) => {
  // `configure`: this route mutates the instance, and carried no authorisation check —
  // the auth middleware proves WHO the caller is, never WHAT they may do.
  await requireCapability(event, 'configure')
  const body = await readBody<{ path: string; displayName?: string }>(event)

  if (!body?.path?.trim()) {
    throw createError({ statusCode: 400, message: 'path is required' })
  }

  const path = body.path.trim()

  if (!existsSync(path)) {
    throw createError({ statusCode: 400, message: `Directory not found: ${path}` })
  }

  const project = await addManualProject(path, body.displayName?.trim() || undefined)
  return project
})
