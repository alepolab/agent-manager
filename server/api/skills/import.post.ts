import { invalidate } from '../../utils/memo'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { parseFrontmatter, serializeFrontmatter } from '../../utils/frontmatter'
import type { SkillFrontmatter } from '~/types'

export default defineEventHandler(async (event) => {
  invalidate('skills'); invalidate('relationships')
  const { content } = await readBody<{ content: string }>(event)

  if (!content?.trim()) {
    throw createError({ statusCode: 400, message: 'File content is required' })
  }

  const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(content)

  if (!frontmatter.name) {
    throw createError({ statusCode: 400, message: 'Skill file must have a name in frontmatter' })
  }

  const slug = frontmatter.name
  const skillDir = resolveClaudePath('skills', slug)
  if (existsSync(skillDir)) {
    throw createError({ statusCode: 409, message: `Skill "${slug}" already exists` })
  }

  await mkdir(skillDir, { recursive: true })
  const filePath = resolveClaudePath('skills', slug, 'SKILL.md')
  const serialized = serializeFrontmatter(frontmatter, body)
  await writeFile(filePath, serialized, 'utf-8')

  return {
    slug,
    frontmatter,
    body,
    filePath,
  }
})
