import { getClaudeCodeSessionMessages } from '../../../../../../../utils/claudeCodeHistory'
import { requireSessionAccess } from '../../../../../../../utils/sessionOwners'

export default defineEventHandler(async (event) => {
  const projectName = getRouterParam(event, 'name')
  const sessionId = getRouterParam(event, 'sessionId')
  // Yours, your team's, or - unplaced - anyone's: see sessionOwners.ts.
  if (sessionId) await requireSessionAccess(event, sessionId)

  if (!projectName) {
    throw createError({
      statusCode: 400,
      message: 'Project name is required'
    })
  }

  if (!sessionId) {
    throw createError({
      statusCode: 400,
      message: 'Session ID is required'
    })
  }

  const query = getQuery(event)
  const limit = query.limit ? parseInt(query.limit as string) : null
  const offset = parseInt(query.offset as string) || 0

  try {
    const result = await getClaudeCodeSessionMessages(projectName, sessionId, limit, offset)

    return {
      messages: result.messages,
      total: result.total,
      hasMore: result.hasMore,
      tokenUsage: result.tokenUsage,
      model: result.model,
      projectName,
      sessionId
    }
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      message: error.message || 'Failed to fetch messages'
    })
  }
})
