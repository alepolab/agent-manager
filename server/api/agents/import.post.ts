import { invalidate } from '../../utils/memo'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { parseFrontmatter, serializeFrontmatter } from '../../utils/frontmatter'
import type { AgentFrontmatter } from '~/types'

export default defineEventHandler(async (event) => {
  invalidate('agents'); invalidate('relationships')
  const { content } = await readBody<{ content: string }>(event)

  if (!content?.trim()) {
    throw createError({ statusCode: 400, message: 'File content is required' })
  }

  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content)

  if (!frontmatter.name) {
    throw createError({ statusCode: 400, message: 'Agent file must have a name in frontmatter' })
  }

  const slug = frontmatter.name
  const agentsDir = resolveClaudePath('agents')
  if (!existsSync(agentsDir)) {
    await mkdir(agentsDir, { recursive: true })
  }

  const filePath = resolveClaudePath('agents', `${slug}.md`)
  if (existsSync(filePath)) {
    throw createError({ statusCode: 409, message: `Agent "${slug}" already exists` })
  }

  const serialized = serializeFrontmatter(frontmatter, body)
  await writeFile(filePath, serialized, 'utf-8')

  return {
    slug,
    filename: `${slug}.md`,
    frontmatter,
    body,
    hasMemory: false,
    filePath,
  }
})
