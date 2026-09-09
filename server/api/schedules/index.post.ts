import { listSchedules, saveSchedule } from '../../utils/scheduleConfig.ts'
import { isValidCron, nextFireAt } from '../../utils/scheduleRunner.ts'
import { loadWorkflowSteps } from '../../utils/workflowRunStore.ts'
import { scheduleWorkspace } from '../../utils/scheduleRunStarter.ts'
import { resolveParameters, RESERVED_PARAM_PROJECT_DIR } from '../../../shared/utils/workflowParameters.ts'
import { currentUser } from '../../utils/session'
import type { Schedule } from '../../../shared/types/schedule.ts'

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schedule'
}

/**
 * Creates or updates a schedule. `saveSchedule` is what forces a brand-new id
 * to `enabled: false`; this route resolves the id, fills defaults, and refuses
 * the three things that would otherwise fail silently at 2am with nobody
 * watching: an unparseable expression, a workflow that is not there, and a
 * workflow whose required inputs this schedule does not state.
 *
 * The input check is skipped for a save that DISABLES the schedule - see
 * below. Turning something off must always succeed.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<Partial<Schedule>>(event)
  const user = await currentUser(event)

  if (!body?.name?.trim()) throw createError({ statusCode: 400, message: 'name is required' })
  if (!body?.workflowSlug?.trim()) throw createError({ statusCode: 400, message: 'workflowSlug is required' })
  if (!body?.cron?.trim()) throw createError({ statusCode: 400, message: 'cron is required' })
  if (!body?.initialPrompt?.trim()) throw createError({ statusCode: 400, message: 'initialPrompt is required' })

  // Read ONCE for both the id dedupe and the stored-value fallbacks below.
  // Two reads of an unlocked file in one request can see two different states,
  // and then the record assembled from the second contradicts the id chosen
  // from the first.
  const all = await listSchedules()

  let id = body.id?.trim()
  if (!id) {
    const base = slugify(body.name)
    id = base
    let counter = 2
    while (all.some(s => s.id === id)) {
      id = `${base}-${counter}`
      counter++
    }
  }

  // Validated here, on save, while a person is looking at it. Deferring this
  // to fire time means the mistake surfaces as a schedule that simply never
  // ran, which is the hardest kind of bug to notice.
  const cron = body.cron.trim()
  // Falls back to the stored zone, like every other field: an edit form that
  // omits it must not silently move the schedule to server-local time, which
  // changes WHEN IT FIRES and would report nothing. An explicit empty string
  // is how a caller clears it back to local time.
  const stored = all.find(s => s.id === id)
  const timezone = body.timezone === undefined
    ? stored?.timezone
    : body.timezone.trim() || undefined
  if (!isValidCron(cron, timezone)) {
    throw createError({
      statusCode: 400,
      message: `"${cron}"${timezone ? ` in ${timezone}` : ''} is not a cron expression this server can parse`,
    })
  }

  const workflow = await loadWorkflowSteps(body.workflowSlug.trim())
  if (!workflow) {
    throw createError({ statusCode: 400, message: `There is no workflow "${body.workflowSlug.trim()}" on this instance` })
  }
  if (!workflow.steps.length) {
    throw createError({ statusCode: 400, message: `Workflow "${workflow.slug}" has no steps` })
  }

  const existing = stored
  // An existing owner is preserved: a second person retiming someone else's
  // schedule must not silently become the account its runs spend. Same rule
  // POST /api/watches states at length.
  const createdBy = existing?.createdBy ?? body.createdBy ?? user?.login

  // A projectDir value is not stored: the directory is derived from the id, so
  // keeping one would be storing a setting that does nothing. It is still
  // SUPPLIED to the check below as the directory this schedule will actually
  // use, so a workflow that declares projectDir as required stays schedulable -
  // see realScheduleStarter, which substitutes the same value at fire time.
  const { [RESERVED_PARAM_PROJECT_DIR]: _notStored, ...supplied } = body.parameters ?? existing?.parameters ?? {}
  // Skipped when the caller is turning the schedule OFF, and that exception is
  // the whole point of the branch: a workflow that gains a required input
  // leaves every existing schedule failing this check, and since setEnabled
  // round-trips the whole record, the disable toggle 400d too. The operator
  // could see the nightly error and had no way to stop it short of deleting
  // the schedule. Turning something off must always succeed.
  if (body.enabled !== false) {
    const { missing } = resolveParameters(workflow.parameters, {
      ...supplied,
      [RESERVED_PARAM_PROJECT_DIR]: scheduleWorkspace({ id, createdBy } as Schedule),
    })
    if (missing.length) {
      throw createError({
        statusCode: 400,
        message: `Workflow "${workflow.slug}" needs ${missing.join(', ')}; state ${missing.length === 1 ? 'it' : 'them'} on the schedule`,
        data: { missing },
      })
    }
  }

  // Every field falls back to the STORED value before the default, because
  // saveSchedule replaces the record wholesale: a partial body from an edit
  // form would otherwise reset the cron, the prompt and autoRun to plausible
  // values and nothing would report it. `??` not `||` - false is meaningful.
  const schedule: Schedule = {
    id,
    createdBy,
    name: body.name.trim(),
    workflowSlug: workflow.slug,
    cron,
    timezone,
    // A brand-new schedule is forced disabled by saveSchedule regardless; this
    // only decides what an UPDATE omitting `enabled` does, and the answer is
    // "leave it as it is" rather than "turn it off".
    enabled: body.enabled ?? existing?.enabled ?? false,
    initialPrompt: body.initialPrompt.trim(),
    parameters: supplied,
    autoRun: body.autoRun ?? existing?.autoRun ?? true,
  }

  const saved = await saveSchedule(schedule)
  return { ...saved, nextFireAt: nextFireAt(saved)?.toISOString() ?? null }
})
