import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { parseFrontmatter } from '../../utils/frontmatter'
import { resolvePluginInstallPath } from '../../utils/marketplace'
import { getPreloadingAgents, getMcpServerForSkill } from '../../utils/skillRelationships'
import type { Skill, SkillFrontmatter } from '~/types'

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
  const { workingDir } = getQuery(event) as { workingDir?: string }
  const skills: Skill[] = []

  // Load all agents to find preloading associations
  const agentsDir = resolveClaudePath('agents')
  const agentPreloads = new Map<string, { name: string; slug: string }[]>() // skillSlug -> {name, slug}[]

  if (existsSync(agentsDir)) {
    const agentFiles = await readdir(agentsDir)
    for (const file of agentFiles) {
      if (!file.endsWith('.md')) continue
      try {
        const agentSlug = file.replace(/\.md$/, '')
        const raw = await readFile(join(agentsDir, file), 'utf-8')
        const { frontmatter } = parseFrontmatter<{ name: string; skills?: string[] }>(raw)
        const agentName = frontmatter.name || agentSlug
        const preloadedSkills = frontmatter.skills || []

        for (const skillSlug of preloadedSkills) {
          if (!agentPreloads.has(skillSlug)) agentPreloads.set(skillSlug, [])
          agentPreloads.get(skillSlug)!.push({ name: agentName, slug: agentSlug })
        }
      } catch {
        // Skip invalid agent files
      }
    }
  }

  // Helper to attach agents and MCP server to a skill
  const attachMetadata = async (skill: Skill) => {
    skill.agents = agentPreloads.get(skill.slug) || []
    skill.mcpServer = await getMcpServerForSkill(skill.slug, skill.frontmatter, skill.body, workingDir)
  }

  // 1. Standalone skills from ~/.claude/skills/
  const skillsDir = resolveClaudePath('skills')
  if (existsSync(skillsDir)) {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    for (const dir of entries) {
      if (!dir.isDirectory()) continue
      const skillPath = join(skillsDir, dir.name, 'SKILL.md')
      if (!existsSync(skillPath)) continue

      const raw = await readFile(skillPath, 'utf-8')
      const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw)

      let slug = dir.name
      // If directory is literally 'SKILL' or empty, use frontmatter name as fallback
      if ((slug.toLowerCase() === 'skill' || !slug) && frontmatter.name) {
        slug = frontmatter.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      }

      const skill: Skill = {
        slug,
        frontmatter: { ...frontmatter, name: frontmatter.name ?? slug },
        body,
        filePath: skillPath,
        source: 'local',
      }
      await attachMetadata(skill)
      skills.push(skill)
    }
  }

  // 2. Plugin skills from installed plugins
  const installedPath = resolveClaudePath('plugins', 'installed_plugins.json')
  const installed = await readJson<{ plugins: Record<string, InstalledEntry[]> }>(installedPath)

  if (installed?.plugins) {
    for (const [pluginId, entries] of Object.entries(installed.plugins)) {
      const entry = entries[0]
      if (!entry) continue

      const installPath = resolvePluginInstallPath(pluginId, entry.installPath)
      const pluginSkillsDir = join(installPath, 'skills')
      const [pluginName] = pluginId.split('@')

      if (!existsSync(pluginSkillsDir)) continue

      const skillDirs = await readdir(pluginSkillsDir, { withFileTypes: true })
      for (const dir of skillDirs) {
        if (!dir.isDirectory()) continue
        const skillPath = join(pluginSkillsDir, dir.name, 'SKILL.md')
        if (!existsSync(skillPath)) continue

        const raw = await readFile(skillPath, 'utf-8')
        const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw)

        let slug = dir.name
        if ((slug.toLowerCase() === 'skill' || !slug) && frontmatter.name) {
          slug = frontmatter.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        }

        const skill: Skill = {
          slug,
          frontmatter: {
            ...frontmatter,
            name: frontmatter.name ?? slug,
          },
          body,
          filePath: skillPath,
          source: 'plugin',
          pluginName,
        }
        await attachMetadata(skill)
        skills.push(skill)
      }
    }
  }

  // 3. GitHub-imported skills
  const githubDir = resolveClaudePath('github')
  if (existsSync(githubDir)) {
    const { readImportsRegistry } = await import('../../utils/github')
    const registry = await readImportsRegistry('skills')

    for (const entry of registry.imports) {
      if (!existsSync(entry.localPath)) continue

      const scanRoot = entry.targetPath
        ? join(entry.localPath, entry.targetPath)
        : entry.localPath

      if (!existsSync(scanRoot)) continue

      /** Avoid duplicates when a GitHub skill is already visible via ~/.claude/skills symlink. */
      const slugClaimed = (slug: string) => skills.some(s => s.slug === slug)

      const shouldIncludeSkill = (slug: string) => {
        return entry.selectedItems?.includes(slug) || false
      }

      // Prefer skills-index.json when present so we match the same slug resolution
      // used during import/selection.
      const indexPathCandidates = [join(entry.localPath, 'skills-index.json'), join(scanRoot, 'skills-index.json')]
      const indexPath = indexPathCandidates.find(p => existsSync(p))

      if (indexPath) {
        try {
          const rawIndex = await readFile(indexPath, 'utf-8')
          const index = JSON.parse(rawIndex) as {
            skills?: Array<{
              slug: string
              name?: string
              description?: unknown
              files?: string[]
              path?: string
            }>
          }

          const targetPrefix = entry.targetPath || ''
          const indexedSkills = (index.skills || [])
            .filter(s => !!s.slug)
            .filter(s => {
              if (!targetPrefix) return true
              const filePath = s.files?.[0] || s.path || ''
              return filePath.startsWith(targetPrefix)
            })

          for (const s of indexedSkills) {
            const localSkillFilePath = join(entry.localPath, s.files?.[0] || s.path || '')
            if (!existsSync(localSkillFilePath)) continue
            if (!shouldIncludeSkill(s.slug)) continue
            if (slugClaimed(s.slug)) continue

            const raw = await readFile(localSkillFilePath, 'utf-8')
            const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw)
            if (!frontmatter.name || !frontmatter.description) continue

            const skill: Skill = {
              slug: s.slug,
              frontmatter: { ...frontmatter, name: frontmatter.name ?? s.slug },
              body,
              filePath: localSkillFilePath,
              source: 'github',
              githubRepo: `${entry.owner}/${entry.repo}`,
            }
            await attachMetadata(skill)
            skills.push(skill)
          }

          continue
        } catch {
          // Fall through to filesystem scan.
        }
      }

      // Fallback: scan imported repo on disk for markdown skills using frontmatter.
      // This supports repos that don't store skills as `/<slug>/SKILL.md`.
      const dedup = new Map<string, Skill>()

      const walkForSkills = async (dir: string) => {
        const dirEntries = await readdir(dir, { withFileTypes: true })
        for (const item of dirEntries) {
          if (item.name.startsWith('.')) continue

          const fullPath = join(dir, item.name)
          if (item.isDirectory()) {
            await walkForSkills(fullPath)
            continue
          }

          if (!item.isFile()) continue
          if (!item.name.toLowerCase().endsWith('.md')) continue

          // Parse only once we have a candidate skill-like markdown file.
          const raw = await readFile(fullPath, 'utf-8')
          const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw)
          if (!frontmatter.name || !frontmatter.description) continue

          const rel = relative(scanRoot, fullPath)
          const parts = rel.split(/[\\/]/).filter(Boolean)
          const fileName = parts.at(-1) || item.name
          const parentDir = parts.length >= 2 ? parts.at(-2) : undefined

          let slug =
            fileName.toLowerCase() === 'skill.md' && parentDir
              ? parentDir
              : fileName.replace(/\.md$/i, '')

          // If slug is 'SKILL' or empty, use frontmatter name
          if ((slug.toLowerCase() === 'skill' || !slug) && frontmatter.name) {
            slug = frontmatter.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
          }

          if (!slug) continue
          if (!shouldIncludeSkill(slug)) continue
          if (slugClaimed(slug)) continue
          if (dedup.has(slug)) continue

          const skill: Skill = {
            slug,
            frontmatter: { ...frontmatter, name: frontmatter.name ?? slug },
            body,
            filePath: fullPath,
            source: 'github',
            githubRepo: `${entry.owner}/${entry.repo}`,
          }
          await attachMetadata(skill)
          dedup.set(slug, skill)
        }
      }

      await walkForSkills(scanRoot)
      skills.push(...dedup.values())
    }
  }

  return skills.sort((a, b) => a.slug.localeCompare(b.slug))
})
