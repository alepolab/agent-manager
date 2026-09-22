import { detectSdkSession } from '../../../utils/sdkSessionStorage'
import { renameClaudeCodeSession } from '../../../utils/claudeCodeHistory'
import { requireCapability } from '../../../utils/session'

export default defineEventHandler(async (event) => {
  // `configure`: this route mutates the instance, and carried no authorisation check —
  // the auth middleware proves WHO the caller is, never WHAT they may do.
  await requireCapability(event, 'configure')
  const sessionId = getRouterParam(event, 'sessionId')
  const body = await readBody(event)
  const { summary } = body

  if (!sessionId || !summary) {
    throw createError({
      statusCode: 400,
      message: 'Session ID and summary are required',
    })
  }

  try {
    let projectName = body.projectName
    if (!projectName) {
      projectName = await detectSdkSession(sessionId)
    }

    if (!projectName) {
      throw createError({
        statusCode: 404,
        message: `Session ${sessionId} not found in any Claude Code project`,
      })
    }

    console.log(`[API] Renaming Claude Code session: ${sessionId} to "${summary}" in project: ${projectName}`)
    const success = await renameClaudeCodeSession(projectName, sessionId, summary)

    return { success }
  } catch (error: any) {
    if (error.statusCode) throw error
    throw createError({
      statusCode: 500,
      message: error.message || 'Failed to rename session',
    })
  }
})
