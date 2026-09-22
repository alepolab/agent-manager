import { providerRegistry } from '../../../utils/providers/registry'
import { requireCapability } from '../../../utils/session'

export default defineEventHandler(async (event) => {
  // `configure`: this route mutates the instance, and carried no authorisation check —
  // the auth middleware proves WHO the caller is, never WHAT they may do.
  await requireCapability(event, 'configure')
  const body = await readBody(event)

  const { permissionId, decision, remember, updatedInput, provider: providerName = 'claude' } = body

  if (!permissionId) {
    throw createError({
      statusCode: 400,
      message: 'Permission ID is required',
    })
  }

  if (!decision || !['allow', 'deny'].includes(decision)) {
    throw createError({
      statusCode: 400,
      message: 'Decision must be "allow" or "deny"',
    })
  }

  // Get provider
  const provider = providerRegistry.get(providerName)

  if (!provider) {
    throw createError({
      statusCode: 400,
      message: `Provider '${providerName}' not found`,
    })
  }

  // Check if provider supports permissions
  if (!provider.respondToPermission) {
    throw createError({
      statusCode: 400,
      message: `Provider '${providerName}' does not support permission handling`,
    })
  }

  try {
    await provider.respondToPermission(permissionId, decision, updatedInput)

    return {
      success: true,
      permissionId,
      decision,
      remembered: remember || false,
    }
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      message: error.message || 'Failed to respond to permission',
    })
  }
})
