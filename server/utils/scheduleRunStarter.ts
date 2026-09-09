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
import { startRun, workspaceSegment } from './workflowRunner.ts'
import { resolveParameters, RESERVED_PARAM_PROJECT_DIR } from '../../shared/utils/workflowParameters.ts'
import { join } from 'node:path'
import type { Schedule, ScheduleState } from '../../shared/types/schedule.ts'

/**
 * Where a scheduled run works: one directory per schedule, under its owner's
 * workspace root.
 *
 * Derived, never configured, and that is the whole point. The run lock is on
 * the directory a run writes, so a schedule pointed at a developer's checkout
 * would either block their manual run or be blocked by it, at 2am, with nobody
 * watching. Its own directory means the only thing it can ever contend with is
 * its own previous run — which is a case with an obvious right answer.
 *
 * The cost, accepted deliberately: a schedule cannot be aimed at a checkout
 * somebody is already working in.
 */
export function scheduleWorkspace(schedule: Schedule): string {
  return join(workspaceRootFor(schedule.createdBy), workspaceSegment(schedule.id))
}

export async function realScheduleStarter(schedule: Schedule): Promise<ScheduleState> {
  const workflow = await loadWorkflowSteps(schedule.workflowSlug)
  if (!workflow) {
    return { lastOutcome: 'error', lastDetail: `workflow "${schedule.workflowSlug}" no longer exists on this instance` }
  }
  if (!workflow.steps.length) {
    return { lastOutcome: 'error', lastDetail: `workflow "${schedule.workflowSlug}" has no steps` }
  }

  const projectDir = scheduleWorkspace(schedule)

  // A projectDir the schedule stated is REPLACED by the derived directory, not
  // dropped. Dropping it looked equivalent and was not: a workflow that
  // declares projectDir as required would then have no value for it and could
  // never be scheduled at all, while the run it would have produced was always
  // going to work in the derived directory anyway. Substituting keeps the
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

  // The schedule's own previous run is still going. Skipped, not queued and
  // not an error: a nightly scan has a next fire by definition, and one that
  // starts at 10am because it waited for yesterday's produces evidence whose
  // timestamp contradicts its name.
  const active = await findRunInWorkspace(projectDir)
  if (active) {
    return {
      lastOutcome: 'skipped',
      lastDetail: `a run started ${new Date(active.startedAt).toISOString()} is still working in ${projectDir}`,
      lastRunId: active.id,
    }
  }

  const run = await startRun({
    workflow: { slug: workflow.slug, name: workflow.name, steps: workflow.steps },
    initialPrompt: schedule.initialPrompt,
    parameters: values,
    projectDir,
    autoRun: schedule.autoRun,
    startedBy: schedule.createdBy,
    // The third honest answer to "what triggered this?", beside a watch id and
    // the reserved 'direct-invocation'. See WorkflowRun.watch.
    watch: `schedule:${schedule.id}`,
  })

  return { lastOutcome: 'started', lastRunId: run.id }
}
