import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath, getClaudeDir } from '../utils/claudeDir'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, message: 'Request body must be a JSON object' })
  }
  // settings.json is Claude Code's own file: a malformed shape here breaks the
  // CLI for everyone using this config, so the sections it reads are checked.
  for (const key of ['hooks', 'permissions', 'env', 'agentManager']) {
    const v = (body as Record<string, unknown>)[key]
    if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) {
      throw createError({ statusCode: 400, message: `settings.${key} must be an object` })
    }
  }
  if ((body as any).permissions) for (const k of ['allow', 'deny', 'ask']) {
    const v = (body as any).permissions[k]
    if (v !== undefined && !Array.isArray(v)) throw createError({ statusCode: 400, message: `settings.permissions.${k} must be an array` })
  }

  const claudeDir = getClaudeDir()
  if (!existsSync(claudeDir)) {
    throw createError({ statusCode: 400, message: `Claude directory does not exist: ${claudeDir}` })
  }

  const filePath = resolveClaudePath('settings.json')
  try {
    await writeFile(filePath, JSON.stringify(body, null, 2), 'utf-8')
  } catch {
    throw createError({ statusCode: 500, message: 'Failed to write settings.json' })
  }
  return body
})
