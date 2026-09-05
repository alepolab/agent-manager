import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { parseFrontmatter } from '../../utils/frontmatter'
import { slugToPath } from '../../utils/slugUtils'
import type { CommandFrontmatter } from '~/types'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')!
  const { directory, filename } = slugToPath(slug)
  const filePath = directory
    ? resolveClaudePath('commands', directory, filename)
    : resolveClaudePath('commands', filename)

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: `Command not found: ${slug}` })
  }

  const raw = await readFile(filePath, 'utf-8')
  const { frontmatter, body } = parseFrontmatter<CommandFrontmatter>(raw)

  return {
    slug,
    filename,
    directory,
    frontmatter: { ...frontmatter, name: frontmatter.name ?? slug },
    body,
    filePath,
  }
})
