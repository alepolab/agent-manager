import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHome } from '../../utils/path'
import { requireCapability } from '../../utils/session'

export default defineEventHandler(async (event) => {
  // `configure`, matching settings.put.ts beside it — and this one returns the
  // contents of a project's `.claude/settings.local.json`, which is where local
  // overrides and anything a developer pasted into them live.
  await requireCapability(event, 'configure')
  const query = getQuery(event)
  const path = query.path as string

  if (!path) {
    throw createError({ statusCode: 400, message: 'Path is required' })
  }

  const expandedPath = resolveHome(path)
  const settingsPath = join(expandedPath, '.claude', 'settings.local.json')

  if (!existsSync(settingsPath)) {
    return {}
  }

  try {
    const raw = await readFile(settingsPath, 'utf-8')
    return JSON.parse(raw)
  } catch (e) {
    console.error(`Failed to read settings for ${path}:`, e)
    return {}
  }
})
