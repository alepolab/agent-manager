/**
 * The saved risk policy, at `<CLAUDE_DIR>/risk-policy.json`.
 *
 * Same never-throw contract as roles.ts and watchConfig.ts: a missing file is
 * the shipped default, and a corrupt or invalid one is the shipped default
 * with a warning in the log. A policy file that locked every gate open - or
 * shut - because of a typo would be worse than no file, and the default is the
 * table the runner has always used, so an instance that never saves one
 * behaves exactly as before.
 *
 * Read lazily and cached: the policy is consulted on every gate and every
 * decision, and the file changes only through PUT /api/policy, which writes
 * through `saveRiskPolicy` and refreshes the cache itself. A second server process
 * on the same config directory would not see the write until restart; that is
 * the same non-guarantee roles.json lives with.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { createLogger } from './log.ts'
import {
  DEFAULT_RISK_POLICY, getRiskPolicy, setRiskPolicy, resetRiskPolicy, validateRiskPolicy, type RiskPolicy,
} from '../../shared/utils/riskPolicy.ts'

export const RISK_POLICY_FILE_NAME = 'risk-policy.json'

const log = createLogger('runner')
const policyPath = () => resolveClaudePath(RISK_POLICY_FILE_NAME)

/** Which file the cache was loaded from. A test that moves CLAUDE_DIR gets a fresh read. */
let loadedFrom: string | null = null

/**
 * The policy in force, loading the file on first use. Installs it into the
 * shared slot oversight.ts reads from, so the runner and the routes agree.
 *
 * Synchronous, like appSettings.ts's reader: the boot plugin must have it
 * installed before resumeInterrupted drives a paused run to its next gate, and
 * the file is a few hundred bytes read once per process.
 */
export function loadRiskPolicy(): RiskPolicy {
  const path = policyPath()
  if (loadedFrom === path) return getRiskPolicy()
  loadedFrom = path
  if (!existsSync(path)) {
    resetRiskPolicy()
    return getRiskPolicy()
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    const errors = validateRiskPolicy(parsed)
    if (errors.length) {
      log.warn('risk-policy.json is invalid; using the default policy', { path, errors })
      resetRiskPolicy()
    } else {
      setRiskPolicy(parsed as RiskPolicy)
    }
  } catch (err) {
    log.warn('risk-policy.json could not be read; using the default policy', { path, error: err instanceof Error ? err.message : String(err) })
    resetRiskPolicy()
  }
  return getRiskPolicy()
}

/** Validate, persist and install a policy. Throws with the validation errors joined when it is not one. */
export async function saveRiskPolicy(policy: unknown): Promise<RiskPolicy> {
  const errors = validateRiskPolicy(policy)
  if (errors.length) throw new Error(errors.join('; '))
  const dir = getClaudeDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(policyPath(), `${JSON.stringify(policy, null, 2)}\n`, 'utf-8')
  setRiskPolicy(policy as RiskPolicy)
  loadedFrom = policyPath()
  return getRiskPolicy()
}

/** Forget the cached read, so the next loadRiskPolicy() goes back to disk. */
export function resetRiskPolicyCache(): void {
  loadedFrom = null
  resetRiskPolicy()
}

export { DEFAULT_RISK_POLICY }
