import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import type { Workflow } from '~/types'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  const filePath = resolveClaudePath('workflows', `${slug}.json`)

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: 'Workflow not found' })
  }

  const raw = await readFile(filePath, 'utf-8')
  const data = JSON.parse(raw)
  return { slug, filePath, ...data, lastModified: (await stat(filePath)).mtimeMs } as Workflow
})
