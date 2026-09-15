import { requireCapability } from '../../../utils/session'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveClaudePath } from '../../../utils/claudeDir'
import { serializeFrontmatter } from '../../../utils/frontmatter'
import type { SkillFrontmatter } from '~/types'

interface InstalledEntry {
  installPath: string
  [key: string]: unknown
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    if (!existsSync(path)) return null
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const { pluginId, skill, frontmatter, body } = await readBody<{
    pluginId: string
    skill: string
    frontmatter: SkillFrontmatter
    body: string
  }>(event)

  if (!pluginId || !skill) {
    throw createError({ statusCode: 400, message: 'pluginId and skill are required' })
  }

  const installedPath = resolveClaudePath('plugins', 'installed_plugins.json')
  const installed = await readJson<{ plugins: Record<string, InstalledEntry[]> }>(installedPath)
  const entries = installed?.plugins?.[pluginId]
  if (!entries?.length) {
    throw createError({ statusCode: 404, message: `Plugin not found: ${pluginId}` })
  }

  const entry = entries[0]!
  const skillPath = join(entry.installPath, 'skills', skill, 'SKILL.md')
  if (!existsSync(skillPath)) {
    throw createError({ statusCode: 404, message: `Skill not found: ${skill}` })
  }

  const content = serializeFrontmatter(frontmatter, body)
  await writeFile(skillPath, content, 'utf-8')

  return { ok: true }
})
