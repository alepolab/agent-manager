import { requireCapability } from '../../utils/session'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseFrontmatter } from '../../utils/frontmatter'
import { syncGithubImportSymlinks } from '../../utils/githubSkillSymlinks'
import type { SkillFrontmatter } from '~/types'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const { owner, repo, selectedItems, type } = await readBody<{
    owner: string
    repo: string
    selectedItems?: string[]
    type: 'skills' | 'agents'
  }>(event)

  if (!type) throw createError({ statusCode: 400, message: 'type is required' })

  const registry = await readImportsRegistry(type)
  const entry = findImport(registry, owner, repo)

  if (!entry) {
    throw createError({ statusCode: 404, message: 'Import not found' })
  }

  // If selectedItems provided, update them
  if (selectedItems !== undefined) {
    const previousItems = [...entry.selectedItems]
    entry.selectedItems = selectedItems
    await writeImportsRegistry(type, registry)
    const symlinkSync = await syncGithubImportSymlinks(entry, previousItems, entry.selectedItems, type)
    return { entry, symlinkSync }
  }

  // Otherwise, scan local clone for all available skills and agents and return them
  const scanRoot = entry.targetPath
    ? join(entry.localPath, entry.targetPath)
    : entry.localPath

  if (!existsSync(scanRoot)) {
    throw createError({ statusCode: 404, message: 'Import directory not found on disk' })
  }

  const availableSkills: { slug: string; name: string; description: string; category: string | null; selected: boolean }[] = []
  const availableAgents: { slug: string; name: string; description: string; category: string | null; selected: boolean }[] = []

  // Prefer skills-index.json when present so slug/metadata matches the import workflow.
  // (This also avoids a potentially expensive full markdown scan.)
  const indexPathCandidates = [
    join(entry.localPath, 'skills-index.json'),
    join(scanRoot, 'skills-index.json'),
  ]
  const indexPath = indexPathCandidates.find(p => existsSync(p))

  if (indexPath) {
    try {
      const raw = await readFile(indexPath, 'utf-8')
      const index = JSON.parse(raw) as {
        skills: Array<{
          slug: string
          name?: string
          description?: unknown
          category?: string | null
          tags?: string | string[]
          files?: string[]
          path?: string
        }>
      }

      const targetPrefix = entry.targetPath || ''

      const skills = index.skills.map(s => {
        const filePath = s.files?.[0] || s.path || ''
        return {
          slug: s.slug,
          name: s.name || s.slug,
          description: typeof s.description === 'string' ? s.description.replace(/^>\s*/, '') : '',
          filePath,
        }
      })

      const filtered = targetPrefix ? skills.filter(s => s.filePath.startsWith(targetPrefix)) : skills

      for (const s of filtered) {
        if (!s.slug) continue
        availableSkills.push({
          slug: s.slug,
          name: s.name,
          description: s.description,
          category: null,
          selected: entry.selectedItems?.includes(s.slug) || false,
        })
      }

      // If we found skills via index, we still return them, but we might also want to scan for agents
      // as skills-index.json usually only contains skills.
    } catch {
      // Fall through to filesystem scan.
    }
  }

  // Fallback: scan for markdown skill/agent files on disk and use frontmatter.name/description.
  const SKIP_FILENAMES = new Set<string>([
    'README.md', 'readme.md',
    'CHANGELOG.md', 'changelog.md',
    'CONTRIBUTING.md', 'contributing.md',
    'LICENSE.md', 'license.md',
    'CODE_OF_CONDUCT.md',
  ])

  const skipLower = new Set([...SKIP_FILENAMES].map(s => s.toLowerCase()))
  const skillDedup = new Map<string, { slug: string; name: string; description: string; category: string | null; selected: boolean }>()
  const agentDedup = new Map<string, { slug: string; name: string; description: string; category: string | null; selected: boolean }>()

  const walk = async (dir: string) => {
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.')) continue

      const fullPath = join(dir, item.name)
      if (item.isDirectory()) {
        await walk(fullPath)
        continue
      }

      if (!item.isFile()) continue
      if (!item.name.toLowerCase().endsWith('.md')) continue
      if (skipLower.has(item.name.toLowerCase())) continue

      const raw = await readFile(fullPath, 'utf-8')
      const { frontmatter } = parseFrontmatter<any>(raw)
      if (!frontmatter.name || !frontmatter.description) continue

      const rel = relative(scanRoot, fullPath)
      const parts = rel.split(/[\\/]/).filter(Boolean)
      const fileName = parts.at(-1) || item.name
      const isSkillFile = fileName.toLowerCase() === 'skill.md'
      
      // Detect Agent
      // Any .md file with name and description is a valid agent, UNLESS it's a SKILL.md
      if (!isSkillFile) {
        let slug = fileName.replace(/\.md$/i, '')
        if (slug.toLowerCase() === 'agent' && parts.length >= 2) {
          slug = parts[parts.length - 2]!
        }
        if (!slug) continue

        // Extract category
        const categoryParts = parts.slice(0, -1)
        if (fileName.toLowerCase() === 'agent.md' && categoryParts.length > 0) {
          categoryParts.pop()
        }
        const category = categoryParts.length > 0 ? categoryParts.join('/') : null

        if (!agentDedup.has(slug)) {
          agentDedup.set(slug, {
            slug,
            name: frontmatter.name,
            description: frontmatter.description,
            category,
            selected: entry.selectedItems?.includes(slug) || false,
          })
        }
      }

      // Detect Skill (only if not already found in index)
      const skillSlug = (isSkillFile && parts.length >= 2)
        ? parts.at(-2)!
        : fileName.replace(/\.md$/i, '')

      if (isSkillFile || !availableSkills.find(s => s.slug === skillSlug)) {
        let slug = skillSlug

        if ((slug.toLowerCase() === 'skill' || !slug) && frontmatter.name) {
          slug = frontmatter.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        }

        if (slug && !skillDedup.has(slug)) {
          // Extract category for skills
          const categoryParts = parts.slice(0, -1)
          if (isSkillFile && categoryParts.length > 0) {
            categoryParts.pop()
          }
          const category = categoryParts.length > 0 ? categoryParts.join('/') : null

          skillDedup.set(slug, {
            slug,
            name: frontmatter.name,
            description: frontmatter.description,
            category,
            selected: entry.selectedItems?.includes(slug) || false,
          })
        }
      }
    }
  }

  await walk(scanRoot)

  // Only add if not already present (from index)
  for (const v of skillDedup.values()) {
    if (!availableSkills.find(s => s.slug === v.slug)) {
      availableSkills.push(v)
    }
  }
  for (const v of agentDedup.values()) availableAgents.push(v)

  availableSkills.sort((a, b) => a.name.localeCompare(b.name))
  availableAgents.sort((a, b) => a.name.localeCompare(b.name))
  
  // Update totals in registry if they changed
  let changed = false
  const currentTotal = type === 'skills' ? availableSkills.length : availableAgents.length
  if (entry.totalItems !== currentTotal) {
    entry.totalItems = currentTotal
    changed = true
  }
  if (changed) {
    await writeImportsRegistry(type, registry)
  }
  
  return { 
    entry, 
    availableSkills,
    availableAgents
  }
})
