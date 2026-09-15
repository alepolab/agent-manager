import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getClaudeDir, resolveClaudePath } from '../utils/claudeDir'
import { requireCapability } from '../utils/session'

export default defineEventHandler(async (event) => {
  // `configure`: this route mutates the instance, and carried no authorisation check —
  // the auth middleware proves WHO the caller is, never WHAT they may do.
  await requireCapability(event, 'configure')
  const claudeDir = getClaudeDir()

  if (existsSync(claudeDir)) {
    return { created: false, claudeDir, message: 'Directory already exists' }
  }

  // Create the main directory and subdirectories
  const dirs = [
    claudeDir,
    resolveClaudePath('agents'),
    resolveClaudePath('commands'),
    resolveClaudePath('skills'),
    resolveClaudePath('workflows'),
  ]

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true })
  }

  return { created: true, claudeDir }
})
