import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveClaudePath } from '../../utils/claudeDir'
import { parseFrontmatter } from '../../utils/frontmatter'
import { resolvePluginInstallPath } from '../../utils/marketplace'
import type { PluginDetail, SkillFrontmatter } from '~/types'

interface InstalledEntry {
  scope: string
  installPath: string
  version: string
  installedAt: string
  lastUpdated: string
}

interface PluginJson {
  name: string
  description?: string
  version?: string
  author?: { name: string; email?: string }
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
  const id = decodeURIComponent(getRouterParam(event, 'id')!)
  const installedPath = resolveClaudePath('plugins', 'installed_plugins.json')
  const settingsPath = resolveClaudePath('settings.json')

  const installed = await readJson<{ plugins: Record<string, InstalledEntry[]> }>(installedPath)
  const entries = installed?.plugins?.[id]
  if (!entries?.length) {
    throw createError({ statusCode: 404, message: `Plugin not found: ${id}` })
  }

  const entry = entries[0]
  if (!entry) throw createError({ statusCode: 404, message: `Plugin not found: ${id}` })
  const [name, marketplace] = id.split('@')
  const installPath = resolvePluginInstallPath(id, entry.installPath)
  const pluginJsonPath = join(installPath, '.claude-plugin', 'plugin.json')
  const meta = await readJson<PluginJson>(pluginJsonPath)

  const settings = await readJson<{ enabledPlugins?: Record<string, boolean> }>(settingsPath)

  // Load skills
  const skillDetails = []
  const skillsDir = join(installPath, 'skills')
  if (existsSync(skillsDir)) {
    const skillDirs = await readdir(skillsDir, { withFileTypes: true })
    for (const dir of skillDirs) {
      if (!dir.isDirectory()) continue
      const skillPath = join(skillsDir, dir.name, 'SKILL.md')
      if (!existsSync(skillPath)) continue
      const raw = await readFile(skillPath, 'utf-8')
      const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw)
      skillDetails.push({
        slug: dir.name,
        // Spread FIRST, then pin `name`: written the other way round a
        // frontmatter carrying its own `name` overwrote the directory name
        // (TS2783), and the directory is the skill's identity - the same rule
        // that governs command filenames.
        frontmatter: { ...frontmatter, name: frontmatter.name ?? dir.name },
        body,
        filePath: skillPath,
      })
    }
  }

  return {
    id,
    // `id.split('@')[0]` is `string | undefined` under noUncheckedIndexedAccess
    // even though a non-empty split always yields a first element; fall back to
    // the id rather than assert, so a malformed id degrades to something
    // readable instead of "undefined".
    name: meta?.name ?? name ?? id,
    marketplace: marketplace ?? 'unknown',
    description: meta?.description ?? '',
    version: entry.version,
    enabled: settings?.enabledPlugins?.[id] ?? false,
    installedAt: entry.installedAt,
    lastUpdated: entry.lastUpdated,
    installPath: entry.installPath,
    skills: skillDetails.map(s => s.slug),
    author: meta?.author,
    skillDetails: skillDetails.sort((a, b) => a.slug.localeCompare(b.slug)),
  } satisfies PluginDetail
})
