/**
 * Installs the saved risk policy (`<CLAUDE_DIR>/risk-policy.json`) at boot.
 *
 * oversightFor() is synchronous and is called from the runner's wave loop, so
 * the policy has to be in the shared slot before resumeInterrupted (a later
 * plugin, by filename order) drives a paused run to its next gate. With no
 * file saved this is a no-op and the shipped default stays in force.
 */
import { loadRiskPolicy } from '../utils/riskPolicyStore.ts'

export default defineNitroPlugin(() => {
  try {
    loadRiskPolicy()
  } catch (err) {
    console.warn('[riskPolicy] could not load risk-policy.json:', err instanceof Error ? err.message : err)
  }
})
