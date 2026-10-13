import { getClaudeCodeProjects, projectSessionIds } from '../../../utils/claudeCodeHistory'
import { scopedProjects } from '../../../utils/sessionOwners'

export default defineEventHandler(async (event) => {
  try {
    const projects = await scopedProjects(event, await getClaudeCodeProjects(), projectSessionIds)

    return {
      projects,
      total: projects.length
    }
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      message: error.message || 'Failed to fetch Claude Code projects'
    })
  }
})
