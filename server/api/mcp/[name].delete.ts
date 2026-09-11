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
    if (!workingDir || typeof workingDir !== 'string') {
      throw createError({ statusCode: 400, message: 'Working directory is required for project scope' })
    }
    filePath = join(workingDir, '.mcp.json')
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
