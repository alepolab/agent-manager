/**
 * The risk-tier policy: what each blast radius demands of a run.
 *
 * oversight.ts held one table - blast radius to `auto | stop | justify` - as a
 * module constant. That answered WHETHER a gate fires and nothing else, and an
 * operator who wanted `schema` to stop for two reviewers rather than one, or
 * `deployment` to run only in a sandbox, had no row to write it in. This widens
 * the row to everything a tier demands and makes the table a versioned value an
 * instance can save (server/utils/riskPolicyStore.ts) rather than a literal.
 *
 * Pure and dependency-free on purpose: `shared/` is imported by the Vue pages
 * and by the plain-node tests as well as by the server, so nothing here may
 * touch the filesystem or the request. DEFAULT_RISK_POLICY's `oversight`
 * column is exactly the table oversight.ts shipped with, so an instance that
 * never saves a policy behaves as it always did; the other columns are new and
 * nothing in the runner reads them yet - they are stated here so the policy
 * endpoint, the ticket-context hook and the evidence bundle all quote one
 * source rather than three.
 */
import type { BlastRadius, Oversight } from './oversight.ts'

/** Which reviewer, beyond the gate's owner, a tier calls for. `none` is the ordinary gate. */
export type Specialist = 'none' | 'protocol' | 'security' | 'money' | 'schema'

/** Whether the work must run in a disposable sandbox, should when one exists, or may run anywhere. */
export type SandboxRequirement = 'required' | 'preferred' | 'optional'

export interface RiskBudget {
  /** Wall-clock minutes a run of this tier may spend before it pauses on a person. */
  minutes: number
  /** Tokens across the run's own agent calls. */
  tokens: number
  /** Tokens the verdict panel (adversarial and specialist reviewers) may spend on top. */
  panelTokens: number
}

export interface RiskTier {
  oversight: Oversight
  /** People who must approve at a gate before the run goes on. */
  reviewers: number
  /** Whether an adversarial review (a reviewer trying to break the change) is required. */
  adversarial: boolean
  specialist: Specialist
  sandbox: SandboxRequirement
  budget: RiskBudget
}

export interface RiskPolicy {
  version: 1
  tiers: Record<BlastRadius, RiskTier>
  /** The row for a run intake has not classified, or classified as something not in the enum. */
  unclassified: RiskTier
}

export const RISK_POLICY_VERSION = 1 as const

const OVERSIGHTS: Oversight[] = ['auto', 'stop', 'justify']
const SPECIALISTS: Specialist[] = ['none', 'protocol', 'security', 'money', 'schema']
const SANDBOXES: SandboxRequirement[] = ['required', 'preferred', 'optional']
const TIERS: BlastRadius[] = ['docs', 'ui_parsing', 'schema', 'deployment', 'protocol', 'money']

const tier = (
  oversight: Oversight, reviewers: number, adversarial: boolean, specialist: Specialist,
  sandbox: SandboxRequirement, minutes: number, tokens: number, panelTokens: number,
): RiskTier => ({ oversight, reviewers, adversarial, specialist, sandbox, budget: { minutes, tokens, panelTokens } })

/**
 * The shipped policy. The `oversight` column is the table oversight.ts carried
 * before the policy existed, and scripts/test-risk-policy.mjs holds it there.
 */
export const DEFAULT_RISK_POLICY: RiskPolicy = {
  version: RISK_POLICY_VERSION,
  tiers: {
    docs: tier('auto', 1, false, 'none', 'preferred', 60, 2_000_000, 150_000),
    ui_parsing: tier('auto', 1, false, 'none', 'preferred', 60, 2_000_000, 150_000),
    schema: tier('stop', 1, true, 'schema', 'required', 120, 5_000_000, 300_000),
    deployment: tier('stop', 1, true, 'security', 'required', 120, 5_000_000, 300_000),
    protocol: tier('justify', 2, true, 'protocol', 'required', 180, 8_000_000, 600_000),
    money: tier('justify', 2, true, 'money', 'required', 180, 8_000_000, 600_000),
  },
  // Absence of evidence is not evidence of safety: an unclassified run stops,
  // and gets the cautious middle of the table for everything else.
  unclassified: tier('stop', 1, false, 'none', 'preferred', 120, 5_000_000, 300_000),
}

/** The row a blast radius maps to under `policy`. Unknown or missing radius: the `unclassified` row. */
export function tierFor(policy: RiskPolicy, blastRadius: string | undefined | null): RiskTier {
  if (!blastRadius) return policy.unclassified
  return (policy.tiers as Record<string, RiskTier | undefined>)[blastRadius] ?? policy.unclassified
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

function validateTier(t: unknown, path: string, errors: string[]): void {
  if (!isObject(t)) { errors.push(`${path} must be an object`); return }
  if (!OVERSIGHTS.includes(t.oversight as Oversight)) errors.push(`${path}.oversight must be one of ${OVERSIGHTS.join(', ')}`)
  if (!isCount(t.reviewers) || t.reviewers < 1) errors.push(`${path}.reviewers must be an integer of at least 1`)
  if (typeof t.adversarial !== 'boolean') errors.push(`${path}.adversarial must be true or false`)
  if (!SPECIALISTS.includes(t.specialist as Specialist)) errors.push(`${path}.specialist must be one of ${SPECIALISTS.join(', ')}`)
  if (!SANDBOXES.includes(t.sandbox as SandboxRequirement)) errors.push(`${path}.sandbox must be one of ${SANDBOXES.join(', ')}`)
  if (!isObject(t.budget)) { errors.push(`${path}.budget must be an object`); return }
  for (const k of ['minutes', 'tokens', 'panelTokens'] as const) {
    if (!isCount(t.budget[k]) || (t.budget[k] as number) < 1) errors.push(`${path}.budget.${k} must be a positive integer`)
  }
  for (const k of Object.keys(t.budget)) {
    if (!['minutes', 'tokens', 'panelTokens'].includes(k)) errors.push(`${path}.budget.${k} is not a recognised key`)
  }
  for (const k of Object.keys(t)) {
    if (!['oversight', 'reviewers', 'adversarial', 'specialist', 'sandbox', 'budget'].includes(k)) errors.push(`${path}.${k} is not a recognised key`)
  }
}

/**
 * Every reason `obj` is not a RiskPolicy, or an empty array when it is one.
 *
 * Strict about shape rather than lenient: a tier left out, or a key misspelt,
 * would otherwise be filled from the default silently, and an operator who
 * saved `schema: { oversite: 'auto' }` would believe schema changes flow
 * through while they still stop. Every tier in the enum must be present, and
 * nothing outside it may be.
 */
export function validateRiskPolicy(obj: unknown): string[] {
  const errors: string[] = []
  if (!isObject(obj)) return ['policy must be a JSON object']
  if (obj.version !== RISK_POLICY_VERSION) errors.push(`version must be ${RISK_POLICY_VERSION}`)
  if (!isObject(obj.tiers)) {
    errors.push('tiers must be an object keyed by blast radius')
  } else {
    for (const r of TIERS) {
      if (!(r in obj.tiers)) errors.push(`tiers.${r} is missing`)
      else validateTier(obj.tiers[r], `tiers.${r}`, errors)
    }
    for (const k of Object.keys(obj.tiers)) {
      if (!TIERS.includes(k as BlastRadius)) errors.push(`tiers.${k} is not a blast radius (expected one of ${TIERS.join(', ')})`)
    }
  }
  if (!('unclassified' in obj)) errors.push('unclassified is missing')
  else validateTier(obj.unclassified, 'unclassified', errors)
  for (const k of Object.keys(obj)) {
    if (!['version', 'tiers', 'unclassified'].includes(k)) errors.push(`${k} is not a recognised key`)
  }
  return errors
}

/** True when `obj` passes validateRiskPolicy; narrows the type. */
export function isRiskPolicy(obj: unknown): obj is RiskPolicy {
  return validateRiskPolicy(obj).length === 0
}

// ── The current policy ──────────────────────────────────────────────────────
//
// oversight.ts reads from here. The server's store (riskPolicyStore.ts) sets it
// from <CLAUDE_DIR>/risk-policy.json; the browser and the plain-node tests never
// do, so they see the default. A module-level slot rather than a parameter
// threaded through the runner, because oversightFor has a dozen call sites
// across server/ and app/ and every one of them should see the same table.

let current: RiskPolicy = DEFAULT_RISK_POLICY

/** The policy in force in this process. */
export function getRiskPolicy(): RiskPolicy {
  return current
}

/** Replace the policy in force. Refuses an invalid one rather than installing it. */
export function setRiskPolicy(policy: RiskPolicy): void {
  const errors = validateRiskPolicy(policy)
  if (errors.length) throw new Error(`invalid risk policy: ${errors.join('; ')}`)
  current = structuredClone(policy)
}

/** Back to the shipped table. Tests use this; nothing in the app does. */
export function resetRiskPolicy(): void {
  current = DEFAULT_RISK_POLICY
}
