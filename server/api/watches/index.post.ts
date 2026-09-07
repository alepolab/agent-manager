import { listWatches, saveWatch } from '../../utils/watchConfig.ts'
import type { Watch } from '../../../shared/types/watch.ts'
import { currentUser } from '../../utils/session'

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'watch'
}

/**
 * Creates or updates a watch. `saveWatch` (T4) is what actually forces a
 * brand-new watch id to `enabled: false` regardless of what is passed here —
 * this route just resolves an id for a create (slugified from the name,
 * de-duped against existing watches) and fills sane defaults for the caps
 * so a minimal `{ name, workflowSlug }` body is enough to get started.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<Partial<Watch>>(event)
  const user = await currentUser(event)
  if (user && !body.createdBy) body.createdBy = user.login
  if (!body?.name?.trim()) {
    throw createError({ statusCode: 400, message: 'name is required' })
  }
  if (!body?.workflowSlug?.trim()) {
    throw createError({ statusCode: 400, message: 'workflowSlug is required' })
  }

  let id = body.id?.trim()
  if (!id) {
    const existing = await listWatches()
    const base = slugify(body.name)
    id = base
    let counter = 2
    while (existing.some(w => w.id === id)) {
      id = `${base}-${counter}`
      counter++
    }
  }

  // The owner, and why it is read back rather than taken from the body.
  //
  // Line ~21 above has always computed `createdBy` from the signed-in user, and
  // this object literal has always been built without it — so the value was
  // computed and dropped on the floor at every save, create and enable alike.
  // Every watch on every instance therefore carried `createdBy: undefined`, and
  // a watch with no owner dispatches runs with no identity: `envForUser` finds
  // no profile, no GH_TOKEN reaches the agent, and the provisioner halts on
  // `git clone ... exit 128`. The whole unattended path was dead, and the only
  // symptom was a clone failure eight minutes into a run.
  //
  // An existing owner is preserved: a second person enabling or retiming
  // someone else's watch must not silently become the account its runs spend.
  const existing = (await listWatches()).find(w => w.id === id)
  const createdBy = existing?.createdBy ?? body.createdBy

  // Every field falls back to the STORED value before the default.
  //
  // `saveWatch` replaces the record wholesale, so a caller that omits a field
  // does not leave it alone - it resets it. That was survivable while the only
  // update path was the enabled toggle, which round-trips the entire watch. An
  // edit form does not: a partial body would silently reset the poll interval
  // to 300, the cap to 20, and autoRun to false, and nothing would report it
  // because every one of those is a plausible value.
  //
  // `??` and not `||`: 0 and false are meaningful here, and `||` would discard
  // both in favour of the default.
  const watch: Watch = {
    id,
    createdBy,
    name: body.name.trim(),
    workflowSlug: body.workflowSlug.trim(),
    intervalSeconds: body.intervalSeconds ?? existing?.intervalSeconds ?? 300,
    // A brand-new watch is forced disabled by saveWatch regardless; this only
    // decides what an UPDATE that omits `enabled` does, and the answer is
    // "leave it as it is" rather than "turn it off".
    enabled: body.enabled ?? existing?.enabled ?? false,
    maxConcurrentRuns: body.maxConcurrentRuns ?? existing?.maxConcurrentRuns ?? 1,
    dailyDispatchCap: body.dailyDispatchCap ?? existing?.dailyDispatchCap ?? 20,
    query: body.query ?? existing?.query,
    projectDir: body.projectDir ?? existing?.projectDir,
    autoRun: body.autoRun ?? existing?.autoRun ?? false,
  }

  return await saveWatch(watch)
})
