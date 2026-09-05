import { invalidate } from '../../utils/memo'
import { writeFile, rename, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { serializeFrontmatter } from '../../utils/frontmatter'
import { decodeAgentSlug, encodeAgentSlug, resolveAgentFilePath } from '../../utils/agentUtils'
import type { AgentPayload } from '~/types'

export default defineEventHandler(async (event) => {
  invalidate('agents'); invalidate('relationships')
  const slug = getRouterParam(event, 'slug')!
  const filePath = resolveAgentFilePath(slug)

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: `Agent not found: ${slug}` })
  }

  const payload = await readBody<AgentPayload & { lastModified?: number }>(event)

  // File conflict detection
  if (payload.lastModified) {
    const fileStat = await stat(filePath)
    if (Math.abs(fileStat.mtimeMs - payload.lastModified) > 1000) {
      throw createError({ statusCode: 409, message: 'This file was modified externally. Reload to see the latest version.' })
    }
  }

  const newDirectory = payload.directory ?? decodeAgentSlug(slug).directory
  const newName = payload.frontmatter.name
  const newSlug = encodeAgentSlug(newDirectory, newName)
  const newFilePath = resolveAgentFilePath(newSlug)

  // Ensure target directory exists
  if (newDirectory) {
    const targetDir = resolveClaudePath('agents', ...newDirectory.split('/'))
    if (!existsSync(targetDir)) {
      await mkdir(targetDir, { recursive: true })
    }
  }

  const content = serializeFrontmatter(payload.frontmatter, payload.body)
  await writeFile(newFilePath, content, 'utf-8')

  // Remove old file if path changed
  if (filePath !== newFilePath) {
    const { unlink } = await import('node:fs/promises')
    await unlink(filePath)
  }

  // Rename memory directory if slug changed
  if (slug !== newSlug) {
    const oldMemDir = resolveClaudePath('agent-memory', slug)
    const newMemDir = resolveClaudePath('agent-memory', newSlug)
    if (existsSync(oldMemDir) && !existsSync(newMemDir)) {
      await rename(oldMemDir, newMemDir)
    }
  }

  // Create or remove memory directory based on memory setting
  const memoryDir = resolveClaudePath('agent-memory', newSlug)
  const isPersistent = payload.frontmatter.memory && ['user', 'project', 'local'].includes(payload.frontmatter.memory)

  if (isPersistent) {
    if (!existsSync(memoryDir)) {
      await mkdir(memoryDir, { recursive: true })
    }
  } else {
    if (existsSync(memoryDir)) {
      const { rm } = await import('node:fs/promises')
      await rm(memoryDir, { recursive: true })
    }
  }

  const newStat = await stat(newFilePath)

  return {
    slug: newSlug,
    filename: `${newName}.md`,
    directory: newDirectory,
    frontmatter: payload.frontmatter,
    body: payload.body,
    hasMemory: existsSync(resolveClaudePath('agent-memory', newSlug)),
    filePath: newFilePath,
    lastModified: newStat.mtimeMs,
  }
})
