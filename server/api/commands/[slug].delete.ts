import { invalidate } from '../../utils/memo'
import { unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { slugToPath } from '../../utils/slugUtils'

export default defineEventHandler(async (event) => {
  invalidate('relationships')
  const slug = getRouterParam(event, 'slug')!
  const { directory, filename } = slugToPath(slug)
  const filePath = directory
    ? resolveClaudePath('commands', directory, filename)
    : resolveClaudePath('commands', filename)

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: `Command not found: ${slug}` })
  }

  try {
    await unlink(filePath)
  } catch {
    throw createError({ statusCode: 500, message: `Failed to delete command: ${slug}` })
  }

  return { deleted: true, slug }
})
