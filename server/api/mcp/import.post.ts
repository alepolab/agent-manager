import { requireCapability } from '../../utils/session'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const body = await readBody(event)
  const { content } = body

  if (!content) {
    throw createError({ statusCode: 400, message: 'No content provided' })
  }

  let importedData: any
  try {
    importedData = JSON.parse(content)
  } catch (err) {
    throw createError({ statusCode: 400, message: 'Invalid JSON content' })
  }

  // Expecting { mcpServers: { ... } } or just { ... } where keys are server names
  const newServers = importedData.mcpServers || importedData

  if (typeof newServers !== 'object' || newServers === null) {
    throw createError({ statusCode: 400, message: 'Invalid MCP configuration format' })
  }

  const filePath = join(homedir(), '.claude.json')
  let existingData: any = { mcpServers: {} }

  if (existsSync(filePath)) {
    try {
      const raw = await readFile(filePath, 'utf-8')
      existingData = JSON.parse(raw)
      if (!existingData.mcpServers) existingData.mcpServers = {}
    } catch (err) {
      console.error('Failed to parse existing .claude.json during import', err)
      existingData = { mcpServers: {} }
    }
  }

  // Merge servers
  for (const [name, config] of Object.entries(newServers)) {
    existingData.mcpServers[name] = config
  }

  // Write back
  await writeFile(filePath, JSON.stringify(existingData, null, 2), 'utf-8')

  return { success: true, count: Object.keys(newServers).length }
})
