import { workspaceRootFor, browserSurface, nestedRepos } from './workspace.ts'
import { getClaudeDir } from './claudeDir.ts'
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { computeFixFacts, type ComputedFix } from './gitFacts.ts'
import { runElapsedMinutes } from '../../shared/utils/runClock.ts'
import { resolveClaudePath } from './claudeDir.ts'
import { createLogger } from './log.ts'
import type { AgentUsage } from './agentCaller.ts'
import type { WorkflowRun, RunStep, ProductMatch } from '~~/shared/types/run'

/**
 * The literal the fix-implementer writes into `meta.json`'s `fix.repos[].pr`
 * before any pull request exists. The evidence step overwrites it with the real
 * URL; a run that never reaches that step leaves it in place.
 *
 * It lives here, once, because it did not. `ciPoller.prUrlsOf` filtered it and
 * `ticketNotifier.readReportedPrUrls` — reading the same field of the same file
 * — did not, so a budget-halted run posted "a pull request is ready for review:
 * https://example.invalid/pending" onto a real Jira ticket. Two readers of one
 * field is how one of them silently stops agreeing with the other.
 */
export const PLACEHOLDER_PR = 'https://example.invalid/pending'


const log = createLogger('artifacts')

/** Extends RunStep with the one field this file needs that the shared type
 *  doesn't declare. Kept local rather than widening shared/types/run.ts:
 *  Object.assign(rec, { usage }) in workflowRunner.ts already attaches it to
 *  the real object at runtime with no type change needed there either — this
 *  cast is just what lets THIS file read it back safely. */
type StepWithUsage = RunStep & { usage?: AgentUsage | null }

/**
 * Where a run's evidence lives. Deliberately OUTSIDE CLAUDE_DIR: a real
 * callAgent() call, checked with existsSync (never the agent's own account),
 * has been observed blocked writing under `~/.claude/workflow-runs/**` in
 * three separate measurements — a live DEVOPS-23 run that halted at step
 * one, and two follow-up probes across different working directories — and
 * has NOT been reproduced in one other session, including a probe against
 * this exact `~/.claude/workflow-runs/**` path that succeeded there. The
 * mechanism (a Write-tool guard over `~/.claude/**` as sensitive config,
 * presumably) is not isolated — nobody has pinned down what varies between
 * the sessions that saw it and the one that didn't. Treat the block as real
 * and plan around it (that is what this file does), but don't repeat it
 * downstream as settled fact beyond "observed blocked most of the time,
 * mechanism unconfirmed." Default root is `~/.agent-manager/workflow-runs`; AGENT_RUNS_DIR
 * overrides it (tests and deployments both use this). The run *record* JSON
 * (workflowRunStore.ts) is unaffected and deliberately stays under
 * CLAUDE_DIR — that's the server's own state, written with `fs` by the
 * server process, never through the agent's Write tool, so it was never
 * blocked in the first place.
 *
 * The `<id>/artifacts` shape is unchanged, on purpose: assemble-bundle.mjs
 * takes `--run-dir` and doesn't care what's above it, and
 * engineering/hooks/plan-gate.mjs's exemption regex
 * (`/[\\/]workflow-runs[\\/][^\\/]+[\\/]artifacts[\\/]/`) matches that shape
 * anywhere in the path, not anchored to CLAUDE_DIR — moving the root changes
 * nothing for either of them.
 */
export function agentRunsRoot(): string {
  return process.env.AGENT_RUNS_DIR || join(homedir(), '.agent-manager', 'workflow-runs')
}

/** Where a run's evidence lives. The assembler's --run-dir points here. */
export function runArtifactsDir(runId: string): string {
  return join(agentRunsRoot(), runId, 'artifacts')
}

/** Filenames come from agent slugs, which are user data. Keep them inert.
 *  Invalid characters (including path separators) become '-'; any run of 2+
 *  dots left behind — e.g. from "../.." once the slashes are gone — is
 *  collapsed too, so a traversal sequence can never survive reassembly. */
const safe = (s: string) =>
  s.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/\.{2,}/g, '-').replace(/^\.+/, '').slice(0, 60) || 'step'

/**
 * The model(s) the run's own steps actually used, not an asserted constant.
 * A step that hasn't reported one yet (not run, a stub caller, or a call
 * that threw before returning) contributes nothing rather than a guess. If
 * every step that DID report agrees, that's the value; if they differ, the
 * distinct values join with '+' — the bundle schema types `model` as a
 * free-form string, so a joined value is valid, and honest where a single
 * arbitrary pick would not be.
 *
 * Returns `undefined` — never a fallback default — when NOT ONE step has
 * reported a model yet: before any step has run (initRunArtifacts's seed),
 * or when every step that ran either used a stub caller that never returned
 * one (tests) or threw before returning (executeNode's catch branch records
 * no model). A fallback here used to invent DEFAULT_MODEL_ALIAS in exactly
 * that case — a run whose every step threw would still write `model:
 * "sonnet"` as if it were fact. `runnerOwned`'s callers rely on
 * JSON.stringify dropping an `undefined`-valued key: the field is genuinely
 * absent from meta.json, the same way an uncomputable `fix.*` key is,
 * rather than defaulted.
 */
function modelsUsed(run: WorkflowRun): string | undefined {
  const reported = [...new Set(run.steps.map(s => s.model).filter((m): m is string => Boolean(m)))]
  return reported.length ? reported.join('+') : undefined
}

/**
 * Sums real usage across every step that reported one. A step contributes
 * nothing — not a guess, not an interpolation — when it never ran, ran
 * through a stub agent caller (tests), or the real caller's result message
 * carried no usable usage object (see AgentUsage's doc comment in
 * agentCaller.ts for what "usable" means and how cache tokens are folded
 * in). If not one step reported usage, the total is legitimately 0 — the
 * same honest floor the hardcoded value used to assert unconditionally.
 */
function tokenTotals(run: WorkflowRun): { input_tokens: number, output_tokens: number } {
  let input_tokens = 0
  let output_tokens = 0
  for (const s of run.steps) {
    const usage = (s as StepWithUsage).usage
    if (!usage) continue
    input_tokens += usage.input_tokens
    output_tokens += usage.output_tokens
  }
  return { input_tokens, output_tokens }
}

/**
 * Recursively finds every `plugin.json` under `dir` whose full path both
 * contains `pluginName` and ends in `.claude-plugin/plugin.json`. Walked by
 * hand with `readdirSync` rather than a glob library on purpose: `**` glob
 * patterns do not descend into a dot-directory, and `.claude-plugin` is
 * exactly that — the reason the sdlc-ticket-intake agent's own Glob-based
 * search for this file (app/utils/templates.ts's prompt) can never find it
 * no matter how the pattern is written, even before accounting for that
 * agent's cwd being the target repo, not `~/.claude`. `maxDepth` bounds the
 * walk against a pathological tree or a symlink cycle; the real installed
 * layout (`plugins/cache/<name>/<name>/<version>/.claude-plugin/plugin.json`)
 * is 5 levels deep, so 8 leaves real headroom without being unbounded.
 */
function findPluginManifests(dir: string, pluginName: string, depth = 0, maxDepth = 8): string[] {
  if (depth > maxDepth) return []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // unreadable directory: nothing found here, not a crash
  }
  const found: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...findPluginManifests(full, pluginName, depth + 1, maxDepth))
    } else if (
      entry.isFile() && entry.name === 'plugin.json'
      && full.includes(pluginName) && full.endsWith(join('.claude-plugin', 'plugin.json'))
    ) {
      found.push(full)
    }
  }
  return found
}

/** Numeric, dot-segment comparison — good enough to pick the higher of two
 *  real semver strings (the shape plugin.json actually carries) without
 *  pulling in a semver library for one comparison. Never used to validate
 *  that a string IS a semver — that is the bundle schema's job downstream. */
function higherVersion(a: string, b: string): string {
  const partsOf = (v: string) => v.split('.').map(p => Number.parseInt(p, 10) || 0)
  const [pa, pb] = [partsOf(a), partsOf(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0 ? a : b
  }
  return a
}

/**
 * The installed plugin's version, read directly from its own `plugin.json`
 * by the server process — a runner-owned fact, never the intake agent's
 * self-report (see findPluginManifests's doc comment for exactly why that
 * agent structurally cannot find this file itself: three consecutive real
 * runs halted at step one on this, and two earlier "fixes" to the agent's
 * search pattern were both wrong for the same reason — the search was never
 * the problem). Returns `undefined` — never a placeholder like "unknown" —
 * when `~/.claude/plugins` doesn't exist, no manifest under it names the
 * plugin, or every manifest found fails to parse to an object with a string
 * `version`. When more than one matching manifest exists (multiple cached
 * versions of the same plugin), the highest version wins rather than an
 * arbitrary first-found pick.
 */
export function resolveInstalledPluginVersion(pluginName = 'alepo-engineering'): string | undefined {
  const root = resolveClaudePath('plugins')
  if (!existsSync(root)) return undefined
  let best: string | undefined
  for (const path of findPluginManifests(root, pluginName)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed && typeof parsed === 'object' && typeof parsed.version === 'string' && parsed.version) {
        best = best ? higherVersion(best, parsed.version) : parsed.version
      }
    } catch {
      /* an unparsable manifest asserts nothing */
    }
  }
  log.debug('plugin version resolved', { pluginName, found: Boolean(best), version: best ?? '(none)' })
  return best
}

/** Keys the RUNNER owns. An agent may write them; finalize overwrites them.
 *  Split out so there is exactly one list, used by both seed and finalize. */
function runnerOwned(run: WorkflowRun) {
  return {
    identity: run.startedBy ?? run.workflowSlug,
    // The runner's own fact for what dispatched this run — set once at
    // startRun and carried on the run record ever since (never inferred
    // from, or trusted from, an agent's self-report), same as identity.
    watch: run.watch,
    model: modelsUsed(run),
    // Same class of fact as identity/watch/model: something the runner can
    // verify directly and an agent must not be trusted to self-report. See
    // resolveInstalledPluginVersion's doc comment for why the agent could
    // never compute this correctly itself.
    plugin_version: resolveInstalledPluginVersion(),
    // What the run said it left undone, and what the runner could not reach.
    // Both are runner-owned for the same reason identity and cost are: an
    // agent's prose is where they used to live, and prose is not a record.
    ...(run.notDone?.length ? { not_done: run.notDone } : {}),
    ...(run.shipIntegrity ? { ship_integrity: run.shipIntegrity } : {}),
    cost: {
      ...tokenTotals(run),
      attempts: Math.max(1, ...run.steps.map(s => s.visits ?? 1)),
      // The run clock's execution time, matching costReport.ts exactly - see
      // shared/utils/runClock.ts for why it is not `endedAt - startedAt`.
      wall_clock_min: Math.round(runElapsedMinutes(run)),
    },
  }
}

/**
 * Re-asserts `fix.repos` / `files_changed` / `lines_changed` from git over
 * whatever an agent merged into meta.json — the same "the runner's facts
 * win" rule `runnerOwned` already applies to identity/model/cost. Every
 * other `fix.*` key an agent owns (`test_dirs_unlocked`, `unlock_reason`,
 * and a matching repo entry's `pr`, which no git command can produce)
 * survives untouched.
 *
 * `computeFixFacts` can only prove ONE repo — the one at `run.projectDir`,
 * measured against `run.baseCommit` (the sha captured at this run's own
 * start, never a branch's shared base — see gitFacts.ts's doc comments for
 * why diffing against `main` was itself a fabrication bug). A multi-repo
 * fix's OTHER repos are outside anything git can check from here, so — the
 * same trust boundary already applied to `pr` — they survive as the agent's
 * self-report rather than being dropped (fabrication by omission of a real
 * repo) or fabricated (inventing commits for a repo this function never
 * looked at). Only the ONE entry the runner can verify is ever overwritten;
 * every other entry passes through byte-for-byte.
 *
 * `merge_order` is kept only when it is still coherent with the resulting
 * `repos`: more than one repo present, and every name it lists among them.
 * Letting it survive unchecked — e.g. after a single-repo collapse, or
 * naming a repo the agent's own report never listed — would leave the
 * bundle internally incoherent while still validating, since the schema's
 * multi-repo rule only fires at `repos.length > 1`.
 *
 * When `computeFixFacts` returns null — not a git repo, no baseline was
 * recorded, no commits since the baseline, see that function's doc comment
 * for the full list — the three computed keys are REMOVED, not left as
 * whatever the agent claimed. Passing the agent's self-report through in
 * that case would be exactly the fabrication this whole change exists to
 * close off; the honest outcome is an absent field the bundle validator
 * then rejects. This includes the run that made no commits at all: a `fix`
 * block reporting zero-valued numbers would still assert "this run touched
 * the repo", which is exactly as misleading as inventing thirty-three
 * commits a run never made — so a no-commit run gets no computed fix keys
 * either, same as any other "cannot compute" outcome. If the agent wrote no
 * `fix` at all in that case, the whole block stays absent (see the fallback
 * below) rather than a block reduced to placeholder zeros.
 */
async function reconcileFix(
  existing: Record<string, unknown>,
  run: WorkflowRun,
): Promise<Record<string, unknown> | undefined> {
  const existingFix = (existing.fix && typeof existing.fix === 'object' && !Array.isArray(existing.fix))
    ? existing.fix as Record<string, unknown>
    : undefined
  const { repos: _repos, files_changed: _fc, lines_changed: _lc, merge_order: _mo, ...restFix } = existingFix ?? {}

  const computed = await computeFixFacts(run.projectDir, run.baseCommit).catch(() => null)
  // Every OTHER checkout under the run's own — the module repos of a multi-repo
  // product — measured the same way and by the same rule: git or nothing.
  //
  // Without this, `files_changed` was the projectDir's alone while `repos`
  // listed three. CSUP-7509's meta reported one file and 244 lines, and that
  // one file was `.agent/plan.md`: the real change lived in two repositories
  // nothing measured. Three other runs are the same shape.
  const nested: ComputedFix[] = []
  for (const dir of run.projectDir ? nestedRepos(run.projectDir) : []) {
    const one = await computeFixFacts(dir, run.baseCommit).catch(() => null)
    if (one && one.repo !== computed?.repo) nested.push(one)
  }

  if (computed) {
    log.debug('fix facts computed from git', {
      runId: run.id, repo: computed.repo, commits: computed.commits,
      files_changed: computed.files_changed, lines_changed: computed.lines_changed,
    })
    const priorRepos = Array.isArray(existingFix?.repos) ? existingFix!.repos as Array<Record<string, unknown>> : []
    const priorEntry = priorRepos.find(r => r && r.repo === computed.repo)
    const repoEntry: Record<string, unknown> = { repo: computed.repo, commits: computed.commits }
    // `pr` is not something git can prove; carry it forward only when the
    // agent's self-report names the SAME repo git computed.
    if (priorEntry && typeof priorEntry.pr === 'string') repoEntry.pr = priorEntry.pr

    // Every OTHER repo the agent reported (not the one git just computed)
    // is outside what this run's projectDir can verify — kept as-is rather
    // than discarded, the same way a matching entry's `pr` already is.
    // A nested repo git COULD measure replaces the agent's entry for it; one it
    // could not is still the agent's self-report, unchanged.
    const measuredNames = new Set(nested.map(n => n.repo))
    const otherRepos = priorRepos.filter(r => !(r && (r.repo === computed.repo || measuredNames.has(r.repo as string))))
    const nestedEntries = nested.map((n) => {
      const prior = priorRepos.find(r => r && r.repo === n.repo)
      const entry: Record<string, unknown> = { repo: n.repo, commits: n.commits }
      if (prior && typeof prior.pr === 'string') entry.pr = prior.pr
      return entry
    })
    const repos = [...otherRepos, repoEntry, ...nestedEntries]

    const repoNames = new Set(repos.map(r => r.repo))
    const priorMergeOrder = Array.isArray(existingFix?.merge_order)
      ? existingFix!.merge_order as unknown[]
      : undefined
    const mergeOrderCoherent = repos.length > 1
      && priorMergeOrder !== undefined
      && priorMergeOrder.every(name => typeof name === 'string' && repoNames.has(name))
    if (priorMergeOrder !== undefined && !mergeOrderCoherent) {
      log.warn('merge_order dropped: incoherent with the repos git actually computed', {
        runId: run.id, priorMergeOrder, repoNames: [...repoNames],
      })
    }

    return {
      ...restFix,
      ...(mergeOrderCoherent ? { merge_order: priorMergeOrder } : {}),
      repos,
      // Summed across every repository the runner measured, so the number a
      // reviewer sizes the change by is the whole change.
      files_changed: computed.files_changed + nested.reduce((n, x) => n + x.files_changed, 0),
      lines_changed: computed.lines_changed + nested.reduce((n, x) => n + x.lines_changed, 0),
    }
  }

  // Nothing computable. If the agent wrote nothing at all either, leave
  // `fix` entirely absent rather than fabricating an empty object. When it
  // did report repos, keep only what git could never have proved anyway and
  // nothing here contradicts: the repo name and the PR link. Commit lists
  // and line counts are dropped, exactly as a computed entry would replace
  // them, because a self-reported count is a claim wearing a fact's shape;
  // an entry with no PR link is dropped whole, since a bare repo name is
  // exactly the fabrication a run that made no commits must not attest to.
  // A run started without a project directory used to lose its PR URL here,
  // which left the CI poller with nothing to check.
  if (existingFix === undefined) {
    log.debug('no fix facts computable and none reported; fix block stays absent', { runId: run.id })
    return undefined
  }
  log.warn('fix facts not computable from git; commits/files_changed/lines_changed dropped from meta, repo names and PR links kept', {
    runId: run.id,
  })
  const priorRepos = Array.isArray(existingFix.repos) ? existingFix.repos as Array<Record<string, unknown>> : []
  const kept = priorRepos
    .filter(r => r && typeof r.repo === 'string' && typeof r.pr === 'string' && r.pr.startsWith('http'))
    .map(r => ({ repo: r.repo, pr: r.pr }))
  return kept.length ? { ...restFix, repos: kept } : restFix
}

export async function initRunArtifacts(run: WorkflowRun, workflowName: string): Promise<void> {
  const dir = runArtifactsDir(run.id)
  await mkdir(join(dir, 'steps'), { recursive: true })
  await writeFile(join(dir, 'meta.json'),
    JSON.stringify({ ...runnerOwned(run), workflow: workflowName }, null, 2))
  log.debug('run artifacts initialized', { runId: run.id, dir })
}

/**
 * `suffix` distinguishes a RETRY attempt's own snapshot from the step's
 * final artifact — both share the same `index`/`agentSlug`, so writing them
 * to the same filename would let the eventual completed (or failed) write
 * silently overwrite the retried attempt, losing exactly the deficient
 * output and the monitor's note a reviewer most needs to see. Omitted for
 * the step's real, final artifact (unchanged filename, so every existing
 * caller and the assembler's contract are untouched).
 */
export async function writeStepArtifact(
  run: WorkflowRun, rec: RunStep, index: number, suffix?: string,
): Promise<void> {
  const dir = join(runArtifactsDir(run.id), 'steps')
  await mkdir(dir, { recursive: true })
  const n = String(index + 1).padStart(2, '0')
  const name = `step-${n}-${safe(rec.agentSlug.replace(/^sdlc-/, ''))}${suffix ? `-${safe(suffix)}` : ''}.json`
  await writeFile(join(dir, name), JSON.stringify({
    stepId: rec.stepId,
    agentSlug: rec.agentSlug,
    label: rec.label,
    status: rec.status,
    error: rec.error ?? null,
    monitorVerdict: rec.monitorVerdict ?? null,
    monitorNote: rec.monitorNote ?? null,
    startedAt: rec.startedAt ?? null,
    completedAt: rec.completedAt ?? null,
    input: rec.input ?? '',
    output: rec.output ?? '',
    model: rec.model ?? null,
    usage: (rec as StepWithUsage).usage ?? null,
  }, null, 2))
  log.debug('step artifact written', {
    runId: run.id, name, status: rec.status,
    inputLength: (rec.input ?? '').length, outputLength: (rec.output ?? '').length,
  })
}

/**
 * Re-assert the runner's facts over whatever the agents merged in, and
 * survive a meta.json an agent corrupted: the runner's own record is the
 * floor this whole design rests on, so it must not be lost to a bad write.
 */
/**
 * The filenames the evidence bundle is assembled from.
 *
 * `engineering/scripts/assemble-bundle.mjs` reads exactly these and is
 * deliberately built never to invent a field, so a run that wrote
 * `implementation-plan.md` instead of `plan.md` produces a bundle missing
 * `plan_sha` - and that surfaces much later, in CI, as a validation failure
 * about a field nobody remembers choosing. The artifact header tells agents
 * WHERE to write but never names these files, which makes the mistake easy to
 * make and impossible to notice.
 *
 * Kept in step with the assembler by name. If a file is added there and not
 * here, the only cost is that its absence goes unreported - never a false
 * alarm - which is the safe direction for a check that nobody asked for.
 */
const BUNDLE_CONTRACT_FILES = [
  'context-packet.json',
  'intent.md',
  'plan.md',
  'summary.md',
  'oracle-before.xml',
  'oracle-after.xml',
  'regression.xml',
] as const

/**
 * Which contract files this run never wrote.
 *
 * Returns `[]` rather than nothing when all are present: "checked, nothing
 * missing" has to be distinguishable from "never checked", or a reader cannot
 * tell a complete run from one that predates this check.
 */
async function missingContractFiles(dir: string): Promise<string[]> {
  let present: Set<string>
  try {
    present = new Set(await readdir(dir))
  } catch {
    // The directory itself is unreadable, which finalize already reports
    // elsewhere; claiming every file is missing would be a second, louder
    // complaint about the same fault.
    return []
  }
  return BUNDLE_CONTRACT_FILES.filter(f => !present.has(f))
}

/** Blast radii the bundle schema demands an adversarial report for. */
const ADVERSARIAL_REQUIRED_FOR = new Set(['money', 'protocol'])

/**
 * Whether this run owes an adversarial report it has not produced.
 *
 * The schema has always required one for money and protocol changes
 * (evidence-bundle.v0.1.schema.json), and the conditional could never fire
 * while `blast_radius` was empty. Classification populates it now, so the first
 * real money-path run would otherwise meet that requirement as a CI validation
 * failure about a field nobody had been asked for.
 *
 * Reported, NEVER written. The schema asks for a two-node rerun, an adversarial
 * pattern search and a mutation score - verification work an agent performs -
 * and a runner inventing a plausible object would be manufacturing evidence,
 * which is worse than the failed validation it would hide.
 *
 * Silent for every other class. A false demand is not harmless: it teaches an
 * agent to ignore the real ones.
 */
function owesAdversarialReport(run: WorkflowRun, meta: Record<string, unknown>): boolean {
  const cls = run.blastRadius ?? (typeof meta.blast_radius === 'string' ? meta.blast_radius : undefined)
  if (!cls || !ADVERSARIAL_REQUIRED_FOR.has(cls)) return false
  const report = meta.adversarial
  return !report || typeof report !== 'object' || Array.isArray(report)
}

export async function finalizeRunArtifacts(run: WorkflowRun): Promise<void> {
  const dir = runArtifactsDir(run.id)
  const path = join(dir, 'meta.json')
  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
  } catch {
    /* absent or unparseable: rebuild from runner facts alone */
  }
  await mkdir(dir, { recursive: true })

  const fix = await reconcileFix(existing, run)
  const merged: Record<string, unknown> = { ...existing, ...runnerOwned(run) }
  if (fix === undefined) delete merged.fix
  else merged.fix = fix

  // Runner-owned, like identity and cost: it is a fact about the directory the
  // runner can see for itself, and finalize is the last moment anyone looks.
  const contractMissing = await missingContractFiles(dir)
  // `adversarial` is a meta key rather than a file, but it is the same class of
  // gap - something the bundle requires and this run did not produce - so it is
  // reported in the same place a reader already looks.
  if (owesAdversarialReport(run, merged)) contractMissing.push('adversarial')
  merged.contract_missing = contractMissing

  await writeFile(path, JSON.stringify(merged, null, 2))
  // The one file in here a person reads. Written last, from the reconciled
  // meta.json above, and never allowed to take the run down with it: a summary
  // is a convenience, the evidence is the record.
  try {
    const { writeRunSummary } = await import('./runSummary.ts')
    await writeRunSummary(run)
  } catch (e) {
    log.warn('run summary not written', { runId: run.id, error: String(e) })
  }
  // One row per run, so "which run touched this repo?" is a query rather than
  // thirteen files opened by hand. Same best-effort rule as the summary: an
  // index is a convenience, the artifacts are the record.
  try {
    const { updateRunIndex } = await import('./runIndex.ts')
    await updateRunIndex(run, merged)
  } catch (e) {
    log.warn('run index not updated', { runId: run.id, error: String(e) })
  }
  if (contractMissing.length) {
    log.warn('run is missing evidence-bundle contract files', { runId: run.id, missing: contractMissing })
  }
  log.debug('meta.json reconciled with runner-owned facts', { runId: run.id, hasFix: fix !== undefined })
}

/**
 * Best-effort last resort for when `finalizeRunArtifacts` itself fails (a
 * bug in reconciliation, a filesystem error) — called from
 * workflowRunner.ts's `publish()`, which used to swallow that failure
 * silently. At that point meta.json still holds whatever the LAST
 * successful write left there: `initRunArtifacts`'s seed, plus anything an
 * agent merged in directly during the run — which can include the agent's
 * raw, unreconciled `fix.repos` / `commits` / `files_changed` /
 * `lines_changed` self-report. Left in place, that looks like ordinary,
 * trustworthy meta.json to engineering/scripts/assemble-bundle.mjs, which
 * has no way to know reconciliation never ran. Removing meta.json makes the
 * absence explicit: the assembler's `readJsonIfExists` returns `undefined`,
 * every meta-derived required key is then missing, and the bundle is
 * rejected loudly instead of assembled from unreconciled, possibly
 * fabricated data.
 */
/**
 * Record the pull requests the runner opened into `meta.fix.repos[].pr`.
 *
 * That key is what the run page renders and what the ticket comment reads, and
 * until now nothing wrote it: a run's PR URL only ever existed in an agent's
 * prose, if at all. Written here rather than by `reconcileFix` because a PR is
 * not a git fact about a diff \u2014 it is a fact about an action the runner took.
 *
 * Merges by repository name so it survives a restart that re-runs the ship
 * step, and appends a row for a repository `computeFixFacts` never saw \u2014 which
 * is the multi-repo case: fix facts measure `run.projectDir` alone, while a run
 * can commit to a nested module repository as well.
 */
export async function recordPrUrls(runId: string, prs: { repo: string, url: string }[]): Promise<void> {
  if (!prs.length) return
  const path = join(runArtifactsDir(runId), 'meta.json')
  try {
    const meta = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
    const fix = (meta.fix && typeof meta.fix === 'object' && !Array.isArray(meta.fix))
      ? meta.fix as Record<string, unknown>
      : {}
    const repos = Array.isArray(fix.repos) ? [...fix.repos as Array<Record<string, unknown>>] : []
    for (const { repo, url } of prs) {
      if (url === PLACEHOLDER_PR) continue // the placeholder is not a pull request
      const row = repos.find(r => r && typeof r === 'object' && r.repo === repo)
      if (row) row.pr = url
      else repos.push({ repo, pr: url })
    }
    await writeFile(path, `${JSON.stringify({ ...meta, fix: { ...fix, repos } }, null, 2)}\n`)
    log.info('pull request urls recorded in meta', { runId, count: prs.length })
  } catch (err) {
    // A meta.json that cannot be read is already reported by finalize; losing
    // the URL here must not fail the step that just opened a real PR.
    log.warn('could not record pull request urls', { runId, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * The run's own classification, written into meta.json by the RUNNER.
 *
 * meta.json has always had a place for `blast_radius`; the field was left to
 * whichever agent felt like filling it, so it stayed empty on every run and
 * oversight.ts read every run as unclassified. This is the writer, and it is
 * runner-owned for the same reason `identity` and `watch` are: a value the
 * classified party can set is not a control.
 *
 * Merge-writes like recordPrUrls, and a meta.json that cannot be read is logged
 * rather than thrown: losing the class must not fail the step that just earned
 * it, and finalize already reports an unreadable meta.
 */
export async function recordClassification(
  runId: string,
  cls: { blast_radius?: string, class_source?: string, work_type?: string, origin?: string },
): Promise<void> {
  const path = join(runArtifactsDir(runId), 'meta.json')
  try {
    const meta = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
    const next = { ...meta }
    for (const [k, v] of Object.entries(cls)) if (v !== undefined) next[k] = v
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`)
    log.info('classification recorded in meta', { runId, ...cls })
  } catch (err) {
    log.warn('could not record the classification', { runId, error: err instanceof Error ? err.message : String(err) })
  }
}

export async function markArtifactsUnusable(runId: string): Promise<void> {
  await rm(join(runArtifactsDir(runId), 'meta.json'), { force: true })
  log.error('meta.json removed after a finalize failure; the assembler will see this run as absent', { runId })
}

/**
 * Evidence lives in the run directory and is served by the app
 * (`GET /api/runs/:id/artifacts`). It is deliberately NOT copied into the
 * repository being fixed.
 *
 * `publishEvidenceToProject` used to copy the run directory to
 * `<projectDir>/.agent/evidence-run/` so it could travel with the pull request,
 * and the evidence agent was told to `git add` it. That put a run's whole
 * bundle — logs, step outputs, oracle XML — into someone else's product repo,
 * as commits a reviewer has to read past to see the fix. The evidence is for
 * judging the change, not part of it.
 *
 * The CI workflow that read `.agent/evidence-run/` from a pull request's
 * checkout has been retired with it: once nothing wrote that directory, the
 * check could only ever report "no evidence", which is a check that looks like
 * enforcement and is not. The bundle itself is unaffected - it is still
 * assembled into the run directory and served by the app.
 */

/** Prepended to every step's input. The only channel an agent has for
 *  learning where to write, so it must be unmissable and literal. */
export function artifactHeader(dir: string, product?: ProductMatch, startedBy?: string, runId?: string, checkout?: { dir: string, branch?: string, /** Where the branch came from and where the PR goes, from server/utils/branchPolicy.ts. */ policy?: string }): string {
  // The app serves this directory, so an agent can point a reviewer at it
  // instead of copying files into a product repository to make them reachable.
  const appUrl = (process.env.AGENT_MANAGER_URL || 'http://localhost:3030').replace(/\/+$/, '')
  const lines = [
    '## Run artifacts directory',
    '',
    `Write every artifact you produce into: ${dir}`,
    '',
    ...(runId
      ? [
          `These files are served by Agent Manager at ${appUrl}/api/runs/${runId}/artifacts`,
          `and shown on the run page at ${appUrl}/runs/${runId}. Link that in a pull`,
          'request body; never copy artifacts into the repository to make them reachable.',
          '',
        ]
      : []),
    `Claude config directory: ${getClaudeDir()}`,
    '',
    // Unconditional, because it used to live inside the product block below and
    // a run that resolved no product told its agents nothing about where to
    // work. They improvised, and improvised differently: one cloned to
    // ~/alepo-workspace, another to ~/repos, neither to the configured root.
    // git facts are computed against the run's workspace, so `meta.json` lost
    // commits, files_changed and lines_changed for work that had actually been
    // done and committed — in a directory nothing else knew about.
    `Work in: ${workspaceRootFor(startedBy)}`,
    `Clone each repository into its own directory there, ${workspaceRootFor(startedBy)}/<repo name>, and work inside it.`,
    'Never clone into the workspace directory itself. Do not invent a checkout path and',
    'do not search the filesystem for one — anything you leave elsewhere is',
    'invisible to every later step and to the evidence bundle.',
    '',
    // Stated as a fact, so the browser-trace step has something to quote rather
    // than a conclusion to reach and then remember to announce. It produced no
    // trace and no explanation twice, and the monitor called it exactly that:
    // "silence without explanation".
    `Browser surface: ${browserSurface(workspaceRootFor(startedBy)).summary}`,
    ...(checkout ? [`Working checkout: ${checkout.dir}${checkout.branch ? ` on branch ${checkout.branch}` : ''}. This directory is a git worktree the runner made for this run, beside the clone and sharing its repository and remote, with the same done for every module repository nested under it: work here and only here, and leave the clone itself alone. Commit in the repository that owns the file you changed and only there; never switch branches, reset, rebase or push. The PR step pushes that branch and opens the pull request on that repository against the branch policy.${checkout.policy ? ` ${checkout.policy}` : ''}`] : []),
    '',
    // "It is not there" halted a whole run and was wrong. The provisioner
    // reported the ticket's target file "not present in any checked-out repo"
    // while that exact file sat in its own workspace, and every step after it
    // was skipped on the strength of that sentence. An absence is a
    // measurement like any other: it takes a command and an empty result. The
    // step already has to show a directory listing before its own claims are
    // believed; this is the same rule pointed at the opposite conclusion.
    'Before reporting that a file, module, table or endpoint does not exist,',
    'run the command that looks for it and paste the empty result. Search the',
    'whole workspace, not the directory you expected it in — a module may be a',
    'separate repository that has to be cloned, and the product block above',
    'names those. An absence asserted without a command behind it is sent back,',
    'and an absence that halts a run and turns out to be wrong costs the run.',
    '',
    'This directory is the run\'s evidence. A file you do not write is evidence',
    'that does not exist — do not describe an artifact in prose instead of',
    'writing it, and never write a placeholder in place of a real result.',
    'End your output with a listing of this directory, so the step monitor — which',
    'sees only your output — can check each file you claim is really there: the',
    'verbatim `ls -la` if you have a shell, otherwise the file names your own tools',
    'return (Glob `*` in it). A file the listing does not show does not exist.',
  ]
  if (product) {
    lines.push(
      '',
      '## Product (from the registry)',
      '',
      `Product: ${product.name}${product.suite ? ` (suite: ${product.suite})` : ''}`,
      `Repos: ${product.repos.join(', ')}`,
      // HTTPS, not git@github.com. The container has no SSH key, but it does have
      // a credential helper wired to $GITHUB_TOKEN (see the Dockerfile), which
      // envForUser fills from the starter's own sealed token. An SSH clone URL
      // bypasses all of that and fails with a key error the agent cannot fix,
      // which is how a provisioner step reported the repo 'is not checked out
      // anywhere on this host' after being told to clone it.
      `Checkouts: ${workspaceRootFor(startedBy)}/<repo name>; confirm each with git remote -v, and clone https://github.com/<repo>.git there if it is missing.`,
      // A container repo needs its modules named, or the agent guesses. One did:
      // it cloned the parent, found modules/ nearly empty, and reported the
      // ticket's file "not present in any checked-out repo" while holding it.
      ...(product.modules
        ? [`Modules: this product's parent repo is a container — it git-ignores modules/, so cloning it alone gives you almost nothing. Clone ONLY the ones this ticket touches, into ${workspaceRootFor(startedBy)}/<parent repo>/modules/<dir>. Directory and repo name differ and the difference is not a rule, so read this map: ${Object.entries(product.modules).map(([dir, repo]) => `${dir}=${repo}`).join(', ')}.`]
        : []),
      ...(product.multiRepo ? ['Multi-repo: yes. Every repo listed gets its own branch, commit and PR; plan.md must give a merge order and nothing merges until every PR in the set is approved.'] : []),
      `Branch policy: ${Object.entries(product.branches).map(([k, v]) => `${k}: ${v}`).join('; ')}`,
      `Stack: ${product.stack?.compose ?? 'not registered'} (${product.stack?.topology_default ?? '-'})`,
      `Tests: ${Object.entries(product.tests).map(([k, v]) => `${k}: ${v}`).join('; ') || 'not registered'}`,
      ...(product.recipe ? [`Recipe: ${product.recipe}`] : []),
      ...(product.alsoInScope ?? []).flatMap(p => [
        '',
        `Also in scope (a step widened the run to it): ${p.name}`,
        `  Repos: ${p.repos.join(', ')} — checked out beside the others, on the run branch`,
        `  Stack: ${p.stack?.compose ?? 'not registered'} (${p.stack?.topology_default ?? '-'})`,
        `  Tests: ${Object.entries(p.tests).map(([k, v]) => `${k}: ${v}`).join('; ') || 'not registered'}`,
      ]),
      'These are registry facts, resolved before any agent ran. Use them instead of guessing.',
    )
  }
  if (startedBy) lines.push('', `Started by: ${startedBy}. Pushes, pull requests and Jira comments run under this developer's tokens.`)
  // The scope boundary, asked for where the step can still answer it. Every
  // marker the runner reads is documented at the point of use except this one,
  // which is new — and a marker no agent is told about is a marker nothing
  // emits. CSUP-7524 ended "two blockers remain" and named neither.
  lines.push(
    '',
    '## What you did not do',
    '',
    'Anything you deliberately left undone goes on its own line, exactly:',
    '',
    '    PIPELINE-NOT-DONE: <what> — <why>',
    '',
    'One line per item. The runner records them on the run, the summary prints',
    'them and the pull request body carries them. "Out of scope for this lane"',
    'is a reason; leaving it in prose where nobody can read it is not.',
  )
  lines.push('', '---', '')
  return lines.join('\n')
}

/**
 * The content type an artifact must be served with, or undefined for text.
 *
 * Lives here rather than in the route so it can be tested: the route served
 * every artifact as `text/plain` and ran it through toString('utf8'), which
 * replaces every byte that is not valid UTF-8. Screenshots arrived corrupted
 * and the console highlighted the corruption as source code.
 */
export function artifactContentType(name: string): string | undefined {
  return ({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    zip: 'application/zip',
    // Playwright records video alongside the trace, and a run that fixes a UI
    // defect writes the before/after pair as .webm. Absent from this map, the
    // route fell through to its text branch and decoded the video as UTF-8:
    // 405 KB of binary came back as 732 KB of replacement characters, so the
    // one artifact that shows the defect moving was the one nobody could open.
    webm: 'video/webm',
    mp4: 'video/mp4',
  } as Record<string, string>)[(name.split('.').pop() ?? '').toLowerCase()]
}
