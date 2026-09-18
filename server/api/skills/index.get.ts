import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { parseFrontmatter } from '../../utils/frontmatter'
import { resolvePluginInstallPath } from '../../utils/marketplace'
import { loadMcpServers, matchMcpServer } from '../../utils/skillRelationships'
import { memo } from '../../utils/memo'
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
  return memo(`skills:list:${resolveClaudePath('skills')}:${workingDir ?? ''}`, 30_000, async () => {
  const skills: Skill[] = []

  // Load all agents to find preloading associations
  const agentsDir = resolveClaudePath('agents')
  const agentPreloads = new Map<string, { name: string; slug: string }[]>() // skillSlug -> {name, slug}[]
  /**
   * Agent bodies, for the skills an agent reads WITHOUT declaring.
   *
   * The sdlc agents deliberately do not declare the language-matched or
   * large skill sets in frontmatter: buildAgentSystemPrompt inlines
   * the full body of every declared skill, and declaring all 24 language
   * skills measured at ~80,000 tokens added to every agent's prompt on every
   * step (see scripts/test-vendored-ecc-skills.mjs). They carry a catalogue
   * instead and read the matching file from $SDLC_SKILLS_DIR
   * at run time.
   *
   * The relationship is real either way - it is how the skill reaches an agent
   * at all - but it lived only inside prompt prose, so the page showed no
   * agent for 59 of the skills on this instance. `readBy` is that half of it,
   * kept separate from `agents` because the difference is the 80,000 tokens.
   */
  const agentBodies: { name: string; slug: string; body: string }[] = []

  if (existsSync(agentsDir)) {
    const agentFiles = await readdir(agentsDir)
    for (const file of agentFiles) {
      if (!file.endsWith('.md')) continue
      try {
        const agentSlug = file.replace(/\.md$/, '')
        const raw = await readFile(join(agentsDir, file), 'utf-8')
        const { frontmatter, body } = parseFrontmatter<{ name: string; skills?: string[] }>(raw)
        const agentName = frontmatter.name || agentSlug
        const preloadedSkills = frontmatter.skills || []
        agentBodies.push({ name: agentName, slug: agentSlug, body })

        for (const skillSlug of preloadedSkills) {
          if (!agentPreloads.has(skillSlug)) agentPreloads.set(skillSlug, [])
          agentPreloads.get(skillSlug)!.push({ name: agentName, slug: agentSlug })
        }
      } catch {
        // Skip invalid agent files
      }
    }
  }

  // Helper to attach agents and MCP server to a skill. Servers are loaded
  // once for the whole list; the match itself is pure.
  const mcpServers = await loadMcpServers(workingDir)
  const attachMetadata = async (skill: Skill) => {
    skill.agents = agentPreloads.get(skill.slug) || []
    // Two shapes, both exact enough not to guess: the run-time path an agent
    // is told to cat, and the backticked row in its skill catalogue. A bare
    // mention in prose is not a reference - `ponytail` the word appears in
    // plenty of sentences that are not telling an agent to read it.
    const declared = new Set(skill.agents.map(a => a.slug))
    const readBy = agentBodies.filter(a => !declared.has(a.slug) && (
      a.body.includes(`_SKILLS_DIR/${skill.slug}/`) || a.body.includes(`\`${skill.slug}\``)
    )).map(({ name, slug }) => ({ name, slug }))
    if (readBy.length) skill.readBy = readBy
    skill.mcpServer = matchMcpServer(mcpServers, skill.slug, skill.frontmatter, skill.body ?? '')
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

  /**
   * A slug already on the list. The seeder COPIES a plugin's skills into
   * CLAUDE_DIR/skills, so every seeded skill exists twice on disk - once
   * where it was installed, once where it is read - and listing both sources
   * blind showed each of them twice on the page.
   *
   * The local copy wins because it is the one that runs: `resolveSkill`
   * checks CLAUDE_DIR/skills first, and an agent edited through the UI reads
   * that file, not the plugin's. Listing the plugin's copy beside it offers a
   * second entry that no agent will ever use.
   */
  const claimed = (slug: string) => skills.some(s => s.slug === slug)

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
        // After the slug is derived, not before: a directory literally named
        // SKILL takes its slug from the frontmatter, and that is the name the
        // local copy would have been listed under too.
        if (claimed(slug)) continue

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
      const slugClaimed = claimed

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

  // The list never renders a body and shipping every one of them made the
  // response several megabytes; the detail route still returns it.
  return skills.sort((a, b) => a.slug.localeCompare(b.slug)).map(({ body: _body, ...rest }) => rest)
  })
})
