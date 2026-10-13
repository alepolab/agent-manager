import { listSessions } from '../../../utils/claudeProjects'
import { callerScope, visibleSessions } from '../../../utils/sessionOwners'

export default defineEventHandler(async (event) => {
  const projectName = getRouterParam(event, 'project')

  if (!projectName) {
    throw createError({
      statusCode: 400,
      message: 'Project name is required',
    })
  }

  const sessions = await visibleSessions(await callerScope(event), await listSessions(projectName))
  return sessions
})
