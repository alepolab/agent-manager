import { randomUUID } from 'node:crypto'
import type { ChatSession } from '~/types'
import { requireCapability } from '../../../utils/session'

export default defineEventHandler(async (event) => {
  // `configure`: this route mutates the instance, and carried no authorisation check —
  // the auth middleware proves WHO the caller is, never WHAT they may do.
  await requireCapability(event, 'configure')
  const body = await readBody(event)
  const { agentSlug, workingDir } = body

  // Generate new session ID
  const sessionId = randomUUID()
  const now = new Date().toISOString()

  // NOTE: We don't create an empty session file here.
  // The session file will be created lazily when the first message is saved.
  // This prevents empty files from cluttering the filesystem.

  // Return session metadata
  const session: ChatSession = {
    id: sessionId,
    agentSlug,
    workingDir,
    messages: [], // Empty messages array for new session
    createdAt: now,
    lastActivity: now,
    status: 'active',
    messageCount: 0,
  }

  return session
})
