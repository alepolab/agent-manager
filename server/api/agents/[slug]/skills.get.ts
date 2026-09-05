import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { resolveClaudePath } from '../../../utils/claudeDir'
import { parseFrontmatter } from '../../../utils/frontmatter'
import { resolvePluginInstallPath } from '../../../utils/marketplace'
import type { SkillFrontmatter, AgentFrontmatter } from '~/types'

interface InstalledEntry {
  installPath: string
  [key: string]: unknown
}

interface AgentSkill {
  slug: string
  frontmatter: SkillFrontmatter
  body: string
  filePath: string
  source: 'standalone' | 'plugin' | 'github'
  pluginId?: string
  pluginName?: string
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

async function findSkillPath(slug: string): Promise<{ filePath: string; source: 'standalone' | 'plugin' | 'github'; pluginId?: string; pluginName?: string } | null> {
  // 1. Check standalone skills
  const standaloneDir = resolveClaudePath('skills', slug)
  let standalonePath = join(standaloneDir, 'SKILL.md')
  if (!existsSync(standalonePath)) {
    standalonePath = join(standaloneDir, `${slug}.md`)
  }
  if (existsSync(standalonePath)) return { filePath: standalonePath, source: 'standalone' }

  // 2. Check GitHub-imported skills
  const githubDir = resolveClaudePath('github')
  if (existsSync(githubDir)) {
    const { readImportsRegistry } = await import('../../../utils/github')
    const registry = await readImportsRegistry('skills')

    for (const entry of registry.imports) {
      if (!existsSync(entry.localPath)) continue
      const scanRoot = entry.targetPath
        ? join(entry.localPath, entry.targetPath)
        : entry.localPath

      const findInDir = async (dir: string): Promise<string | null> => {
        if (!existsSync(dir)) return null
        const items = await readdir(dir, { withFileTypes: true })
        for (const item of items) {
          if (item.name.startsWith('.')) continue
          const fullPath = join(dir, item.name)

          if (item.isDirectory()) {
            const found = await findInDir(fullPath)
            if (found) return found
            continue
          }

          if (!item.isFile() || !item.name.toLowerCase().endsWith('.md')) continue

          const rel = relative(scanRoot, fullPath)
          const parts = rel.split(/[\\/]/).filter(Boolean)
          const fileName = parts.at(-1) || item.name
          const parentDir = parts.length >= 2 ? parts.at(-2) : undefined

          let currentSlug =
            fileName.toLowerCase() === 'skill.md' && parentDir
              ? parentDir
              : fileName.replace(/\.md$/i, '')

          if (currentSlug.toLowerCase() === 'skill' || !currentSlug) {
            try {
              const raw = await readFile(fullPath, 'utf-8')
              const { frontmatter } = parseFrontmatter<SkillFrontmatter>(raw)
              if (frontmatter.name) {
                currentSlug = frontmatter.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
              }
            } catch {
              // Ignore
            }
          }

          if (currentSlug === slug) return fullPath
        }
        return null
      }

      const skillPath = await findInDir(scanRoot)
      if (skillPath) return { filePath: skillPath, source: 'github' }
    }
  }

  // 3. Check plugin skills
  const installedPath = resolveClaudePath('plugins', 'installed_plugins.json')
  const installed = await readJson<{ plugins: Record<string, InstalledEntry[]> }>(installedPath)

  if (installed?.plugins) {
    for (const [pluginId, entries] of Object.entries(installed.plugins)) {
      const entry = entries[0]
      if (!entry) continue

      const installPath = resolvePluginInstallPath(pluginId, entry.installPath)
      const pluginSkillsDir = join(installPath, 'skills')
      if (!existsSync(pluginSkillsDir)) continue

      const skillPath = join(pluginSkillsDir, slug, 'SKILL.md')
      if (existsSync(skillPath)) {
        // Read plugin name
        const pluginJsonPath = join(installPath, '.claude-plugin', 'plugin.json')
        const pluginMeta = await readJson<{ name?: string }>(pluginJsonPath)
        const [fallbackName] = pluginId.split('@')

        return {
          filePath: skillPath,
          source: 'plugin',
          pluginId,
          pluginName: pluginMeta?.name ?? fallbackName,
        }
      }
    }
  }

  return null
}

export default defineEventHandler(async (event) => {
  const agentSlug = getRouterParam(event, 'slug')!
  const agentPath = resolveClaudePath('agents', `${agentSlug}.md`)

  if (!existsSync(agentPath)) {
    throw createError({ statusCode: 404, message: `Agent not found: ${agentSlug}` })
  }

  const rawAgent = await readFile(agentPath, 'utf-8')
  const { frontmatter: agentFM } = parseFrontmatter<AgentFrontmatter>(rawAgent)

  const skillSlugs = agentFM.skills || []
  const results: AgentSkill[] = []

  for (const slug of skillSlugs) {
    const found = await findSkillPath(slug)
    if (!found) continue

    try {
      const rawSkill = await readFile(found.filePath, 'utf-8')
      const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(rawSkill)
      results.push({
        slug,
        frontmatter: { ...frontmatter, name: frontmatter.name ?? slug },
        body,
        filePath: found.filePath,
        source: found.source as 'standalone' | 'plugin',
        pluginId: found.pluginId,
        pluginName: found.pluginName,
      })
    } catch {
      // Skip invalid skill files
    }
  }

  return results.sort((a, b) => a.slug.localeCompare(b.slug))
})
