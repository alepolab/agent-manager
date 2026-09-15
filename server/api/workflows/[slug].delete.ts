import { requireCapability } from '../../utils/session'
import { unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const slug = getRouterParam(event, 'slug')
  const filePath = resolveClaudePath('workflows', `${slug}.json`)

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: 'Workflow not found' })
  }

  await unlink(filePath)
  return { deleted: true }
})
