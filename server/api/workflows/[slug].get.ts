import { readWorkflow } from '../../utils/workflows'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')!
  const workflow = await readWorkflow(slug)
  if (!workflow) {
    throw createError({ statusCode: 404, message: 'Workflow not found' })
  }
  return workflow
})
