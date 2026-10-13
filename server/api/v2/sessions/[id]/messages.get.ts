import { providerRegistry } from '../../../../utils/providers/registry'
import type { ProviderFetchOptions } from '~/types'
import { requireSessionAccess } from '../../../../utils/sessionOwners'

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, 'id')
  // Yours, your team's, or - unplaced - anyone's: see sessionOwners.ts.
  if (sessionId) await requireSessionAccess(event, sessionId)

  if (!sessionId) {
    throw createError({
      statusCode: 400,
      message: 'Session ID is required',
    })
  }

  // Get query params
  const query = getQuery(event)

  const providerName = query.provider as string || 'claude'
  const limit = parseInt(query.limit as string) || 20
  const offset = parseInt(query.offset as string) || 0
  const projectName = query.projectName as string | undefined
  const projectPath = query.projectPath as string | undefined

  // Get provider
  const provider = providerRegistry.get(providerName)

  if (!provider) {
    throw createError({
      statusCode: 400,
      message: `Provider '${providerName}' not found`,
    })
  }

  // Build fetch options
  const fetchOptions: ProviderFetchOptions = {
    limit,
    offset,
    projectName,
    projectPath,
  }

  try {
    // Fetch from provider
    const result = await provider.fetchHistory(sessionId, fetchOptions)

    return {
      messages: result.messages,
      total: result.total,
      hasMore: result.hasMore,
      tokenUsage: result.tokenUsage,
      provider: providerName,
    }
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      message: error.message || 'Failed to fetch messages',
    })
  }
})
