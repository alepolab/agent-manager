import { listProjects } from '../../utils/claudeProjects'
import { projectSessionIds } from '../../utils/claudeCodeHistory'
import { scopedProjects } from '../../utils/sessionOwners'

export default defineEventHandler(async (event) => {
  const projects = await scopedProjects(event, await listProjects(), projectSessionIds)
  return projects
})
