import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { parseFrontmatter } from '../../utils/frontmatter'
import { getPreloadingAgents, getMcpServerForSkill } from '../../utils/skillRelationships'
import type { SkillFrontmatter } from '~/types'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')!
  const body = await readBody<{ filePath: string }>(event)
  const { workingDir } = getQuery(event) as { workingDir?: string }

  if (!body.filePath || !existsSync(body.filePath)) {
    throw createError({ statusCode: 400, message: 'Valid filePath is required' })
  }

  try {
    const raw = await readFile(body.filePath, 'utf-8')
    const { frontmatter, body: contentBody } = parseFrontmatter<SkillFrontmatter>(raw)

    const preloadingAgents = await getPreloadingAgents(slug)
    const mcpServer = await getMcpServerForSkill(slug, frontmatter, contentBody, workingDir)

    // Determine source from filePath
    const githubDir = resolveClaudePath('github')
    const source = body.filePath.startsWith(githubDir) ? 'github' : 'local'

    return {
      slug,
      frontmatter: { ...frontmatter, name: frontmatter.name ?? slug },
      body: contentBody,
      filePath: body.filePath,
      source,
      agents: preloadingAgents,
      mcpServer,
    }
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      message: `Failed to read skill file: ${error.message}`,
    })
  }
})
