import { readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import type { Workflow } from '~/types'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  const filePath = resolveClaudePath('workflows', `${slug}.json`)

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: 'Workflow not found' })
  }

  const { lastModified, ...body } = await readBody(event) ?? {}
  if (typeof lastModified === 'number') {
    const current = (await stat(filePath)).mtimeMs
    if (Math.abs(current - lastModified) > 1000) {
      throw createError({ statusCode: 409, message: 'This workflow changed on disk since you opened it. Reload to see the latest version.', data: { lastModified: current } })
    }
  }
  const existing = JSON.parse(await readFile(filePath, 'utf-8'))
  const updated = { ...existing, ...body }
  await writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8')
  return { slug, filePath, ...updated, lastModified: (await stat(filePath)).mtimeMs } as Workflow
})
