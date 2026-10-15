import { detectSdkSession, loadSdkSessionMessages } from '../../../utils/sdkSessionStorage'
import { requireSessionAccess } from '../../../utils/sessionOwners'

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, 'sessionId')
  // Yours, your team's, or - unplaced - anyone's: see sessionOwners.ts.
  if (sessionId) await requireSessionAccess(event, sessionId)

  if (!sessionId) {
    throw createError({
      statusCode: 400,
      message: 'Session ID is required',
    })
  }

  const query = getQuery(event)
  const projectNameParam = query.projectName as string
  const limit = query.limit ? parseInt(query.limit as string) : 50
  const offset = query.offset ? parseInt(query.offset as string) : 0

  try {
    let projectName = projectNameParam
    if (!projectName) {
      projectName = await detectSdkSession(sessionId) || ''
    }

    if (!projectName) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
      }
    }

    const result = await loadSdkSessionMessages(projectName, sessionId, {
      limit,
      offset,
    })

    return {
      messages: result.messages,
      total: result.total,
      hasMore: result.hasMore,
    }
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      message: error.message || 'Failed to fetch session messages',
    })
  }
})
