import { requireCapability } from '../../utils/session'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const name = getRouterParam(event, 'name')
  const { scope, workingDir } = getQuery(event)

  if (!name) {
    throw createError({ statusCode: 400, message: 'Server name is required' })
  }

  let filePath = ''
  if (scope === 'global') {
    filePath = join(homedir(), '.claude.json')
  } else if (scope === 'project') {
    // Same fallback as the listing: with no directory chosen the project is
    // the one the server runs in, so a server this page listed is a server
    // this route can remove. Refusing here while the list showed it is the
    // pair of behaviours that made the page look broken.
    filePath = join((typeof workingDir === 'string' && workingDir) || process.cwd(), '.mcp.json')
  } else {
    throw createError({ statusCode: 400, message: 'Invalid scope' })
  }

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, message: 'Configuration file not found' })
  }

  let data: any = {}
  try {
    const raw = await readFile(filePath, 'utf-8')
    data = JSON.parse(raw)
  } catch (err) {
    throw createError({ statusCode: 500, message: 'Failed to parse configuration file' })
  }

  if (!data.mcpServers || !data.mcpServers[name]) {
    throw createError({ statusCode: 404, message: 'Server not found' })
  }

  // Remove the server
  delete data.mcpServers[name]

  // Write back to file
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')

  return { success: true }
})
