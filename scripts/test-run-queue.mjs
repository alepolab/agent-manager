/**
 * Self-check for server/utils/runQueue.ts — the concurrency group cap and the
 * queue behind it.
 *
 * The properties this file exists to pin down:
 *
 *  1. Admission is SERIALISED. Two watch dispatches and a cron fire landing in
 *     one tick must not each read "one slot free" and all three start. That is
 *     the check-then-act race the queue's predecessor was written to close, and
 *     it is why no slot count is exported for a caller to act on.
 *  2. The order is a QUEUE. Oldest first, deterministic even when twenty
 *     children were queued in one synchronous loop and share a `queuedAt`.
 *  3. A blocked head does not starve the group. A run that cannot launch right
 *     now keeps its place and costs no slot; the drain tries the next one.
 *  4. Queued work is never silently dropped. The old queue dropped an item
 *     whose start threw, with only a log line.
 *
 *   node scripts/test-run-queue.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'run-queue-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'run-queue-artifacts-'))
delete process.env.AGENT_MAX_CONCURRENT_PIPELINES

const store = await import('../server/utils/workflowRunStore.ts')
const groups = await import('../server/utils/workflowGroups.ts')
const queue = await import('../server/utils/runQueue.ts')

const STEPS = [{ stepId: 's1', label: 'Intake', agentSlug: 'sdlc-ticket-intake' }]

/** One run in whatever state the case needs. */
async function mk({ status = 'running', group, slug = 'w', parentRunId, projectDir } = {}) {
  const run = await store.createRun({
    workflowSlug: slug, workflowName: slug.toUpperCase(), autoRun: true,
    watch: 'direct-invocation', initialPrompt: 'x', steps: STEPS,
    group, parentRunId, projectDir,
    status: status === 'queued' ? 'queued' : 'running',
  })
  if (status !== 'running' && status !== 'queued') {
    run.status = status
    await store.saveRun(run)
  }
  return run
}

/** Rewrites a queued run's queuedAt, to build the tie cases the real dispatch
 *  step produces (twenty children, one synchronous loop, one millisecond). */
async function setQueuedAt(id, queuedAt) {
  const path = join(process.env.CLAUDE_DIR, 'workflow-runs', `${id}.json`)
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  raw.queuedAt = queuedAt
  writeFileSync(path, JSON.stringify(raw))
}

async function reset() {
  rmSync(join(process.env.CLAUDE_DIR, 'workflow-runs'), { recursive: true, force: true })
}

await groups.replaceGroups([
  { id: 'sdlc', name: 'SDLC pipelines', maxConcurrent: 2 },
  { id: 'scans', name: 'Nightly scans', maxConcurrent: 1 },
])

// ══ 1. what occupies a slot ═══════════════════════════════════════════════
{
  await mk({ status: 'running', group: 'sdlc' })
  await mk({ status: 'paused', group: 'sdlc' })
  await mk({ status: 'awaiting_review', group: 'sdlc' })
  await mk({ status: 'queued', group: 'sdlc' })
  await mk({ status: 'completed', group: 'sdlc' })
  await mk({ status: 'failed', group: 'sdlc' })
  await mk({ status: 'interrupted', group: 'sdlc' })
  await mk({ status: 'running', group: 'scans' })
  await mk({ status: 'running' })   // ungrouped

  // awaiting_review counts. A run stopped on a person still holds its working
  // directory and its clone; letting it hand the slot back would drain another
  // run onto the same machine while it waits.
  assert.equal(await queue.inFlightForGroup('sdlc'), 3,
    'running, paused and awaiting_review occupy slots; queued, completed, failed and interrupted do not')
  assert.equal(await queue.inFlightForGroup('scans'), 1, 'a group counts only its own runs')
  assert.equal(await queue.inFlightForGroup('default'), 1,
    'an ungrouped run counts against the default group, not against nothing')

  // A manual run occupies a slot too. The cap is a statement about the
  // machine, and a developer's run uses the same clones and agent budget.
  await reset()
  await mk({ status: 'running', group: 'sdlc', parentRunId: undefined })
  assert.equal(await queue.inFlightForGroup('sdlc'), 1,
    'a run nothing dispatched still occupies a slot - this is what the old parentRunId filter got wrong')
  await reset()
}

// ══ 2. admission ══════════════════════════════════════════════════════════
{
  const started = () => mk({ status: 'running', group: 'sdlc' })
  const queued = () => mk({ status: 'queued', group: 'sdlc' })

  const a = await queue.admit({ group: 'sdlc', start: started, enqueue: queued })
  assert.equal(a.queued, false, 'an empty group starts the run now')

  const b = await queue.admit({ group: 'sdlc', start: started, enqueue: queued })
  assert.equal(b.queued, false, 'so does the second, under a cap of 2')

  const c = await queue.admit({ group: 'sdlc', start: started, enqueue: queued })
  assert.equal(c.queued, true, 'the third is queued')
  assert.equal(c.run.status, 'queued')

  // THE REQUIREMENT: no overtaking. A slot freeing does not let a newcomer
  // jump the run that has been waiting.
  const one = (await store.listRuns()).find(r => r.status === 'running')
  one.status = 'completed'
  await store.saveRun(one)
  const d = await queue.admit({ group: 'sdlc', start: started, enqueue: queued })
  assert.equal(d.queued, true,
    'a free slot with something already waiting still queues - a queue that lets later arrivals overtake is not a queue')

  assert.equal(await queue.inFlightForGroup('scans'), 0, 'a full sdlc says nothing about scans')
  const e = await queue.admit({ group: 'scans', start: () => mk({ status: 'running', group: 'scans' }), enqueue: () => mk({ status: 'queued', group: 'scans' }) })
  assert.equal(e.queued, false, 'groups are independent')
  await reset()
}

// ══ 3. THE RACE: twenty simultaneous admissions ═══════════════════════════
{
  // Every one of these reads the run list before any of them has written a
  // run. Unserialised, all twenty would see two free slots and start.
  const results = await Promise.all(Array.from({ length: 20 }, () => queue.admit({
    group: 'sdlc',
    start: () => mk({ status: 'running', group: 'sdlc' }),
    enqueue: () => mk({ status: 'queued', group: 'sdlc' }),
  })))
  assert.equal(results.filter(r => !r.queued).length, 2,
    'exactly maxConcurrent started, whatever the arrival pattern')
  assert.equal(results.filter(r => r.queued).length, 18, 'and the rest are queued, not lost')
  assert.equal(await queue.inFlightForGroup('sdlc'), 2)
  await reset()
}

// ══ 4. the order is a queue, and ties are deterministic ═══════════════════
{
  const ids = []
  for (let i = 0; i < 5; i++) ids.push((await mk({ status: 'queued', group: 'sdlc' })).id)
  // Every one queued in the same millisecond, which is what a dispatch step
  // that builds twenty children in one loop actually produces.
  for (const id of ids) await setQueuedAt(id, 1_700_000_000_000)

  const order = (await queue.waiting('sdlc')).map(r => r.id)
  assert.deepEqual(order, [...ids].sort(),
    'identical queuedAt falls back to the id: arbitrary, but stable and testable rather than readdir order')

  // An older one, whenever it arrives in the directory listing, is still first.
  await setQueuedAt(ids[4], 1_600_000_000_000)
  assert.equal((await queue.waiting('sdlc'))[0].id, ids[4], 'oldest queuedAt first')
  assert.equal(await queue.position(await store.getRun(ids[4])), 1, 'and its position says so')
  await reset()
}

// ══ 5. draining ═══════════════════════════════════════════════════════════
{
  const ids = []
  for (let i = 0; i < 4; i++) {
    const r = await mk({ status: 'queued', group: 'sdlc' })
    await setQueuedAt(r.id, 1_700_000_000_000 + i)
    ids.push(r.id)
  }

  const launched = []
  const launch = async (run) => {
    launched.push(run.id)
    run.status = 'running'
    await store.saveRun(run)
    return 'launched'
  }

  assert.equal(await queue.drainRunQueue(launch), 2, 'the drain fills the free slots and no more')
  assert.deepEqual(launched, [ids[0], ids[1]], 'oldest first')

  assert.equal(await queue.drainRunQueue(launch), 0, 'a full group starts nothing')

  // One finishes; exactly one waiter starts.
  const first = await store.getRun(ids[0])
  first.status = 'completed'
  await store.saveRun(first)
  assert.equal(await queue.drainRunQueue(launch), 1, 'a settling run hands its slot to the next waiter')
  assert.deepEqual(launched, [ids[0], ids[1], ids[2]])
  await reset()
}

// ══ 6. a blocked head keeps its place and does not starve the group ═══════
{
  // THE REQUIREMENT. A queued run whose working directory is busy has lost no
  // race it entered: it must stay queued. But stopping the drain at it would
  // mean one permanently blocked run holds up every run behind it forever.
  const head = await mk({ status: 'queued', group: 'scans' })
  await setQueuedAt(head.id, 1_700_000_000_000)
  const next = await mk({ status: 'queued', group: 'scans' })
  await setQueuedAt(next.id, 1_700_000_000_001)

  const seen = []
  const launch = async (run) => {
    seen.push(run.id)
    if (run.id === head.id) return 'deferred'
    run.status = 'running'
    await store.saveRun(run)
    return 'launched'
  }

  assert.equal(await queue.drainRunQueue(launch), 1, 'the group with one slot still started one run')
  assert.deepEqual(seen, [head.id, next.id], 'the head was tried first, then skipped rather than stopped at')
  assert.equal((await store.getRun(head.id)).status, 'queued',
    'and the deferred run is STILL QUEUED - a deferral is not a failure and not a drop')
  await reset()
}

// ══ 7. a launcher that throws leaves the run queued, never dropped ════════
{
  const r = await mk({ status: 'queued', group: 'scans' })
  assert.equal(await queue.drainRunQueue(async () => { throw new Error('disk on fire') }), 0)
  assert.equal((await store.getRun(r.id)).status, 'queued',
    'THE REGRESSION: the previous queue dropped an item whose start threw, with only a log line')
  await reset()
}

// ══ 8. a permanent failure leaves the queue and frees nothing ═════════════
{
  const bad = await mk({ status: 'queued', group: 'scans' })
  await setQueuedAt(bad.id, 1_700_000_000_000)
  const good = await mk({ status: 'queued', group: 'scans' })
  await setQueuedAt(good.id, 1_700_000_000_001)

  const launch = async (run) => {
    if (run.id === bad.id) {
      run.status = 'failed'
      run.error = 'the workflow was deleted while this run waited for a slot'
      await store.saveRun(run)
      return 'failed'
    }
    run.status = 'running'
    await store.saveRun(run)
    return 'launched'
  }
  assert.equal(await queue.drainRunQueue(launch), 1,
    'a run that can never start costs no slot, so the one behind it starts in the same sweep')
  assert.equal((await store.getRun(bad.id)).status, 'failed', 'and its reason is on the record, not in a log')
  await reset()
}

// ══ 9. two concurrent drains launch each run exactly once ═════════════════
{
  const ids = []
  for (let i = 0; i < 3; i++) {
    const r = await mk({ status: 'queued', group: 'sdlc' })
    await setQueuedAt(r.id, 1_700_000_000_000 + i)
    ids.push(r.id)
  }
  const launched = []
  const launch = async (run) => {
    launched.push(run.id)
    run.status = 'running'
    await store.saveRun(run)
    return 'launched'
  }
  // A run settling while a timer sweep is already under way.
  const [a, b] = await Promise.all([queue.drainRunQueue(launch), queue.drainRunQueue(launch)])
  assert.equal(a + b, 2, 'between them they filled the two slots')
  assert.equal(new Set(launched).size, launched.length, 'and no run was launched twice')
  await reset()
}

// ══ 10. the sweep goes quiet when nothing is waiting ══════════════════════
{
  assert.equal(await queue.drainRunQueue(async () => 'launched'), 0)
  assert.equal(queue.mightHaveWaiting(), false,
    'an empty sweep tells the timer to stop paying for listRuns every minute')
  queue.noteQueued()
  assert.equal(queue.mightHaveWaiting(), true, 'and enqueueing wakes it')
}

// ══ 11. an unknown group still has the default cap ════════════════════════
{
  await mk({ status: 'running', group: 'never-configured' })
  const r = await queue.admit({
    group: 'never-configured',
    start: () => mk({ status: 'running', group: 'never-configured' }),
    enqueue: () => mk({ status: 'queued', group: 'never-configured' }),
  })
  assert.equal(r.queued, false, 'one of the default cap of 2 was free')
  const full = await queue.admit({
    group: 'never-configured',
    start: () => mk({ status: 'running', group: 'never-configured' }),
    enqueue: () => mk({ status: 'queued', group: 'never-configured' }),
  })
  assert.equal(full.queued, true,
    'a group name nobody configured is capped at the default, never treated as unlimited')

  const load = await queue.groupLoad('never-configured')
  assert.deepEqual(load, { group: 'never-configured', inFlight: 2, waiting: 1, maxConcurrent: 2 })
  await reset()
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
console.log('runQueue: all assertions passed')
