/**
 * Who owns the docker estate a run leaves behind.
 *
 * Nobody did, and a measurement of this box said what that costs: 116 images
 * for 53.5 GB (84% reclaimable), 102 volumes for 18.8 GB, 48 GB of build cache,
 * and containers still up six days after their run ended, serving images tagged
 * with the run id that built them (`localhost/agent-sdlc/lum-selfcare-v1:88bc24e9`).
 * Roughly 150 GB, attributable to nothing, deletable by nobody who was willing
 * to guess.
 *
 * The guessing is the problem, so this file removes it: every docker object the
 * runner creates is LABELLED with the run that created it, and nothing without
 * that label is ever a candidate for removal. Not by age, not by name, not by
 * "it looks like ours". Two rules, both absolute:
 *
 *   1. NOTHING UNLABELLED IS EVER SELECTED. Every listing filters on the label,
 *      and every parsed row is dropped again if its label came back empty — the
 *      filter and the check are deliberately redundant, because a `docker ps`
 *      whose filter silently did nothing returns the whole box.
 *   2. VOLUMES ARE NEVER TOUCHED. Same rule as stackLifecycle's teardown: a
 *      volume holds seeded data, and there is deliberately no flag to opt in.
 *      The 18.8 GB of volumes stays until a person removes it by hand.
 *
 * `reapOrphans` reports by default and removes only when asked. A sweep that
 * deletes on its first run is a sweep nobody can safely try once.
 *
 * ── on compose stacks ──────────────────────────────────────────────────────
 * `docker compose up` has no `--label` flag (checked: neither `up`, `create`
 * nor `build` takes one; only `compose run` does), and the two workarounds that
 * would reach it are both worse than the leak. `--project-name` renames the
 * project's named VOLUMES, which orphans exactly the seeded data teardown
 * exists to protect; a generated override file adding labels to every service
 * means parsing someone else's compose YAML and failing the stack stage when
 * the parse is wrong. So stackLifecycle hands the run id to compose through the
 * environment instead (`labelEnv` / AGENT_RUN_ID), where a compose file opts in
 * with `labels: ["run.id=${AGENT_RUN_ID:-}"]`. Until the infra repo's compose
 * files do that, a compose stack's containers carry no label and this reaper
 * will not touch them — which is the honest outcome, not a silent one.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from './log.ts'

const log = createLogger('runner')
const execFileP = promisify(execFile)

/** The one label key. Read by the filters below and written by everything that
 *  creates a docker object on a run's behalf. */
export const RUN_LABEL = 'run.id'
/** The environment variable a compose file interpolates to carry the same fact. */
export const RUN_ID_ENV = 'AGENT_RUN_ID'

export const runLabel = (runId: string) => `${RUN_LABEL}=${runId}`

/** Flags for any `docker run|create|build|network create` this runner issues. */
export function labelArgs(runId: string): string[] {
  return ['--label', runLabel(runId)]
}

/** The same fact for a child process that cannot take a flag — see the compose note above. */
export function labelEnv(runId: string): Record<string, string> {
  return { [RUN_ID_ENV]: runId }
}

export type DockerExec = (args: string[]) => Promise<string>

const realExec: DockerExec = async (args) => {
  const { stdout } = await execFileP('docker', args, { timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

let injectedExec: DockerExec | null = null
/** Test seam, matching stackLifecycle.setStackExec. No test may reach the real daemon. */
export function setDockerExec(fn: DockerExec | null) { injectedExec = fn }

/** Volumes are absent from this union on purpose; see rule 2. */
export type ReapKind = 'container' | 'image' | 'network'

export interface ReapTarget {
  kind: ReapKind
  id: string
  /** Container name, image repo:tag, or network name — for the report only. */
  name: string
  runId: string
  /** Epoch ms, or 0 when docker's timestamp could not be parsed. */
  created: number
}

export interface ReapResult {
  /** What carries the label and matches the request. */
  targets: ReapTarget[]
  /** What was actually removed; empty on a reporting pass. */
  removed: ReapTarget[]
  /** Every docker command run, in order. */
  ran: string[]
  summary: string
}

const FORMAT = `{{.ID}}\t{{.CreatedAt}}\t{{.Label "${RUN_LABEL}"}}`

const LIST: Record<ReapKind, (filter: string) => string[]> = {
  container: f => ['ps', '-a', '--filter', f, '--format', `${FORMAT}\t{{.Names}}`],
  image: f => ['image', 'ls', '--filter', f, '--format', `${FORMAT}\t{{.Repository}}:{{.Tag}}`],
  network: f => ['network', 'ls', '--filter', f, '--format', `${FORMAT}\t{{.Name}}`],
}

const REMOVE: Record<ReapKind, (ids: string[]) => string[]> = {
  container: ids => ['rm', '-f', ...ids],
  image: ids => ['rmi', ...ids],
  network: ids => ['network', 'rm', ...ids],
}

/** docker prints `2026-09-15 10:22:31 +0530 IST`; Date.parse chokes on the
 *  trailing zone name and not on the offset, so drop it. 0 rather than now for
 *  an unparsable stamp: an unknown age must never read as "old enough". */
function parseCreated(s: string): number {
  const t = Date.parse(s.trim().split(' ').slice(0, 3).join(' '))
  return Number.isFinite(t) ? t : 0
}

function parse(kind: ReapKind, stdout: string): ReapTarget[] {
  const out: ReapTarget[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [id = '', created = '', runId = '', name = ''] = line.split('\t')
    // Rule 1, the redundant half: a row whose label came back empty is dropped
    // even though the filter should have excluded it.
    if (!id.trim() || !runId.trim()) continue
    out.push({ kind, id: id.trim(), name: name.trim() || id.trim(), runId: runId.trim(), created: parseCreated(created) })
  }
  return out
}

async function list(kind: ReapKind, filter: string, exec: DockerExec, ran: string[]): Promise<ReapTarget[]> {
  const args = LIST[kind](filter)
  ran.push(`docker ${args.join(' ')}`)
  try {
    return parse(kind, await exec(args))
  } catch (err) {
    // Best effort: a daemon that will not answer is reported, never thrown at a
    // caller that was only tidying up.
    log.warn('reap listing failed', { kind, filter, error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

async function remove(targets: ReapTarget[], exec: DockerExec, ran: string[]): Promise<ReapTarget[]> {
  const done: ReapTarget[] = []
  for (const kind of ['container', 'image', 'network'] as ReapKind[]) {
    const of = targets.filter(t => t.kind === kind)
    if (!of.length) continue
    const args = REMOVE[kind](of.map(t => t.id))
    ran.push(`docker ${args.join(' ')}`)
    try {
      await exec(args)
      done.push(...of)
    } catch (err) {
      // An image still used by a container, a network still attached: normal,
      // and not worth failing the sweep over.
      log.warn('reap removal failed', { kind, count: of.length, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return done
}

/**
 * Remove the containers, images and networks labelled with this run.
 *
 * Containers first, then images, then networks — the order the dependencies
 * require. Volumes are not removed, ever. Reports rather than removes when
 * `apply` is false.
 */
export async function reapRun(runId: string, opts: { apply?: boolean, exec?: DockerExec } = {}): Promise<ReapResult> {
  if (!runId || !/^[\w.-]+$/.test(runId)) {
    // A blank or shell-shaped run id would widen the filter to "everything",
    // which is the one thing this file must never do.
    throw new Error(`reapRun needs a plain run id; got "${runId}"`)
  }
  const exec = opts.exec ?? injectedExec ?? realExec
  const ran: string[] = []
  const filter = `label=${runLabel(runId)}`
  const targets: ReapTarget[] = []
  for (const kind of ['container', 'image', 'network'] as ReapKind[]) {
    targets.push(...(await list(kind, filter, exec, ran)).filter(t => t.runId === runId))
  }
  const removed = opts.apply === false ? [] : await remove(targets, exec, ran)
  const summary = targets.length
    ? `${runId}: ${opts.apply === false ? 'would remove' : 'removed'} ${removed.length || targets.length} labelled object(s) — ${targets.map(t => `${t.kind} ${t.name}`).join(', ')}. Volumes were not touched.`
    : `${runId}: nothing carries ${runLabel(runId)}, so there is nothing to remove.`
  log.info('reap run', { runId, targets: targets.length, removed: removed.length })
  return { targets, removed, ran, summary }
}

/**
 * Everything labelled with SOME run, older than `olderThanHours`, whose run is
 * not named in `keepRunIds`.
 *
 * Reports by default (`apply` defaults to false). The age test uses docker's
 * own creation stamp, and an object whose stamp could not be parsed is treated
 * as age 0 — recent, therefore kept.
 */
export async function reapOrphans(opts: { olderThanHours?: number, apply?: boolean, keepRunIds?: string[], exec?: DockerExec, now?: number } = {}): Promise<ReapResult> {
  const { olderThanHours = 24, apply = false, keepRunIds = [], now = Date.now() } = opts
  const exec = opts.exec ?? injectedExec ?? realExec
  const ran: string[] = []
  const keep = new Set(keepRunIds)
  const cutoff = now - olderThanHours * 60 * 60_000
  // Key-only filter: every object that carries a run.id, whatever its value.
  const filter = `label=${RUN_LABEL}`
  const all: ReapTarget[] = []
  for (const kind of ['container', 'image', 'network'] as ReapKind[]) all.push(...await list(kind, filter, exec, ran))
  const targets = all.filter(t => !keep.has(t.runId) && t.created > 0 && t.created < cutoff)
  const removed = apply ? await remove(targets, exec, ran) : []
  const runs = [...new Set(targets.map(t => t.runId))]
  const summary = targets.length
    ? `${apply ? 'Removed' : 'Would remove'} ${targets.length} labelled object(s) older than ${olderThanHours}h from ${runs.length} run(s): ${runs.join(', ')}.`
      + `${apply ? '' : ' Nothing was removed; pass apply to act.'} Volumes are never included.`
    : `Nothing labelled ${RUN_LABEL} is older than ${olderThanHours}h.`
  log.info('reap orphans', { olderThanHours, apply, targets: targets.length, removed: removed.length })
  return { targets, removed, ran, summary }
}
