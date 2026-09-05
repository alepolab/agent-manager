import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { parseFrontmatter } from '../../utils/frontmatter'
import { encodeAgentSlug } from '../../utils/agentUtils'
import type { Agent, AgentFrontmatter } from '~/types'

async function scanDir(dir: string, relDir: string): Promise<Agent[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const agents: Agent[] = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const subAgents = await scanDir(fullPath, relDir ? `${relDir}/${entry.name}` : entry.name)
      agents.push(...subAgents)
    } else if (entry.name.endsWith('.md')) {
      const raw = await readFile(fullPath, 'utf-8')
      const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(raw)
      const name = entry.name.replace(/\.md$/, '')
      const slug = encodeAgentSlug(relDir, name)
      const memoryDir = resolveClaudePath('agent-memory', slug)
      const hasMemory = existsSync(memoryDir)

      agents.push({
        slug,
        filename: entry.name,
        directory: relDir,
        frontmatter: { ...frontmatter, name: frontmatter.name ?? slug },
        body,
        hasMemory,
        filePath: fullPath,
      })
    }
  }

  return agents
}

export default defineEventHandler(async () => {
  const agentsDir = resolveClaudePath('agents')
  const agents = await scanDir(agentsDir, '')
  return agents.sort((a, b) => a.slug.localeCompare(b.slug))
})
