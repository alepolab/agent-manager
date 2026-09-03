import { listWatches, saveWatch } from '../../utils/watchConfig.ts'
import type { Watch } from '../../../shared/types/watch.ts'

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

  const watch: Watch = {
    id,
    name: body.name.trim(),
    workflowSlug: body.workflowSlug.trim(),
    intervalSeconds: body.intervalSeconds ?? 300,
    enabled: body.enabled === true,
    maxConcurrentRuns: body.maxConcurrentRuns ?? 1,
    dailyDispatchCap: body.dailyDispatchCap ?? 20,
    query: body.query,
    projectDir: body.projectDir,
    autoRun: body.autoRun === true,
  }

  return await saveWatch(watch)
})
