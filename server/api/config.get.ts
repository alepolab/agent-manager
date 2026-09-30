import { existsSync } from 'node:fs'
import { getClaudeDir } from '../utils/claudeDir'
import { jiraBaseUrl } from '../utils/jiraCredentials'

export default defineEventHandler(() => {
  const claudeDir = getClaudeDir()
  return {
    claudeDir,
    exists: existsSync(claudeDir),
    // Host-only actions (folder picker, reveal in file manager) only make
    // sense when the browser and the server share a desktop.
    localDesktop: process.env.LOCAL_DESKTOP === '1',
    authDisabled: process.env.AUTH_DISABLED === '1',
    // Where a ticket key links to: the same resolution the Jira client uses.
    // None when the instance names no Jira; keys then render as plain text
    // rather than linking to someone else's.
    jiraBaseUrl: jiraBaseUrl() ?? null,
  }
})
