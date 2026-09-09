/**
 * The cron scheduler: one croner job per enabled schedule, supervised against
 * `schedules.json`.
 *
 * Structurally this is watchScheduler.ts's supervisor with two substitutions -
 * a `Cron` where it has a `setInterval`, and a cron-expression comparison
 * where it compares `intervalSeconds`. What it deliberately does NOT reuse is
 * that file's cycle: a watch reconciles ticket dispositions and escalates, and
 * a schedule has no tickets to reconcile.
 *
 * It lives in server/utils/, not server/plugins/, because server/plugins/*
 * depends on Nitro's defineNitroPlugin global and can only be loaded by Nitro
 * itself - and scripts/test-schedule-runner.mjs has to import this under plain
 * node. server/plugins/scheduler.ts is the one-line wiring.
 */
import { Cron } from 'croner'
import { createLogger } from './log.ts'
import { recordScheduleFire } from './scheduleState.ts'
import type { Schedule, ScheduleState } from '../../shared/types/schedule.ts'

const log = createLogger('runner')

interface ScheduledJob {
  cron: Cron
  /** The expression this job was built for; a change here forces a rebuild. */
  key: string
  /** Refreshed on every reconcile even when the expression is unchanged, so an
   *  edit to the prompt, the parameters or autoRun reaches the next fire
   *  instead of the job firing against an object frozen at schedule time. */
  schedule: Schedule
}

const jobs = new Map<string, ScheduledJob>()
let supervisor: ReturnType<typeof setInterval> | null = null

/** How often the supervisor re-reads the schedule list. A parameter to
 *  startScheduleRunner rather than a constant, so a test can drive real timers
 *  without waiting on a production cadence.
 *
 *  Deliberately NOT exported: Nitro auto-imports every server/utils export, and
 *  watchScheduler.ts already exports this name - the collision made Nitro warn
 *  and silently ignore one of them on every build. */
const DEFAULT_SUPERVISOR_INTERVAL_MS = 1000

export type ScheduleSource = () => Promise<Schedule[]> | Schedule[]
export type ScheduleStarter = (schedule: Schedule) => Promise<ScheduleState>

/** No schedules until something calls setScheduleSource - the same seam shape
 *  watchScheduler.ts uses, and what lets a test drive this without Nitro. */
let scheduleSource: ScheduleSource = () => []
export function setScheduleSource(fn: ScheduleSource): void {
  scheduleSource = fn
}

let starter: ScheduleStarter = async () => {
  throw new Error('no schedule starter configured — call setScheduleStarter first')
}
export function setScheduleStarter(fn: ScheduleStarter): void {
  starter = fn
}

/** The expression a job is keyed on. Timezone is part of it: the same pattern
 *  in a different zone is a different firing time. */
const jobKey = (s: Schedule) => `${s.cron}|${s.timezone ?? ''}`

/**
 * When this schedule fires next, or null if its expression will not parse.
 *
 * Exported for the API and the page: an operator reading `0 2 * * *` back
 * should not have to work out what it means, and "next fire" is the answer
 * they actually want.
 */
export function nextFireAt(schedule: Schedule): Date | null {
  try {
    return new Cron(schedule.cron, { timezone: schedule.timezone, paused: true }).nextRun()
  } catch {
    return null
  }
}

/** True when croner will accept this expression. The API validates on save so
 *  a schedule is never silently dead at 2am. */
export function isValidCron(expression: string, timezone?: string): boolean {
  try {
    new Cron(expression, { timezone, paused: true }).stop()
    return true
  } catch {
    return false
  }
}

/**
 * One fire. Never throws: it is called from a cron callback nobody awaits, so
 * an escaping rejection would be an unhandled one.
 */
export async function fireSchedule(schedule: Schedule): Promise<ScheduleState> {
  try {
    const outcome = await starter(schedule)
    return await recordScheduleFire(schedule.id, outcome)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log.warn('schedule fire failed', { scheduleId: schedule.id, error: detail })
    return await recordScheduleFire(schedule.id, { lastOutcome: 'error', lastDetail: detail })
  }
}

/**
 * Reconciles the live `jobs` map against the current schedule source.
 *
 *  - enabled + unscheduled (new, or just flipped on): gets a job
 *  - enabled + expression or timezone changed: old job stopped, new one built -
 *    retimed, never accumulated into a second job
 *  - enabled + unchanged: left running, its captured schedule refreshed
 *  - disabled, or no longer returned at all (deleted): job stopped and removed
 *  - an expression croner rejects: recorded against that schedule and skipped,
 *    inside the loop, so one bad entry cannot stop the others reconciling
 */
async function reconcileJobs(): Promise<void> {
  const schedules = await scheduleSource()
  const seen = new Set<string>()

  for (const schedule of schedules) {
    seen.add(schedule.id)
    const existing = jobs.get(schedule.id)

    if (!schedule.enabled) {
      if (existing) {
        existing.cron.stop()
        jobs.delete(schedule.id)
      }
      continue
    }

    const key = jobKey(schedule)
    if (existing) {
      existing.schedule = schedule
      if (existing.key === key) continue
      existing.cron.stop() // retime: replace, never accumulate
      jobs.delete(schedule.id)
    }

    try {
      const entry: ScheduledJob = {
        key,
        schedule,
        // `catch: true` so a throw inside the callback cannot reach the
        // process. `protect` is deliberately not set: startRun is
        // fire-and-forget, so this callback is never still executing when the
        // next fire lands and protect would guard nothing. Overlap is handled
        // by the starter, which sees the schedule's own live run and skips.
        cron: new Cron(schedule.cron, { timezone: schedule.timezone, catch: true }, () => {
          void fireSchedule(entry.schedule)
        }),
      }
      jobs.set(schedule.id, entry)
    } catch (err) {
      // An expression the API accepted and a later hand-edit broke. Recorded
      // where the page will show it, rather than thrown out of the supervisor.
      const detail = err instanceof Error ? err.message : String(err)
      log.warn('schedule has an unusable cron expression; not scheduled', {
        scheduleId: schedule.id, cron: schedule.cron, error: detail,
      })
      await recordScheduleFire(schedule.id, {
        lastOutcome: 'error',
        lastDetail: `cron expression "${schedule.cron}" cannot be parsed: ${detail}`,
      })
    }
  }

  // A schedule the source no longer returns (deleted) must not leave a job
  // firing against something that no longer exists.
  for (const id of [...jobs.keys()]) {
    if (!seen.has(id)) {
      jobs.get(id)!.cron.stop()
      jobs.delete(id)
    }
  }
}

/** Reconcile once, now. Exported for tests that would rather not wait a tick. */
export function reconcileSchedulesNow(): Promise<void> {
  return reconcileJobs()
}

/** Schedule ids with a live job. Exported so a test can assert a retime
 *  replaced a job rather than adding one. */
export function scheduledIds(): string[] {
  return [...jobs.keys()]
}

/**
 * Starts the supervisor: reconciles immediately, then every
 * `supervisorIntervalMs`. Re-entrant - it stops everything first, so calling
 * it twice is safe.
 */
export function startScheduleRunner(supervisorIntervalMs = DEFAULT_SUPERVISOR_INTERVAL_MS): void {
  stopScheduleRunner()
  void reconcileJobs()
  supervisor = setInterval(() => { void reconcileJobs() }, supervisorIntervalMs)
  log.info('schedule runner started', { supervisorIntervalMs })
}

/** Stops every job and the supervisor. Safe when nothing is running. */
export function stopScheduleRunner(): void {
  for (const entry of jobs.values()) entry.cron.stop()
  jobs.clear()
  if (supervisor) {
    clearInterval(supervisor)
    supervisor = null
  }
}
