/**
 * The SME directory and gate routing: which PERSON a gate is handed to.
 *
 * Roles decide who MAY answer (server/utils/gateRole.ts); oversight decides
 * WHETHER anyone is asked (shared/utils/oversight.ts). Until now nothing decided
 * WHO, so every gate was "QA's" or "a developer's" and the Home list named a
 * role rather than a person. A gate nobody in particular owns is one everybody
 * waits for somebody else to take.
 *
 * Sources, in the order they are consulted:
 *   - the product registry's `owners.product_sme`, `owners.architect` and
 *     `owners.qa_lead` (engineering/registry/products.yaml), which is where the
 *     repo champion already keeps who owns what;
 *   - `roles.json`, as the operator fallback when the registry names nobody;
 *   - `<CLAUDE_DIR>/sme-delegations.json`, which redirects a person who is away;
 *   - settings `agentManager.sme.wipCap` and `.podLeads`.
 *
 * With none of that configured `routeGate` returns null and nothing changes:
 * the gate carries no assignee, the Home list reads as it did, no SLA runs.
 *
 * The risk policy (shared/utils/riskPolicy.ts, PR feat/risk-policy-audit-chain)
 * names a specialist per blast radius. It may not be on main yet, so it is
 * imported dynamically and the fallback is oversight.ts's `justify` tiers,
 * which are exactly the two the shipped policy marks as specialist-reviewed.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isWaitingOnAPerson, isTestRun, type WorkflowRun } from '../../shared/types/run.ts'
import { needsJustification } from '../../shared/utils/oversight.ts'
import { DEFAULT_SME_WIP_CAP, SME_SLA_MS, type GateKind, type ProductOwners, type SmeAssignment, type SmeDelegation } from '../../shared/types/sme.ts'
import { agentManagerSettings } from './appSettings.ts'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { loadRegistry } from './registry.ts'
import { listRoles } from './roles.ts'
import { listRuns } from './workflowRunStore.ts'
import { createLogger } from './log.ts'

const log = createLogger('sme')

export const SME_DELEGATIONS_FILE_NAME = 'sme-delegations.json'

const login = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** The people the registry names for one product; every key optional. */
export async function ownersFor(productKey: string | undefined): Promise<ProductOwners> {
  if (!productKey) return {}
  const reg = await loadRegistry().catch(() => null)
  const owners = reg?.products?.[productKey]?.owners
  if (!owners || typeof owners !== 'object') return {}
  const smes = Array.isArray(owners.product_sme) ? owners.product_sme.map((l: unknown) => login(l)).filter((l: string | undefined): l is string => !!l) : []
  return {
    ...(smes.length ? { product_sme: smes } : {}),
    ...(login(owners.architect) ? { architect: login(owners.architect) } : {}),
    ...(login(owners.qa_lead) ? { qa_lead: login(owners.qa_lead) } : {}),
  }
}

// ── Delegations ───────────────────────────────────────────────────────────────

const delegationsPath = () => resolveClaudePath(SME_DELEGATIONS_FILE_NAME)

const isDelegation = (d: unknown): d is SmeDelegation =>
  !!d && typeof d === 'object'
  && typeof (d as SmeDelegation).from === 'string' && typeof (d as SmeDelegation).to === 'string'
  && typeof (d as SmeDelegation).fromDate === 'string' && typeof (d as SmeDelegation).until === 'string'

/** Every delegation on file. A missing or corrupt file reads as none, never throws. */
export async function listDelegations(): Promise<SmeDelegation[]> {
  const path = delegationsPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    return Array.isArray(parsed) ? parsed.filter(isDelegation) : []
  } catch {
    return []
  }
}

/** Why a delegation cannot be saved, or null when it can. */
export function delegationProblem(d: Partial<SmeDelegation>): string | null {
  if (!login(d.from)) return 'from (a GitHub login) is required'
  if (!login(d.to)) return 'to (a GitHub login) is required'
  if (d.from === d.to) return 'from and to name the same person'
  const a = Date.parse(d.fromDate ?? ''), b = Date.parse(d.until ?? '')
  if (Number.isNaN(a)) return 'fromDate is not a date'
  if (Number.isNaN(b)) return 'until is not a date'
  if (b < a) return 'until is before fromDate'
  return null
}

/** Append one delegation; the whole file is rewritten. */
export async function addDelegation(d: SmeDelegation): Promise<SmeDelegation[]> {
  const problem = delegationProblem(d)
  if (problem) throw new Error(problem)
  const dir = getClaudeDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const all = [...(await listDelegations()), {
    from: d.from.trim(), to: d.to.trim(), fromDate: d.fromDate, until: d.until,
    ...(login(d.product) ? { product: d.product!.trim() } : {}),
  }]
  await writeFile(delegationsPath(), `${JSON.stringify(all, null, 2)}\n`, 'utf-8')
  return all
}

/** The end of `until`: a bare date covers its whole day. */
function untilEnd(until: string): number {
  const t = Date.parse(until)
  return /^\d{4}-\d{2}-\d{2}$/.test(until.trim()) ? t + 24 * 60 * 60 * 1000 - 1 : t
}

/**
 * Who answers for `person` on `product` at `now`: the delegate, following a
 * chain of delegations at most a few steps so a cycle cannot loop. The person
 * themselves when nothing applies.
 */
export function resolveDelegate(
  person: string, product: string | undefined, delegations: SmeDelegation[], now = Date.now(),
): { assignee: string, delegatedFrom?: string } {
  let current = person
  const seen = new Set<string>([person])
  for (let hops = 0; hops < 5; hops++) {
    const hit = delegations.find(d => d.from === current
      && (!d.product || d.product === product)
      && Date.parse(d.fromDate) <= now && now <= untilEnd(d.until))
    if (!hit || seen.has(hit.to)) break
    seen.add(hit.to)
    current = hit.to
  }
  return current === person ? { assignee: person } : { assignee: current, delegatedFrom: person }
}

// ── Load ──────────────────────────────────────────────────────────────────────

/** Open gates per assignee, across every live run but `exceptRunId`. */
export function openGatesByAssignee(runs: WorkflowRun[], exceptRunId?: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of runs) {
    if (r.id === exceptRunId || isTestRun(r) || !isWaitingOnAPerson(r.status)) continue
    const who = r.question?.assignee
    if (who) out.set(who, (out.get(who) ?? 0) + 1)
  }
  return out
}

export function wipCap(): number {
  const n = agentManagerSettings().sme?.wipCap
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SME_WIP_CAP
}

/** Who a product's overdue gates escalate to, from settings; undefined when unset. */
export function podLeadFor(productKey: string | undefined): string | undefined {
  if (!productKey) return undefined
  return login(agentManagerSettings().sme?.podLeads?.[productKey])
}

// ── Routing ───────────────────────────────────────────────────────────────────

/** What a gate is for, read from the step's role and label. */
export function gateKindOf(step: { label?: string, gateRole?: string } | undefined): GateKind {
  const label = (step?.label ?? '').toLowerCase()
  if (step?.gateRole === 'qa' || /\bqa\b|verif|test/.test(label)) return /verif/.test(label) ? 'verification' : 'qa'
  if (/plan|design|approach/.test(label)) return 'plan'
  if (/review|diff|dev done|approve|merge|pr\b/.test(label)) return 'review'
  return 'other'
}

/**
 * Whether this run's tier calls for a specialist reviewer. The risk policy
 * says so when it is installed; otherwise the owner-gated (`justify`) tiers
 * stand in, which is what the shipped policy names anyway.
 */
export async function needsSpecialist(blastRadius: string | undefined): Promise<boolean> {
  try {
    const mod = await import('../../shared/utils/riskPolicy.ts' as string).catch(() => null) as
      { getRiskPolicy?: () => any, tierFor?: (p: any, b: string | undefined) => { specialist?: string } } | null
    if (mod?.getRiskPolicy && mod.tierFor) {
      const tier = mod.tierFor(mod.getRiskPolicy(), blastRadius)
      return !!tier?.specialist && tier.specialist !== 'none'
    }
  } catch { /* the policy module is not on this instance */ }
  return needsJustification(blastRadius)
}

export interface RouteInput {
  /** Every run, for the WIP count; read from the store when not given. */
  runs?: WorkflowRun[]
  delegations?: SmeDelegation[]
  now?: number
}

/**
 * Picks the person a gate goes to, or null when nobody is configured.
 *
 *   review / plan  -> product_sme, round-robin over this run's own history, the
 *                     architect first when the tier wants a specialist;
 *   qa / verification -> qa_lead;
 *   anything else, or an empty pool -> the first operator in roles.json.
 *
 * Anyone at or over the WIP cap is passed over for the next candidate; when
 * everyone is over it the first candidate is taken anyway, since a gate with no
 * owner is the failure this exists to remove and an overloaded owner is at
 * least a named one. Delegations apply last, to whoever was picked.
 */
export async function routeGate(
  run: WorkflowRun,
  gate: { stepId: string, label?: string, gateRole?: string },
  input: RouteInput = {},
): Promise<SmeAssignment | null> {
  const now = input.now ?? Date.now()
  const product = run.product?.name
  const owners = await ownersFor(product)
  const kind = gateKindOf(gate)

  const pool: { login: string, via: SmeAssignment['via'] }[] = []
  if (kind === 'qa' || kind === 'verification') {
    if (owners.qa_lead) pool.push({ login: owners.qa_lead, via: 'qa_lead' })
  } else if (kind === 'review' || kind === 'plan') {
    if (owners.architect && await needsSpecialist(run.blastRadius)) pool.push({ login: owners.architect, via: 'specialist' })
    // Round-robin: start after the last product_sme this run was routed to.
    const smes = owners.product_sme ?? []
    const last = [...(run.smeAssignments ?? [])].reverse().find(a => a.via === 'product_sme')
    const start = last ? (smes.indexOf(last.delegatedFrom ?? last.assignee) + 1) % Math.max(1, smes.length) : 0
    for (let i = 0; i < smes.length; i++) pool.push({ login: smes[(start + i) % smes.length]!, via: 'product_sme' })
  }
  if (!pool.length) {
    const roles = await listRoles().catch(() => ({}))
    const operator = Object.entries(roles).find(([, r]) => r === 'operator')?.[0]
    if (operator) pool.push({ login: operator, via: 'operator' })
  }
  if (!pool.length) return null

  const runs = input.runs ?? await listRuns().catch(() => [] as WorkflowRun[])
  const load = openGatesByAssignee(runs, run.id)
  const cap = wipCap()
  const delegations = input.delegations ?? await listDelegations()
  const resolved = pool.map((c) => ({ ...c, ...resolveDelegate(c.login, product, delegations, now) }))
  const pick = resolved.find(c => (load.get(c.assignee) ?? 0) < cap) ?? resolved[0]!
  if (pick === resolved[0] && (load.get(pick.assignee) ?? 0) >= cap && resolved.length) {
    log.info('every candidate is at the WIP cap; routing to the first anyway', { runId: run.id, gate: gate.stepId, assignee: pick.assignee, cap })
  }
  return {
    gate: gate.stepId,
    assignee: pick.assignee,
    assignedAt: now,
    dueAt: now + SME_SLA_MS,
    via: pick.via,
    ...(pick.delegatedFrom ? { delegatedFrom: pick.delegatedFrom } : {}),
  }
}

/**
 * Routes the gate a run has just stopped on and records the result on the run:
 * an `smeAssignments` entry and `question.assignee`. Mutates `run`; the caller
 * publishes. Never throws - a routing failure must not stop a run from pausing.
 */
export async function assignOpenGate(run: WorkflowRun, step?: { label?: string, gateRole?: string }): Promise<SmeAssignment | null> {
  if (!run.question || isTestRun(run)) return null
  try {
    const a = await routeGate(run, { stepId: run.question.stepId, label: step?.label, gateRole: step?.gateRole ?? run.question.role })
    if (!a) return null
    run.smeAssignments = [...(run.smeAssignments ?? []), a]
    run.question.assignee = a.assignee
    return a
  } catch (err) {
    log.warn('gate routing failed; the gate stays unassigned', { runId: run.id, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** The assignment for the gate a run is stopped on now, if any. */
export function currentAssignment(run: Pick<WorkflowRun, 'question' | 'smeAssignments'>): SmeAssignment | undefined {
  const stepId = run.question?.stepId
  if (!stepId) return undefined
  return [...(run.smeAssignments ?? [])].reverse().find(a => a.gate === stepId)
}
