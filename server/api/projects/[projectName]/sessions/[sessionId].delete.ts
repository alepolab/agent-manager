import { deleteClaudeCodeSession } from '../../../../utils/claudeCodeHistory'
import { requireSessionAccess } from '../../../../utils/sessionOwners'

export default defineEventHandler(async (event) => {
  // `configure`: this route mutates the instance, and carried no authorisation check —
  // the auth middleware proves WHO the caller is, never WHAT they may do.
  const projectName = getRouterParam(event, 'projectName')
  const sessionId = getRouterParam(event, 'sessionId')
  // By role, or as its owner or their lead: see sessionOwners.ts.
  await requireSessionAccess(event, sessionId ?? '', 'configure')

  if (!projectName || !sessionId) {
    throw createError({
      statusCode: 400,
      message: 'Project name and session ID are required',
    })
  }

  try {
    console.log(`[API] Deleting Claude Code session: ${sessionId} from project: ${projectName}`)
    const success = await deleteClaudeCodeSession(projectName, sessionId)

    if (!success) {
      throw createError({
        statusCode: 404,
        message: `Session ${sessionId} not found in project ${projectName}`,
      })
    }

    return { success: true }
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      message: error.message || 'Failed to delete session',
    })
  }
})
