import { invalidate } from '../../utils/memo'
import { writeFile, mkdir, rename, readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { resolveClaudePath } from '../../utils/claudeDir'
import { serializeFrontmatter } from '../../utils/frontmatter'
import { resolvePluginInstallPath } from '../../utils/marketplace'
import type { SkillPayload, SkillFrontmatter } from '~/types'

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

async function findSkillPath(slug: string): Promise<string | null> {
  // 1. Check standalone skills
  const standaloneDir = resolveClaudePath('skills', slug)
  const standaloneSkillMd = join(standaloneDir, 'SKILL.md')
  if (existsSync(standaloneSkillMd)) return standaloneSkillMd
  const standaloneSlugMd = join(standaloneDir, `${slug}.md`)
  if (existsSync(standaloneSlugMd)) return standaloneSlugMd

  // 2. Check GitHub-imported skills
  const githubDir = resolveClaudePath('github')
  if (existsSync(githubDir)) {
    const { readImportsRegistry } = await import('../../utils/github')
    const registry = await readImportsRegistry('skills')

    for (const entry of registry.imports) {
      if (!existsSync(entry.localPath)) continue
      const scanRoot = entry.targetPath
        ? join(entry.localPath, entry.targetPath)
        : entry.localPath

      const findSkill = async (dir: string): Promise<string | null> => {
        if (!existsSync(dir)) return null
        const items = await readdir(dir, { withFileTypes: true })
        for (const item of items) {
          if (item.name.startsWith('.')) continue
          const fullPath = join(dir, item.name)

          if (item.isDirectory()) {
            const found = await findSkill(fullPath)
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
              const { parseFrontmatter } = await import('../../utils/frontmatter')
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

      const skillPath = await findSkill(scanRoot)
      if (skillPath) return skillPath
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
      const skillPath = join(installPath, 'skills', slug, 'SKILL.md')
      if (existsSync(skillPath)) return skillPath
    }
  }

  return null
}

export default defineEventHandler(async (event) => {
  invalidate('skills'); invalidate('relationships')
  const slug = getRouterParam(event, 'slug')!
  const skillPath = await findSkillPath(slug)

  if (!skillPath) {
    throw createError({ statusCode: 404, message: `Skill not found: ${slug}` })
  }

  const payload = await readBody<SkillPayload & { lastModified?: number }>(event)
  const content = serializeFrontmatter(payload.frontmatter, payload.body)

  // For standalone skills, support rename
  const isStandalone = skillPath.startsWith(resolveClaudePath('skills'))
  const newSlug = payload.frontmatter.name

  if (isStandalone && slug !== newSlug) {
    const skillDir = join(skillPath, '..')
    const newSkillDir = resolveClaudePath('skills', newSlug)
    if (existsSync(newSkillDir)) {
      throw createError({ statusCode: 409, message: `Skill already exists: ${newSlug}` })
    }
    await rename(skillDir, newSkillDir)
    const newSkillPath = join(newSkillDir, 'SKILL.md')
    if (typeof payload.lastModified === 'number' && existsSync(skillPath)) {
      const current = (await stat(skillPath)).mtimeMs
      if (Math.abs(current - payload.lastModified) > 1000) {
        throw createError({ statusCode: 409, message: 'This skill changed on disk since you opened it. Reload to see the latest version.', data: { lastModified: current } })
      }
    }
    await writeFile(newSkillPath, content, 'utf-8')
    return { slug: newSlug, frontmatter: payload.frontmatter, body: payload.body, filePath: newSkillPath }
  }

  // Write in-place (GitHub skills, plugin skills, or no rename)
  await writeFile(skillPath, content, 'utf-8')
  return { slug, frontmatter: payload.frontmatter, body: payload.body, filePath: skillPath }
})
