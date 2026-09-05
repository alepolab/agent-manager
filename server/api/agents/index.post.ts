import { invalidate } from '../../utils/memo'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { serializeFrontmatter } from '../../utils/frontmatter'
import { encodeAgentSlug, resolveAgentFilePath } from '../../utils/agentUtils'
import type { AgentPayload } from '~/types'

export default defineEventHandler(async (event) => {
  invalidate('agents'); invalidate('relationships')
  const payload = await readBody<AgentPayload>(event)
  const directory = payload.directory ?? ''
  const name = payload.frontmatter.name
  const slug = encodeAgentSlug(directory, name)
  const filePath = resolveAgentFilePath(slug)

  if (existsSync(filePath)) {
    throw createError({ statusCode: 409, message: `Agent already exists: ${slug}` })
  }

  // Ensure target directory exists
  const targetDir = directory
    ? resolveClaudePath('agents', ...directory.split('/'))
    : resolveClaudePath('agents')
  if (!existsSync(targetDir)) {
    await mkdir(targetDir, { recursive: true })
  }

  const content = serializeFrontmatter(payload.frontmatter, payload.body)
  await writeFile(filePath, content, 'utf-8')

  // Create memory directory if memory is enabled
  if (payload.frontmatter.memory && payload.frontmatter.memory !== 'none') {
    const memoryDir = resolveClaudePath('agent-memory', slug)
    if (!existsSync(memoryDir)) {
      await mkdir(memoryDir, { recursive: true })
    }
  }

  return {
    slug,
    filename: `${name}.md`,
    directory,
    frontmatter: payload.frontmatter,
    body: payload.body,
    hasMemory: payload.frontmatter.memory !== undefined && payload.frontmatter.memory !== 'none',
    filePath,
  }
})
