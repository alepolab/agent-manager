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

  let answered: boolean | void
  try {
    answered = await provider.respondToPermission(permissionId, decision, updatedInput)
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      message: error.message || 'Failed to respond to permission',
    })
  }
  // It timed out, or someone answered it first. Saying "success" here told the
  // second person their decision had landed when it had gone nowhere.
  if (answered === false) {
    throw createError({ statusCode: 410, message: 'That prompt is no longer waiting: it was answered or it timed out.' })
  }

  return {
    success: true,
    permissionId,
    decision,
    remembered: remember || false,
  }
})
