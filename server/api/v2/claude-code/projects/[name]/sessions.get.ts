import { getClaudeCodeSessions } from '../../../../../utils/claudeCodeHistory'
import { scopedSessionPage } from '../../../../../utils/sessionOwners'

export default defineEventHandler(async (event) => {
  const projectName = getRouterParam(event, 'name')

  if (!projectName) {
    throw createError({
      statusCode: 400,
      message: 'Project name is required'
    })
  }

  const query = getQuery(event)
  const limit = parseInt(query.limit as string) || 20
  const offset = parseInt(query.offset as string) || 0

  try {
    // Scoped to the caller's own and their team's sessions when they are placed.
    const result = await scopedSessionPage(event, (l, o) => getClaudeCodeSessions(projectName, l, o), limit, offset)

    return {
      sessions: result.sessions,
      hasMore: result.hasMore,
      total: result.total,
      projectName
    }
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      message: error.message || 'Failed to fetch sessions'
    })
  }
})
