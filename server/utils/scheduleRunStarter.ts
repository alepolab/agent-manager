/**
 * The real `ScheduleStarter` for scheduleRunner.ts's seam — turns one cron
 * fire into a workflow run.
 *
 * In server/utils/ rather than server/plugins/scheduler.ts for the reason
 * watchRunStarter.ts states: server/plugins/*.ts needs Nitro's
 * defineNitroPlugin global and can only be loaded by Nitro, and
 * scripts/test-schedule-runner.mjs has to import this under plain node.
 */
import { workspaceRootFor } from './workspace.ts'
import { findRunInWorkspace, loadWorkflowSteps } from './workflowRunStore.ts'
import { startOrQueue, workspaceSegment, WorkspaceBusyError } from './workflowRunner.ts'
import { resolveParameters, RESERVED_PARAM_PROJECT_DIR } from '../../shared/utils/workflowParameters.ts'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Schedule, ScheduleState } from '../../shared/types/schedule.ts'

/**
 * Where a scheduled run works: one directory per schedule, under its owner's
 * workspace root.
 *
 * This is the DERIVED answer specifically, not the effective one — a schedule
 * may name its own directory instead (see scheduleProjectDir). Kept separate
 * because it is what "its own private directory" means: derived from the id,
 * so the only run it can ever contend with is that schedule's own previous
 * one, which is a case with an obvious right answer.
 */
export function scheduleWorkspace(schedule: Pick<Schedule, 'id' | 'createdBy'>): string {
  return join(workspaceRootFor(schedule.createdBy), workspaceSegment(schedule.id))
}

/**
 * The directory this schedule's runs will actually work in: the one it states,
 * else the derived one.
 *
 * Exported and shared by all three callers deliberately — the starter, the
 * list route's `workspace`, and POST /api/schedules' parameter pre-check.
 * Those three MUST agree: the directory the pre-check accepts a schedule
 * against, the one the page shows an operator, and the one the run takes its
 * lock on are one answer. Three copies of `projectDir?.trim() || derived` is
 * how they drift apart, and the symptom would be a page reporting a directory
 * the run does not use.
 */
export function scheduleProjectDir(schedule: Pick<Schedule, 'id' | 'createdBy' | 'projectDir'>): string {
  return schedule.projectDir?.trim() || scheduleWorkspace(schedule)
}

export async function realScheduleStarter(schedule: Schedule): Promise<ScheduleState> {
  const workflow = await loadWorkflowSteps(schedule.workflowSlug)
  if (!workflow) {
    return { lastOutcome: 'error', lastDetail: `workflow "${schedule.workflowSlug}" no longer exists on this instance` }
  }
  if (!workflow.steps.length) {
    return { lastOutcome: 'error', lastDetail: `workflow "${schedule.workflowSlug}" has no steps` }
  }

  const projectDir = scheduleProjectDir(schedule)

  // A stated directory that has gone missing since it was saved is reported,
  // not recreated: an empty directory where a checkout used to be would scan
  // nothing and call it a pass. A derived one is startRun's to create.
  if (schedule.projectDir?.trim() && !existsSync(projectDir)) {
    return { lastOutcome: 'error', lastDetail: `${projectDir} does not exist any more` }
  }

  // A projectDir inside `parameters` is REPLACED by the effective directory,
  // not dropped. Dropping it looked equivalent and was not: a workflow that
  // declares projectDir as required would then have no value for it and could
  // never be scheduled at all, while the run it would have produced was always
  // going to work in the effective directory anyway. Substituting keeps the
  // parameter satisfied AND keeps what the agents are told identical to where
  // they actually work - the value here is the same one `Work in:` names.
  const supplied = { ...(schedule.parameters ?? {}), [RESERVED_PARAM_PROJECT_DIR]: projectDir }
  const { values, missing } = resolveParameters(workflow.parameters, supplied)
  if (missing.length) {
    return {
      lastOutcome: 'error',
      lastDetail: `the workflow needs ${missing.join(', ')}, which this schedule does not state`,
    }
  }

  // The schedule's own previous run is still going, or a run it queued earlier
  // has not started yet. Skipped, not queued again, and not an error: a nightly
  // scan has a next fire by definition, and one that starts at 10am because it
  // waited for yesterday's produces evidence whose timestamp contradicts its
  // name.
  //
  // `includeQueued` is what keeps a full group from turning one schedule into a
  // backlog. Without it, 2am queues, 3am cannot see that queued run and queues
  // a second, 4am a third, and by morning the drain launches eight runs at one
  // directory. At most one fire of a schedule is ever outstanding.
  const active = await findRunInWorkspace(projectDir, undefined, { includeQueued: true })
  if (active) {
    return {
      lastOutcome: 'skipped',
      lastDetail: active.status === 'queued'
        ? `a fire from ${new Date(active.queuedAt ?? active.startedAt).toISOString()} is already queued for ${projectDir}`
        : `a run started ${new Date(active.startedAt).toISOString()} is still working in ${projectDir}`,
      lastRunId: active.id,
    }
  }

  try {
    const { run, queued } = await startOrQueue({
      workflow: { slug: workflow.slug, name: workflow.name, group: workflow.group, steps: workflow.steps },
      initialPrompt: schedule.initialPrompt,
      parameters: values,
      projectDir,
      autoRun: schedule.autoRun,
      startedBy: schedule.createdBy,
      // The third honest answer to "what triggered this?", beside a watch id and
      // the reserved 'direct-invocation'. See WorkflowRun.watch.
      watch: `schedule:${schedule.id}`,
    })
    // Reported as what it is. Calling a queue 'started' would make the
    // Schedules page say the nightly scan ran at 2am when it in fact began
    // waiting at 2am - and the run id is the same either way, so the operator
    // can follow it.
    return { lastOutcome: queued ? 'queued' : 'started', lastRunId: run.id }
  } catch (err) {
    // Another start already holds this directory and has not persisted its run
    // yet, so the check above could not see it. Same outcome as finding a
    // persisted one: a skip, for the same reason - a nightly scan has a next
    // fire, and this is not a failure of the schedule.
    if (err instanceof WorkspaceBusyError) {
      return { lastOutcome: 'skipped', lastDetail: `another run was already starting in ${projectDir}` }
    }
    throw err
  }
}
