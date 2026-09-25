/**
 * Makes sure AGENT_MANAGER_SECRET is set before anything reads it; see
 * serverSecret.ts. Named 00. so it runs ahead of the other boot plugins.
 */
import { ensureServerSecret } from '../utils/serverSecret.ts'

export default defineNitroPlugin(() => {
  try {
    const { source, file } = ensureServerSecret()
    if (source === 'generated') console.log(`[serverSecret] AGENT_MANAGER_SECRET was not set; generated one and saved it to ${file}`)
    else if (source === 'file') console.log(`[serverSecret] AGENT_MANAGER_SECRET loaded from ${file}`)
  } catch (err) {
    console.error('[serverSecret] could not load or generate AGENT_MANAGER_SECRET:', err instanceof Error ? err.message : err)
  }
})
