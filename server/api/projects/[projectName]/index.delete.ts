import { deleteClaudeCodeProject } from '../../../utils/claudeCodeHistory'
import { requireCapability } from '../../../utils/session'
import { callerScope } from '../../../utils/sessionOwners'

export default defineEventHandler(async (event) => {
  // `configure`: this route mutates the instance, and carried no authorisation check —
  // the auth middleware proves WHO the caller is, never WHAT they may do.
  await requireCapability(event, 'configure')
  // A project holds everyone's sessions in it. Someone placed in a team may
  // delete their own and their team's, one by one, but not the whole folder.
  if (!(await callerScope(event)).all) {
    throw createError({ statusCode: 403, message: 'Deleting a whole project deletes other people\'s sessions too. Delete your own sessions instead.' })
  }
  const projectName = getRouterParam(event, 'projectName')
  if (!projectName) {
    throw createError({
      statusCode: 400,
      message: 'Project name is required'
    })
  }

  try {
    const success = await deleteClaudeCodeProject(projectName)
    if (!success) {
      throw createError({
        statusCode: 500,
        message: 'Failed to delete project'
      })
    }
    return { success: true }
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      message: error.message || 'Failed to delete project'
    })
  }
})
