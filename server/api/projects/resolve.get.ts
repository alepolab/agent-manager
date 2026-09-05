import { findProject } from '../../utils/projects'

export default defineEventHandler(async (event) => {
  const nameOrPath = getQuery(event).name as string
  if (!nameOrPath) {
    throw createError({ statusCode: 400, message: 'Missing project name or path' })
  }
  try {
    return { projectName: (await findProject(nameOrPath))?.name ?? null }
  }
  catch (error: any) {
    throw createError({ statusCode: 500, message: error.message || 'Failed to resolve project' })
  }
})
