import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { computeFixFacts } from './gitFacts.ts'
import type { AgentUsage } from './agentCaller.ts'
import type { WorkflowRun, RunStep } from '~~/shared/types/run'

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

/** Keys the RUNNER owns. An agent may write them; finalize overwrites them.
 *  Split out so there is exactly one list, used by both seed and finalize. */
function runnerOwned(run: WorkflowRun) {
  const ended = run.endedAt ?? Date.now()
  return {
    identity: run.workflowSlug,
    // The runner's own fact for what dispatched this run — set once at
    // startRun and carried on the run record ever since (never inferred
    // from, or trusted from, an agent's self-report), same as identity.
    watch: run.watch,
    model: modelsUsed(run),
    cost: {
      ...tokenTotals(run),
      attempts: Math.max(1, ...run.steps.map(s => s.visits ?? 1)),
      wall_clock_min: Math.round((ended - run.startedAt) / 60000),
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

  if (computed) {
    const priorRepos = Array.isArray(existingFix?.repos) ? existingFix!.repos as Array<Record<string, unknown>> : []
    const priorEntry = priorRepos.find(r => r && r.repo === computed.repo)
    const repoEntry: Record<string, unknown> = { repo: computed.repo, commits: computed.commits }
    // `pr` is not something git can prove; carry it forward only when the
    // agent's self-report names the SAME repo git computed.
    if (priorEntry && typeof priorEntry.pr === 'string') repoEntry.pr = priorEntry.pr

    // Every OTHER repo the agent reported (not the one git just computed)
    // is outside what this run's projectDir can verify — kept as-is rather
    // than discarded, the same way a matching entry's `pr` already is.
    const otherRepos = priorRepos.filter(r => !(r && r.repo === computed.repo))
    const repos = [...otherRepos, repoEntry]

    const repoNames = new Set(repos.map(r => r.repo))
    const priorMergeOrder = Array.isArray(existingFix?.merge_order)
      ? existingFix!.merge_order as unknown[]
      : undefined
    const mergeOrderCoherent = repos.length > 1
      && priorMergeOrder !== undefined
      && priorMergeOrder.every(name => typeof name === 'string' && repoNames.has(name))

    return {
      ...restFix,
      ...(mergeOrderCoherent ? { merge_order: priorMergeOrder } : {}),
      repos,
      files_changed: computed.files_changed,
      lines_changed: computed.lines_changed,
    }
  }

  // Nothing computable. If the agent wrote nothing at all either, leave
  // `fix` entirely absent rather than fabricating an empty object.
  if (existingFix === undefined) return undefined
  return restFix
}

export async function initRunArtifacts(run: WorkflowRun, workflowName: string): Promise<void> {
  const dir = runArtifactsDir(run.id)
  await mkdir(join(dir, 'steps'), { recursive: true })
  await writeFile(join(dir, 'meta.json'),
    JSON.stringify({ ...runnerOwned(run), workflow: workflowName }, null, 2))
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
}

/**
 * Re-assert the runner's facts over whatever the agents merged in, and
 * survive a meta.json an agent corrupted: the runner's own record is the
 * floor this whole design rests on, so it must not be lost to a bad write.
 */
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

  await writeFile(path, JSON.stringify(merged, null, 2))
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
export async function markArtifactsUnusable(runId: string): Promise<void> {
  await rm(join(runArtifactsDir(runId), 'meta.json'), { force: true })
}

/** Prepended to every step's input. The only channel an agent has for
 *  learning where to write, so it must be unmissable and literal. */
export function artifactHeader(dir: string): string {
  return [
    '## Run artifacts directory',
    '',
    `Write every artifact you produce into: ${dir}`,
    '',
    'This directory is the run\'s evidence. A file you do not write is evidence',
    'that does not exist — do not describe an artifact in prose instead of',
    'writing it, and never write a placeholder in place of a real result.',
    '',
    '---',
    '',
  ].join('\n')
}
