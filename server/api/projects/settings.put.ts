import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolveHome } from '../../utils/path'
import { requireCapability } from '../../utils/session'

export default defineEventHandler(async (event) => {
  // `configure`: this route mutates the instance, and carried no authorisation check —
  // the auth middleware proves WHO the caller is, never WHAT they may do.
  await requireCapability(event, 'configure')
  const body = await readBody(event)
  const { path, settings } = body

  if (!path) {
    throw createError({ statusCode: 400, message: 'Path is required' })
  }

  const expandedPath = resolveHome(path)
  const settingsPath = join(expandedPath, '.claude', 'settings.local.json')
  const settingsDir = dirname(settingsPath)

  try {
    if (!existsSync(settingsDir)) {
      await mkdir(settingsDir, { recursive: true })
    }

    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    return { success: true }
  } catch (e: any) {
    console.error(`Failed to write settings for ${path}:`, e)
    throw createError({ statusCode: 500, message: `Failed to save settings: ${e.message}` })
  }
})
