import { detectSdkSession, loadSdkSessionMessages } from '../../../utils/sdkSessionStorage'
import { requireSessionAccess } from '../../../utils/sessionOwners'

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

  try {
    const query = getQuery(event)
    const limit = query.limit ? parseInt(query.limit as string) : 50
    const offset = query.offset ? parseInt(query.offset as string) : 0

    console.log(`[GET session] Loading session ${id}, limit: ${limit}, offset: ${offset}`)

    // Always call detectSdkSession(id) -> loadSdkSessionMessages(projectName, id, ...) directly
    const projectName = await detectSdkSession(id)
    let messagesResult: any = { messages: [], total: 0, hasMore: false }

    if (projectName) {
      console.log(`[GET session] Found SDK session in project: ${projectName}`)
      messagesResult = await loadSdkSessionMessages(projectName, id, {
        limit,
        offset,
      })
      console.log(`[GET session] SDK messages:`, messagesResult.total)
    } else {
      console.log(`[GET session] No SDK session found for ${id}`)
    }

    const { messages, total, hasMore } = messagesResult

    if (total === 0) {
      // This should never happen now, but handle it gracefully just in case
      console.warn(`[GET session] No session data found for ${id}`)
      const now = new Date().toISOString()
      return {
        id,
        messages: [],
        createdAt: now,
        lastActivity: now,
        status: 'active',
        messageCount: 0,
        pagination: {
          total: 0,
          limit,
          offset,
          hasMore: false,
        },
      }
    }

    // Extract metadata from first message if available
    const firstMessage = messages[0]
    const lastMessage = messages[messages.length - 1]

    return {
      id,
      agentSlug: firstMessage?.metadata?.agentSlug,
      workingDir: firstMessage?.metadata?.workingDir,
      messages,
      createdAt: firstMessage?.timestamp || new Date().toISOString(),
      lastActivity: lastMessage?.timestamp || new Date().toISOString(),
      status: 'active',
      messageCount: total,
      pagination: {
        total,
        limit,
        offset,
        hasMore,
      },
    }
  } catch (error: any) {
    console.error(`[GET session] Error loading session ${id}:`, error)

    // Return empty session on error (graceful degradation - no 404/500)
    const now = new Date().toISOString()
    return {
      id,
      messages: [],
      createdAt: now,
      lastActivity: now,
      status: 'active',
      messageCount: 0,
      pagination: {
        total: 0,
        limit: parseInt(getQuery(event).limit as string) || 50,
        offset: parseInt(getQuery(event).offset as string) || 0,
        hasMore: false,
      },
    }
  }
})
