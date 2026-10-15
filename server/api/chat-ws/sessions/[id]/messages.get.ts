import { loadSessionMessages } from '../../../../utils/chatSessionStorage'
import { requireSessionAccess } from '../../../../utils/sessionOwners'

/**
 * GET /api/chat/sessions/:id/messages
 * Fetch messages for a session with pagination
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  // Yours, your team's, or - unplaced - anyone's: see sessionOwners.ts.
  if (id) await requireSessionAccess(event, id)

  if (!id) {
    throw createError({
      statusCode: 400,
      message: 'Session ID is required',
    })
  }

  // Get query parameters for pagination
  const query = getQuery(event)
  const limit = query.limit ? Number(query.limit) : 50
  const offset = query.offset ? Number(query.offset) : 0

  try {
    const result = await loadSessionMessages(id, { limit, offset })

    return {
      sessionId: id,
      messages: result.messages,
      total: result.total,
      hasMore: result.hasMore,
      limit,
      offset,
    }
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      message: `Failed to load session messages: ${error.message}`,
    })
  }
})
