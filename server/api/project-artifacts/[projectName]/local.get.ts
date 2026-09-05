import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { existsSync } from 'node:fs'
import { parseFrontmatter } from '../../../utils/frontmatter'
import { getClaudeCodeProjects } from '../../../utils/claudeCodeHistory'
import type { Agent, Skill, AgentFrontmatter, SkillFrontmatter } from '~/types'

export default defineEventHandler(async (event) => {
  const projectName = getRouterParam(event, 'projectName')
  if (!projectName) {
    throw createError({ statusCode: 400, message: 'Missing projectName' })
  }

  const projects = await getClaudeCodeProjects()
  const project = projects.find(p => p.name === projectName)

  if (!project) {
    throw createError({ statusCode: 404, message: 'Project not found' })
  }

  const projectPath = project.path
  const agents: Agent[] = []
  const skills: Skill[] = []

  // Directories to scan for agents
  const agentDirs = [
    join(projectPath, 'agents'),
    join(projectPath, '.claude', 'agents')
  ]

  for (const agentsDir of agentDirs) {
    if (existsSync(agentsDir)) {
      try {
        const files = await readdir(agentsDir)
        for (const file of files) {
          if (!file.endsWith('.md')) continue
          try {
            const slug = file.replace(/\.md$/, '')
            const filePath = join(agentsDir, file)
            
            // Avoid duplicates if same slug exists in both places
            if (agents.some(a => a.slug === slug)) continue

            const raw = await readFile(filePath, 'utf-8')
            const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(raw)
            
            agents.push({
              slug,
              filename: file,
              directory: relative(projectPath, agentsDir),
              frontmatter: { ...frontmatter, name: frontmatter.name ?? slug, description: frontmatter.description ?? '' },
              body,
              hasMemory: frontmatter.memory === 'local' || frontmatter.memory === 'project',
              filePath,
            })
          } catch {
            // skip
          }
        }
      } catch {
        // skip
      }
    }
  }

  // Scan all SKILL.md files up to 2 levels deep in the project
  const ALLOWED_HIDDEN = new Set(['.claude', '.agents'])

  async function findSkillFiles(dir: string, depth: number): Promise<string[]> {
    if (depth > 4) return []
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const results: string[] = []
      for (const entry of entries) {
        if (entry.name.startsWith('.') && !ALLOWED_HIDDEN.has(entry.name)) continue
        const fullPath = join(dir, entry.name)
        if (entry.isFile() && entry.name === 'SKILL.md') {
          results.push(fullPath)
        } else if (entry.isDirectory()) {
          results.push(...await findSkillFiles(fullPath, depth + 1))
        }
      }
      return results
    } catch {
      return []
    }
  }

  const skillFiles = await findSkillFiles(projectPath, 0)

  for (const skillPath of skillFiles) {
    try {
      const raw = await readFile(skillPath, 'utf-8')
      const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw)

      const dirName = skillPath.split('/').at(-2) || ''
      let slug = dirName
      if ((slug.toLowerCase() === 'skill' || !slug) && frontmatter.name) {
        slug = frontmatter.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      }

      if (skills.some(s => s.slug === slug)) continue

      skills.push({
        slug,
        frontmatter: { ...frontmatter, name: frontmatter.name ?? slug, description: frontmatter.description ?? '' },
        body,
        filePath: skillPath,
        source: 'local',
      })
    } catch {
      // skip
    }
  }

  return { agents, skills, project }
})
