/**
 * The runner's half of a `panel` step: what each member is given, how each is
 * run, where its verdict lands, and the one verdict the step ends with.
 *
 * Kept out of workflowRunner.ts so the step's contract can be read in one
 * place. The runner owns scheduling, the send-back and the pause; this owns
 * the members. The decisions themselves (what a member is told, what counts
 * as a verdict, how verdicts aggregate) live in shared/utils/verdictPanel.ts,
 * where the plain-node tests exercise them without a runner.
 *
 * Isolation is the contract, and it is enforced here rather than hoped for:
 * every member call goes out with no `resume` option and no `onSteer`, so no
 * caller can hand it the implementer's session; its input is built by
 * panelMemberBrief from the run's own artifacts and the registry, never from
 * `l.outputs` of any step. scripts/test-panel-step.mjs asserts both through
 * the agent-caller seam.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  aggregateVerdicts, criteriaFrom, endpointsFrom, membersForRisk, panelMemberBrief, readMemberVerdict,
  uncachedTokens, validatePanelConfig, type MemberResult, type PanelConfig, type PanelMember,
} from '../../shared/utils/verdictPanel.ts'
import type { AgentCallOptions, AgentUsage } from './agentCaller.ts'
import { runArtifactsDir } from './runArtifacts.ts'
import { stackProjectOf } from './runTeardown.ts'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '~~/shared/types/run'

const log = createLogger('runner')

/** The schema a member's verdict must satisfy, read once from the shipped file. */
let schemaCache: Record<string, any> | undefined
export async function verdictSchema(): Promise<Record<string, any>> {
  if (schemaCache) return schemaCache
  const path = join(process.cwd(), 'engineering', 'schemas', 'verdict.v0.1.schema.json')
  schemaCache = JSON.parse(await readFile(path, 'utf8'))
  return schemaCache!
}
/** Test seam: a schema other than the shipped one. */
export function setVerdictSchema(schema: Record<string, any> | undefined) { schemaCache = schema }

/**
 * The risk policy's specialist for this run, when the policy module exists on
 * this instance (another branch adds shared/utils/riskPolicy.ts). Resolved by
 * a dynamic import so this file compiles and runs without it; absent, the
 * blast radius alone decides (membersForRisk).
 */
async function policySpecialist(blastRadius: string | undefined): Promise<string | undefined> {
  try {
    // A literal that the bundler cannot resolve at build time is left to run time.
    const modulePath = '../../shared/utils/riskPolicy.ts'
    const mod = await import(/* @vite-ignore */ modulePath) as { DEFAULT_RISK_POLICY?: unknown, tierFor?: (p: unknown, b: string | undefined) => { specialist?: string } }
    if (typeof mod.tierFor !== 'function' || !mod.DEFAULT_RISK_POLICY) return undefined
    let policy: unknown = mod.DEFAULT_RISK_POLICY
    try {
      const storePath = './riskPolicyStore.ts'
      const store = await import(/* @vite-ignore */ storePath) as { loadRiskPolicy?: () => Promise<unknown> }
      if (typeof store.loadRiskPolicy === 'function') policy = (await store.loadRiskPolicy()) ?? policy
    } catch { /* no store: the shipped default */ }
    return mod.tierFor(policy, blastRadius)?.specialist
  } catch {
    return undefined
  }
}

/** The members this run's panel seats: the step's own plus what its risk adds. */
export async function resolvePanelMembers(cfg: PanelConfig, run: Pick<WorkflowRun, 'blastRadius'>): Promise<PanelMember[]> {
  return membersForRisk(cfg.members, run.blastRadius, await policySpecialist(run.blastRadius))
}

async function readArtifact(runId: string, name: string): Promise<string | null> {
  try { return await readFile(join(runArtifactsDir(runId), name), 'utf8') } catch { return null }
}

/** `base..head` for the run's branch, from what the run record knows. */
export function diffRangeFor(run: Pick<WorkflowRun, 'baseCommit' | 'baseBranch' | 'branch'>, head?: string): string {
  const base = run.baseCommit ?? (run.baseBranch ? `origin/${run.baseBranch}` : undefined)
  const tip = head ?? run.branch ?? 'HEAD'
  return base ? `${base}..${tip}` : `${tip} (no base recorded: review every commit on the run branch)`
}

export type MemberCaller = (agentSlug: string, input: string, projectDir?: string, opts?: AgentCallOptions) => Promise<string | { output: string, model?: string | null, usage?: AgentUsage | null }>

export interface PanelRunResult {
  verdict: 'pass' | 'fail'
  output: string
  findings: string
  results: MemberResult[]
  usage: AgentUsage
  /** True when the members' uncached tokens passed the step's budget. */
  overBudget: boolean
  /** The model the members ran on, when they all reported the same one. */
  model: string | null
}

/**
 * Runs every member and aggregates. Members run in sequence, not in parallel:
 * the budget is checked between them, so a panel over budget stops seating
 * reviewers rather than finishing all of them and reporting the overrun after
 * the money is spent.
 */
export async function runPanel(opts: {
  run: WorkflowRun
  stepLabel: string
  cfg: PanelConfig
  callAgent: MemberCaller
  env: Record<string, string>
  signal?: AbortSignal
  logLine: (line: string) => void
  onSession?: (agentSlug: string, sessionId: string, cwd: string) => void
}): Promise<PanelRunResult> {
  const { run, cfg } = opts
  const invalid = validatePanelConfig(cfg)
  if (invalid.length) throw new Error(`panel step "${opts.stepLabel}" is misconfigured: ${invalid.join('; ')}`)

  const artifactsDir = runArtifactsDir(run.id)
  const panelDir = join(artifactsDir, 'panel')
  await mkdir(panelDir, { recursive: true })

  const [intent, contextPacket, plan, stackReport] = await Promise.all([
    readArtifact(run.id, 'intent.md'), readArtifact(run.id, 'context-packet.json'),
    readArtifact(run.id, 'plan.md'), readArtifact(run.id, 'stack-report.md'),
  ])
  const criteria = criteriaFrom({ intent, contextPacket, plan, fallback: run.initialPrompt })
  const members = await resolvePanelMembers(cfg, run)
  const schema = await verdictSchema()
  const checkout = run.projectDir && existsSync(run.projectDir) ? run.projectDir : undefined
  const tests = { ...(run.product?.tests ?? {}), ...Object.fromEntries((run.product?.alsoInScope ?? []).flatMap(p => Object.entries(p.tests ?? {}).map(([k, v]) => [`${p.name}.${k}`, v]))) }

  const results: MemberResult[] = []
  const usages: (AgentUsage | null | undefined)[] = []
  const models = new Set<string>()
  let overBudget = false
  for (const member of members) {
    const spent = uncachedTokens(usages)
    if (spent > cfg.budgetTokens) {
      overBudget = true
      opts.logLine(`panel budget spent (${spent.toLocaleString()} of ${cfg.budgetTokens.toLocaleString()} uncached tokens) before ${member.agentSlug} could sit; the run pauses`)
      results.push({ agentSlug: member.agentSlug, ...(member.criterion ? { criterion: member.criterion } : {}), problems: ['not run: the panel budget was spent'] })
      continue
    }
    const input = panelMemberBrief({
      ticketKey: run.ticketKey, criteria, diffRange: diffRangeFor(run), checkout, tests,
      stack: { project: run.product ? stackProjectOf(run) : undefined, endpoints: endpointsFrom(stackReport) },
      artifactsDir: panelDir, member,
    })
    opts.logLine(`panel member ${member.agentSlug} starts${member.criterion ? ` on: ${member.criterion}` : ''}`)
    let output = ''
    let usage: AgentUsage | null | undefined
    try {
      // No `resume`, no `onSteer`: a fresh session every time, that nobody can
      // talk into. The options object is built here, in full, so the absence is
      // visible in one place rather than inferred from what the runner passed.
      const raw = await opts.callAgent(member.agentSlug, input, checkout, {
        signal: opts.signal, env: opts.env,
        onSession: (sessionId, cwd) => opts.onSession?.(member.agentSlug, sessionId, cwd),
        onProgress: (p) => { if (p.line) opts.logLine(`[${member.agentSlug}] ${p.line}`) },
      })
      const norm = typeof raw === 'string' ? { output: raw } : raw
      output = norm.output
      usage = norm.usage
      if (norm.model) models.add(norm.model)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const u = (err as { usage?: AgentUsage | null } | null)?.usage
      if (u) usage = u
      // Credentials and quota are the server's problem, not the member's: let
      // the runner's own handling see them, as it would for any agent step.
      if (/not logged in|invalid (x-)?api[ -]?key|authentication_error|\b429\b|rate[ -]?limit|quota/i.test(message)) throw err
      output = ''
      results.push({ agentSlug: member.agentSlug, ...(member.criterion ? { criterion: member.criterion } : {}), problems: [`the member call failed: ${message}`] })
      usages.push(usage)
      await writeFile(join(panelDir, `${member.agentSlug}.json`), JSON.stringify({ agentSlug: member.agentSlug, criterion: member.criterion, error: message, output: '', usage: usage ?? null }, null, 2))
      opts.logLine(`panel member ${member.agentSlug} failed: ${message}`)
      continue
    }
    usages.push(usage)
    const result = readMemberVerdict(member, output, schema, run.ticketKey)
    results.push(result)
    await writeFile(join(panelDir, `${member.agentSlug}.json`), JSON.stringify({
      agentSlug: member.agentSlug, criterion: member.criterion, verdict: result.verdict ?? null, problems: result.problems,
      // The member's own words, for a reviewer: the verdict object is what the
      // runner acted on, the output is what it was extracted from.
      output, usage: usage ?? null, at: new Date().toISOString(),
    }, null, 2))
    opts.logLine(`panel member ${member.agentSlug}: ${result.verdict ? result.verdict.verdict.toUpperCase() : `no usable verdict (${result.problems.join('; ')})`}`)
  }

  const outcome = aggregateVerdicts(results)
  const usage: AgentUsage = {
    input_tokens: usages.reduce((n, u) => n + (u?.input_tokens ?? 0), 0),
    output_tokens: usages.reduce((n, u) => n + (u?.output_tokens ?? 0), 0),
    cache_read_input_tokens: usages.reduce((n, u) => n + (u?.cache_read_input_tokens ?? 0), 0),
    ...(usages.some(u => typeof u?.usd === 'number') ? { usd: usages.reduce((n, u) => n + (u?.usd ?? 0), 0) } : {}),
  }
  if (uncachedTokens([usage]) > cfg.budgetTokens) overBudget = true
  await writeFile(join(panelDir, 'panel.json'), JSON.stringify({ verdict: outcome.verdict, failing: outcome.failing, members: results.map(r => ({ agentSlug: r.agentSlug, verdict: r.verdict?.verdict ?? null, problems: r.problems })), usage, overBudget, at: new Date().toISOString() }, null, 2))
  log.info('panel aggregated', { runId: run.id, verdict: outcome.verdict, failing: outcome.failing, members: results.length, overBudget })
  const output = [outcome.summary, '', ...(outcome.findings ? ['## Findings', '', outcome.findings, ''] : []), `Member verdicts: ${panelDir}/<agentSlug>.json`].join('\n')
  return { verdict: outcome.verdict, output, findings: outcome.findings, results, usage, overBudget, model: models.size === 1 ? [...models][0]! : null }
}
