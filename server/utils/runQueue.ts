/**
 * How many runs a concurrency group may have working at once, and where the
 * rest wait for a slot.
 *
 * A scan that finds twenty things would otherwise dispatch twenty pipelines at
 * once: twenty clones, twenty agent budgets, one machine. The cap is the whole
 * reason this file exists.
 *
 * BOTH SIDES ARE COUNTED FROM THE RUNS THEMSELVES. Nothing is tracked here.
 * The agent this replaces kept its own `active` array in a JSON file and needed
 * a 24-hour "stale" rule to cope with that array drifting from reality —
 * entries for runs that had long finished, holding slots nobody was using. Its
 * first replacement (pipelineQueue.ts) fixed the in-flight side by deriving it
 * and left the WAITING side as a file of dispatch descriptors, which duplicated
 * run fields, was invisible on /runs, could not be cancelled, and dropped an
 * item whose start threw. Now a waiting run is simply a run whose status is
 * `queued`: derived on both sides, so neither can drift, and there is no file.
 *
 * This module never imports workflowRunner.ts — starting and launching arrive
 * as callbacks, the same dependency discipline pipelineQueue.ts kept.
 */

import { DEFAULT_GROUP_ID } from '../../shared/types/workflowGroup.ts'
import { capFor } from './workflowGroups.ts'
import { listRuns } from './workflowRunStore.ts'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '~~/shared/types/run'

// The runner's own namespace: this is work the runner does, not a subsystem of
// its own, and Namespace is a closed union in log.ts.
const log = createLogger('runner')

/** The group a run counts against. Absent means the default group, never uncapped. */
export const groupOf = (run: Pick<WorkflowRun, 'group'>): string => run.group?.trim() || DEFAULT_GROUP_ID

/**
 * What a launch attempt did, so the drain knows whether the slot was taken and
 * whether to look at this run again.
 *
 * `deferred` is the one that matters: a queued run whose working directory is
 * busy right now has lost no race it entered and must stay queued. Its slot is
 * NOT consumed, so the drain moves to the next candidate — a permanently
 * blocked run at the head of the queue must not starve everything behind it,
 * which is what stopping at the head would do.
 */
export type LaunchOutcome = 'launched' | 'deferred' | 'failed'
export type Launcher = (run: WorkflowRun) => Promise<LaunchOutcome>

/**
 * Serialises this process's admission and drain decisions, the way publish()
 * serialises one run's writes.
 *
 * This is the check-then-act guard, and it is the reason `slotsFor` is not
 * exported: two watch dispatches and a cron fire landing in the same tick would
 * each read "one slot free" and all three would start. Callers state what they
 * want done and never see a number.
 */
let chain: Promise<unknown> = Promise.resolve()
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.catch(() => {}).then(fn)
  chain = next.catch(() => {})
  return next
}

/**
 * Runs occupying a slot in this group: ones actually working.
 *
 * `queued` is excluded — waiting is not working, and counting it would mean a
 * full queue permanently blocked its own drain. Everything else that can still
 * change is counted, INCLUDING a run somebody started by hand: a developer's
 * run uses the same machine, the same clones and the same agent budget as a
 * scheduled one, and excluding it would make a cap of 2 mean "2 plus however
 * many people are working". (pipelineQueue.ts counted only runs with a
 * parentRunId, which is why the old cap governed child dispatch and nothing
 * else.)
 *
 * The consequence to know about: a run that DISPATCHES is itself live, so it
 * holds one of its group's slots while it does so. A scan workflow in the same
 * group as the runbooks it dispatches into therefore needs a cap of at least
 * 2 to have any child running alongside it, and at a cap of 1 its children all
 * wait until the scan itself finishes. That is honest — the scan is using the
 * machine too — and the arrangement that avoids it is the one groups exist for:
 * put the dispatcher in its own group, and give the pipelines it feeds theirs.
 */
export async function inFlightForGroup(group: string, runs?: WorkflowRun[]): Promise<number> {
  const all = runs ?? await listRuns()
  return all.filter(r => (r.status === 'running' || r.status === 'paused') && groupOf(r) === group).length
}

/**
 * What is waiting in this group, in the order it will start.
 *
 * Ordered by `(queuedAt, id)`, and the tiebreak is not decoration: a dispatch
 * step builds all twenty of its children in one synchronous loop, so their
 * `queuedAt` values are routinely identical. `queuedAt` alone would leave the
 * order to whatever `readdir` returned, which is not a queue. The id is
 * arbitrary but stable, which is what makes the order testable.
 */
export async function waiting(group: string, runs?: WorkflowRun[]): Promise<WorkflowRun[]> {
  const all = runs ?? await listRuns()
  return all
    .filter(r => r.status === 'queued' && groupOf(r) === group)
    .sort((a, b) => (a.queuedAt ?? a.startedAt) - (b.queuedAt ?? b.startedAt) || a.id.localeCompare(b.id))
}

/** 1-based place in its group's queue, or 0 for a run that is not waiting.
 *  For display only: it is stale the instant anything else queues, so nothing
 *  persists it. */
export async function position(run: WorkflowRun): Promise<number> {
  if (run.status !== 'queued') return 0
  const queue = await waiting(groupOf(run))
  return queue.findIndex(r => r.id === run.id) + 1
}

/** Both halves of a group's occupancy, for the groups route and the run list. */
export async function groupLoad(group: string): Promise<{ group: string, inFlight: number, waiting: number, maxConcurrent: number }> {
  const runs = await listRuns()
  return {
    group,
    inFlight: await inFlightForGroup(group, runs),
    waiting: (await waiting(group, runs)).length,
    maxConcurrent: await capFor(group),
  }
}

/**
 * The admission gate: start it now if the group has room, else queue it.
 *
 * Anything already waiting in the group goes first, even when a slot is free —
 * a queue that lets later arrivals overtake is not a queue.
 */
export function admit<T extends WorkflowRun>(opts: {
  group: string
  start: () => Promise<T>
  enqueue: () => Promise<T>
  /**
   * Anything else that must be decided against the same snapshot of the runs,
   * run inside this serialised section and free to throw to refuse admission.
   *
   * It exists because the slot count is not the only check-then-act question
   * here. The caller's own "is anything already aimed at this working
   * directory" is another, and running it OUTSIDE this section is exactly the
   * race it was meant to close: two cron fires a millisecond apart both looked,
   * both saw an idle directory, and then the cap - being 2, not 1 - happily let
   * both start. Two runs, one checkout.
   */
  guard?: () => Promise<void>
}): Promise<{ run: T, queued: boolean }> {
  return serialised(async () => {
    await opts.guard?.()

    const runs = await listRuns()
    const cap = await capFor(opts.group)
    const free = cap - await inFlightForGroup(opts.group, runs)
    const ahead = (await waiting(opts.group, runs)).length

    if (free > 0 && ahead === 0) return { run: await opts.start(), queued: false }
    return { run: await opts.enqueue(), queued: true }
  })
}

/**
 * True while this process has any reason to think something might be waiting.
 *
 * The periodic sweep exists because a run whose owning process died never
 * publishes a terminal status — applyInterrupted derives `interrupted` on READ
 * — so its slot is freed with nothing to notice. But a sweep costs a listRuns,
 * which JSON-parses every run record and signals every owning pid, so it must
 * not run every minute for the life of an instance that has nothing queued.
 * Starts true so the first sweep after boot always happens.
 */
let mayHaveWaiting = true
export function noteQueued() { mayHaveWaiting = true }
export function mightHaveWaiting() { return mayHaveWaiting }

/**
 * Launches whatever now fits, oldest first, across EVERY group.
 *
 * Called whenever a run settles, so a finished pipeline hands its slot to the
 * next waiter, and on a timer for the dead-owner case above. Every group is
 * swept rather than just the settling run's: it is one listRuns either way, and
 * per-group draining only adds a way to miss one.
 *
 * Returns how many it started, which is 0 on the overwhelmingly common path.
 */
export function drainRunQueue(launch: Launcher): Promise<number> {
  return serialised(async () => {
    const runs = await listRuns()
    const queued = runs.filter(r => r.status === 'queued')
    if (!queued.length) {
      // Nothing waiting anywhere: the timer can go quiet until something queues.
      mayHaveWaiting = false
      return 0
    }

    let started = 0
    for (const group of [...new Set(queued.map(groupOf))]) {
      let free = await capFor(group) - await inFlightForGroup(group, runs)
      const candidates = await waiting(group, runs)

      for (const candidate of candidates) {
        if (free <= 0) break
        let outcome: LaunchOutcome
        try {
          outcome = await launch(candidate)
        } catch (err) {
          // A launcher that throws rather than reporting is treated as a
          // deferral, never a drop: the run stays queued and visible on /runs,
          // and the next sweep tries again. pipelineQueue.ts dropped the item
          // here, which is how queued work silently disappeared.
          log.warn('launching a queued run threw; leaving it queued', {
            runId: candidate.id, group, error: err instanceof Error ? err.message : String(err),
          })
          continue
        }
        if (outcome === 'launched') {
          log.info('queued run started', { runId: candidate.id, group, workflowSlug: candidate.workflowSlug })
          started++
          free--
        }
        // 'deferred' keeps its place and costs no slot; 'failed' has left the
        // queue with a recorded reason. Either way, try the next candidate -
        // one blocked run at the head must not starve the group.
      }
    }

    return started
  })
}
