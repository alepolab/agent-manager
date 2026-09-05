/**
 * Swaps the watcher's file-backed ticket stub for the jira-cli backed source.
 * Opt-in: JIRA_TICKET_SOURCE=cli. Off by default so a host without the CLI,
 * or without its login, keeps the stub and never dispatches from a query it
 * cannot actually run.
 */
import { setTicketSource } from '../utils/ticketSource.ts'
import { createJiraTicketSource } from '../utils/jiraTicketSource.ts'

export default defineNitroPlugin(() => {
  if (process.env.JIRA_TICKET_SOURCE !== 'cli') return
  setTicketSource(createJiraTicketSource())
  console.log('[jiraSource] watches read tickets through the jira CLI')
})
