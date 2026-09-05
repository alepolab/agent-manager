import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from '../../utils/claudeDir'
import { parseFrontmatter } from '../../utils/frontmatter'
import type { Command, CommandFrontmatter } from '~/types'

async function scanDir(dir: string, relDir: string): Promise<Command[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const commands: Command[] = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const subCommands = await scanDir(fullPath, relDir ? `${relDir}/${entry.name}` : entry.name)
      commands.push(...subCommands)
    } else if (entry.name.endsWith('.md')) {
      const raw = await readFile(fullPath, 'utf-8')
      const { frontmatter, body } = parseFrontmatter<CommandFrontmatter>(raw)
      const filename = entry.name
      const directory = relDir
      const slug = directory
        ? `${directory.replace(/\//g, '--')}--${filename.replace(/\.md$/, '')}`
        : filename.replace(/\.md$/, '')

      commands.push({
        slug,
        filename,
        directory,
        frontmatter: { ...frontmatter, name: frontmatter.name ?? slug },
        body,
        filePath: fullPath,
      })
    }
  }

  return commands
}

export default defineEventHandler(async () => {
  const commandsDir = resolveClaudePath('commands')
  const commands = await scanDir(commandsDir, '')
  return commands.sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name))
})
