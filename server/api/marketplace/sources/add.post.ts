import { requireCapability } from '../../../utils/session'
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const { url } = await readBody<{ url: string }>(event)

  if (!url) {
    throw createError({ statusCode: 400, message: 'URL is required' })
  }

  const { stdout } = await runClaude(['plugin', 'marketplace', 'add', url])
  return { success: true, output: stdout || 'Marketplace added successfully' }
})
