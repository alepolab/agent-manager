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
    // Where a ticket key links to. The same resolution the Jira client uses,
    // with the host users.ts falls back to when the instance names none.
    jiraBaseUrl: jiraBaseUrl() ?? 'https://alepo.atlassian.net',
  }
})
