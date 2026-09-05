import { invalidate } from '../../utils/memo'
import { writeFile, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { serializeFrontmatter } from '../../utils/frontmatter'
import { slugToPath, pathToSlug } from '../../utils/slugUtils'
import type { CommandPayload } from '~/types'

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

  const payload = await readBody<CommandPayload & { lastModified?: number }>(event)
  // Stale-write protection: the editor sends the mtime it loaded; a newer
  // file on disk means someone else saved meanwhile.
  if (typeof payload.lastModified === 'number') {
    const current = (await stat(filePath)).mtimeMs
    if (Math.abs(current - payload.lastModified) > 1000) {
      throw createError({ statusCode: 409, message: 'This command changed on disk since you opened it. Reload to see the latest version.', data: { lastModified: current } })
    }
  }
  const content = serializeFrontmatter(payload.frontmatter, payload.body)

  let finalFilePath = filePath
  let finalSlug = slug

  // Rename file if the name in frontmatter changed
  const newName = payload.frontmatter.name
  if (newName && newName !== slug) {
    const newFilename = `${newName}.md`
    const newFilePath = directory
      ? resolveClaudePath('commands', directory, newFilename)
      : resolveClaudePath('commands', newFilename)

    if (newFilePath !== filePath) {
      // Ensure we don't overwrite an existing file
      if (existsSync(newFilePath)) {
        throw createError({ statusCode: 409, message: `A command with the name "${newName}" already exists.` })
      }
      await rename(filePath, newFilePath)
      finalFilePath = newFilePath
      finalSlug = pathToSlug(directory, newFilename)
    }
  }

  await writeFile(finalFilePath, content, 'utf-8')

  return {
    slug: finalSlug,
    filename: finalFilePath.split('/').pop(),
    directory,
    frontmatter: payload.frontmatter,
    body: payload.body,
    filePath: finalFilePath,
    lastModified: (await stat(finalFilePath)).mtimeMs,
  }
})
