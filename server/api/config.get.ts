import { existsSync } from 'node:fs'
import { getClaudeDir } from '../utils/claudeDir'

export default defineEventHandler(() => {
  const claudeDir = getClaudeDir()
  return {
    claudeDir,
    exists: existsSync(claudeDir),
    // Host-only actions (folder picker, reveal in file manager) only make
    // sense when the browser and the server share a desktop.
    localDesktop: process.env.LOCAL_DESKTOP === '1',
  }
})
