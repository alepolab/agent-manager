import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { parseFrontmatter } from '../../utils/frontmatter'
import { decodeAgentSlug, resolveAgentFilePath } from '../../utils/agentUtils'
import type { AgentFrontmatter } from '~/types'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')!
  const { workingDir } = getQuery(event) as { workingDir?: string }

  // Check project-local agent first when workingDir is provided
  let filePath = resolveAgentFilePath(slug)
  if (workingDir && !existsSync(filePath)) {
    const { join } = await import('node:path')
    const projectPaths = [
      join(workingDir, '.claude', 'agents', `${slug}.md`),
      join(workingDir, 'agents', `${slug}.md`),
    ]
    for (const p of projectPaths) {
      if (existsSync(p)) { filePath = p; break }
    }
  }

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: `Agent not found: ${slug}` })
  }

  const [raw, fileStat] = await Promise.all([
    readFile(filePath, 'utf-8'),
    stat(filePath),
  ])
  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(raw)
  const { directory } = decodeAgentSlug(slug)
  const memoryDir = resolveClaudePath('agent-memory', slug)

  return {
    slug,
    filename: `${slug}.md`,
    directory,
    frontmatter: { ...frontmatter, name: frontmatter.name ?? slug },
    body,
    hasMemory: existsSync(memoryDir),
    filePath,
    lastModified: fileStat.mtimeMs,
  }
})
