import { invalidate } from '../../utils/memo'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'

export default defineEventHandler(async (event) => {
  invalidate('skills'); invalidate('relationships')
  const slug = getRouterParam(event, 'slug')!
  const skillDir = resolveClaudePath('skills', slug)

  if (!existsSync(skillDir)) {
    throw createError({ statusCode: 404, message: `Skill not found: ${slug}` })
  }

  try {
    await rm(skillDir, { recursive: true })
  } catch {
    throw createError({ statusCode: 500, message: `Failed to delete skill: ${slug}` })
  }

  return { deleted: true, slug }
})
