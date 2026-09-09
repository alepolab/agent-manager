/**
 * Self-check for the cron scheduler.
 *
 * The requirements it exists to keep true: a schedule fires on its expression
 * and not before it is enabled; editing the expression retimes rather than
 * accumulating a second job; one unparseable entry cannot stop the others; and
 * a schedule whose own previous run is still going records a SKIP, not a
 * failure, because a nightly scan has a next fire by definition.
 *
 *   node scripts/test-schedule-runner.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'sched-cron-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'sched-cron-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'sched-cron-workspaces-'))

const sched = await import('../server/utils/scheduleRunner.ts')
const config = await import('../server/utils/scheduleConfig.ts')
const state = await import('../server/utils/scheduleState.ts')
const starterMod = await import('../server/utils/scheduleRunStarter.ts')
const runner = await import('../server/utils/workflowRunner.ts')
const store = await import('../server/utils/workflowRunStore.ts')

const base = {
  id: 's1', name: 'S1', workflowSlug: 'demo', cron: '0 2 * * *',
  enabled: true, initialPrompt: 'scan it', autoRun: true, createdBy: 'test-owner',
}

// ══ 1. expression validation and next fire ════════════════════════════════
{
  assert.ok(sched.isValidCron('0 2 * * *'), 'a five-field expression is fine')
  assert.ok(sched.isValidCron('*/5 * * * * *'), 'so is a six-field one')
  assert.ok(!sched.isValidCron('not a cron'), 'gibberish is refused')
  assert.ok(!sched.isValidCron('99 * * * *'), 'so is an out-of-range field')

  const next = sched.nextFireAt(base)
  assert.ok(next instanceof Date, 'a valid expression has a next fire')
  assert.ok(next.getTime() > Date.now(), 'which is in the future')
  assert.equal(sched.nextFireAt({ ...base, cron: 'nonsense' }), null,
    'an expression that will not parse reports no next fire rather than throwing')

  // The zone is part of the identity, not decoration: the same pattern in two
  // zones is two different firing times.
  const kolkata = sched.nextFireAt({ ...base, timezone: 'Asia/Kolkata' })
  const utc = sched.nextFireAt({ ...base, timezone: 'UTC' })
  assert.notEqual(kolkata.getTime(), utc.getTime(), 'the timezone changes when it fires')
}

// ══ 2. reconcile: enabled, disabled, retimed, deleted ═════════════════════
{
  let source = []
  sched.setScheduleSource(() => source)
  sched.setScheduleStarter(async () => ({ lastOutcome: 'started', lastRunId: 'stub' }))

  await sched.reconcileSchedulesNow()
  assert.deepEqual(sched.scheduledIds(), [], 'nothing scheduled when nothing is configured')

  source = [{ ...base, enabled: false }]
  await sched.reconcileSchedulesNow()
  assert.deepEqual(sched.scheduledIds(), [], 'a disabled schedule gets no job')

  source = [{ ...base, enabled: true }]
  await sched.reconcileSchedulesNow()
  assert.deepEqual(sched.scheduledIds(), ['s1'], 'enabling it schedules it, without a restart')

  // THE REQUIREMENT: a retime replaces the job. Accumulating a second one
  // would fire the schedule twice per period, forever, invisibly.
  source = [{ ...base, cron: '0 3 * * *' }]
  await sched.reconcileSchedulesNow()
  assert.deepEqual(sched.scheduledIds(), ['s1'], 'editing the expression retimes rather than adding a job')

  source = [{ ...base, cron: '0 3 * * *', timezone: 'UTC' }]
  await sched.reconcileSchedulesNow()
  assert.deepEqual(sched.scheduledIds(), ['s1'], 'so does changing only the timezone')

  source = [{ ...base, enabled: false }]
  await sched.reconcileSchedulesNow()
  assert.deepEqual(sched.scheduledIds(), [], 'disabling stops the job')

  source = [{ ...base, enabled: true }]
  await sched.reconcileSchedulesNow()
  source = []
  await sched.reconcileSchedulesNow()
  assert.deepEqual(sched.scheduledIds(), [], 'a deleted schedule leaves no orphaned job')

  sched.stopScheduleRunner()
}

// ══ 3. one unusable expression must not cost the others ═══════════════════
{
  sched.setScheduleSource(() => [
    { ...base, id: 'broken', cron: 'not a cron' },
    { ...base, id: 'fine-1' },
    { ...base, id: 'fine-2' },
  ])
  sched.setScheduleStarter(async () => ({ lastOutcome: 'started', lastRunId: 'stub' }))

  await sched.reconcileSchedulesNow()
  assert.deepEqual(sched.scheduledIds().sort(), ['fine-1', 'fine-2'],
    'the two healthy schedules are scheduled even though the FIRST one is broken')

  const broken = await state.getScheduleState('broken')
  assert.equal(broken.lastOutcome, 'error', 'and the broken one says so where the page will show it')
  assert.match(broken.lastDetail, /cannot be parsed/)

  sched.stopScheduleRunner()
}

// ══ 4. fireSchedule never throws ══════════════════════════════════════════
{
  sched.setScheduleStarter(async () => { throw new Error('starter exploded') })
  const outcome = await sched.fireSchedule({ ...base, id: 'boom' })
  assert.equal(outcome.lastOutcome, 'error',
    'a starter that throws becomes a recorded error, not an unhandled rejection in a cron callback')
  assert.match(outcome.lastDetail, /starter exploded/)
  assert.ok(outcome.lastFiredAt > 0, 'and the attempt is still timestamped')
}

// ══ 5. the real starter ═══════════════════════════════════════════════════
{
  const wfDir = join(process.env.CLAUDE_DIR, 'workflows')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, 'demo.json'), JSON.stringify({
    name: 'Demo',
    parameters: [{ name: 'jira_project', required: true }, { name: 'severity', default: 'medium' }],
    steps: [{ id: 'a', agentSlug: 'agent-a', label: 'A', next: [] }],
  }))
  writeFileSync(join(wfDir, 'no-inputs.json'), JSON.stringify({
    name: 'No Inputs',
    steps: [{ id: 'a', agentSlug: 'agent-a', label: 'A', next: [] }],
  }))

  runner.setAgentCaller(async agentSlug => `output of ${agentSlug}`)

  // ── 5a. a missing workflow is an error, not a crash ─────────────────────
  const gone = await starterMod.realScheduleStarter({ ...base, id: 'gone', workflowSlug: 'nope' })
  assert.equal(gone.lastOutcome, 'error')
  assert.match(gone.lastDetail, /no longer exists/)

  // ── 5b. a required input the schedule does not state ───────────────────
  const bare = await starterMod.realScheduleStarter({ ...base, id: 'bare', parameters: {} })
  assert.equal(bare.lastOutcome, 'error', 'an unstated required input starts no run')
  assert.match(bare.lastDetail, /needs jira_project/)
  assert.equal(bare.lastRunId, undefined, 'and there is no run to point at')

  // ── 5c. the happy path ─────────────────────────────────────────────────
  const s = { ...base, id: 'nightly', parameters: { jira_project: 'DEVOPS' } }
  const started = await starterMod.realScheduleStarter(s)
  assert.equal(started.lastOutcome, 'started', started.lastDetail ?? '')
  const run = await store.getRun(started.lastRunId)

  assert.equal(run.watch, 'schedule:nightly',
    'the run says what triggered it - neither a watch nor direct-invocation')
  assert.deepEqual(run.parameters, { jira_project: 'DEVOPS', severity: 'medium' },
    'the stated input plus the declaration default')
  assert.equal(run.projectDir, starterMod.scheduleWorkspace(s),
    'it works in its own derived directory')
  assert.match(run.projectDir, /nightly/, 'named after the schedule')
  assert.equal(run.startedBy, 'test-owner', 'under its owner, whose tokens its agents get')

  // ── 5d. a stated projectDir is replaced by the derived one, not honoured ─
  const pinned = { ...base, id: 'pinned', parameters: { jira_project: 'DEVOPS', projectDir: '/somewhere/else' } }
  const wontMove = await starterMod.realScheduleStarter(pinned)
  const pinnedRun = await store.getRun(wontMove.lastRunId)
  assert.notEqual(pinnedRun.projectDir, '/somewhere/else',
    'a schedule cannot be aimed at a directory: that is the point of deriving it')
  assert.equal(pinnedRun.projectDir, starterMod.scheduleWorkspace(pinned))
  assert.equal(pinnedRun.parameters.projectDir, undefined,
    'and the value it asked for is not stated to the agents either, which would be a lie')

  // ── 5e. THE TRAP: a workflow that REQUIRES projectDir stays schedulable ──
  // Stripping the key looked equivalent to substituting the derived directory
  // and was not: it left a required parameter with no value, so this workflow
  // could never be scheduled at all - and the run was always going to work in
  // the derived directory regardless.
  writeFileSync(join(wfDir, 'needs-dir.json'), JSON.stringify({
    name: 'Needs Dir',
    parameters: [{ name: 'projectDir', required: true }],
    steps: [{ id: 'a', agentSlug: 'agent-a', label: 'A', next: [] }],
  }))
  const needsDir = { ...base, id: 'needs-dir', workflowSlug: 'needs-dir', parameters: {} }
  const dirRun = await starterMod.realScheduleStarter(needsDir)
  assert.equal(dirRun.lastOutcome, 'started',
    `a workflow requiring projectDir is satisfied by the derived directory (${dirRun.lastDetail ?? ''})`)
  const satisfied = await store.getRun(dirRun.lastRunId)
  assert.equal(satisfied.parameters.projectDir, starterMod.scheduleWorkspace(needsDir),
    'and the agents are told the same directory they actually work in')
  assert.equal(satisfied.projectDir, satisfied.parameters.projectDir,
    'the stated value and the run directory are one answer, not two')
  await runner.waitForSettled(dirRun.lastRunId, 5000)

  await runner.waitForSettled(started.lastRunId, 5000)
  await runner.waitForSettled(wontMove.lastRunId, 5000)
}

// ══ 6. THE REQUIREMENT: overlap with its own run is a skip, not a failure ══
{
  runner.setAgentCaller((agentSlug, input, projectDir, { signal } = {}) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(`late ${agentSlug}`), 4000)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
  }))

  const s = { ...base, id: 'slow', parameters: { jira_project: 'DEVOPS' } }
  const first = await starterMod.realScheduleStarter(s)
  assert.equal(first.lastOutcome, 'started')

  const second = await starterMod.realScheduleStarter(s)
  assert.equal(second.lastOutcome, 'skipped',
    'the next fire while its own run is live is skipped - never queued behind itself')
  assert.equal(second.lastRunId, first.lastRunId, 'and points at the run that is holding the directory')
  assert.match(second.lastDetail, /still working in/)

  await runner.stopRun(first.lastRunId)
  await runner.waitForSettled(first.lastRunId, 5000)

  // Once it settles, the directory is free again.
  runner.setAgentCaller(async agentSlug => `output of ${agentSlug}`)
  const third = await starterMod.realScheduleStarter(s)
  assert.equal(third.lastOutcome, 'started', 'the fire after it settles starts normally')
  await runner.waitForSettled(third.lastRunId, 5000)
}

// ══ 7. the config store ═══════════════════════════════════════════════════
{
  assert.deepEqual(await config.listSchedules(), [], 'no file reads back as nothing scheduled')

  const created = await config.saveSchedule({ ...base, id: 'new-one', enabled: true })
  assert.equal(created.enabled, false,
    'a brand-new schedule is forced disabled however it was created - it must not fire on tick one')

  const enabled = await config.saveSchedule({ ...created, enabled: true })
  assert.equal(enabled.enabled, true, 'a second save against the same id is how enabling happens')
  assert.equal((await config.listSchedules()).length, 1, 'and it replaced rather than appended')

  writeFileSync(join(process.env.CLAUDE_DIR, 'schedules.json'), '{ not json')
  assert.deepEqual(await config.listSchedules(), [],
    'a corrupt config degrades to nothing scheduled rather than crashing the supervisor')

  await config.saveSchedule({ ...base, id: 'doomed' })
  assert.equal(await config.deleteSchedule('doomed'), true)
  assert.equal(await config.deleteSchedule('doomed'), false, 'deleting twice is not an error')
}

// ══ 8. real timers: a schedule enabled after start fires on its own ═══════
{
  let live = []
  const fired = []
  sched.setScheduleSource(() => live)
  sched.setScheduleStarter(async s => { fired.push(s.id); return { lastOutcome: 'started', lastRunId: 'stub' } })

  sched.startScheduleRunner(50) // fast supervisor so the test does not wait on a production cadence

  await new Promise(r => setTimeout(r, 200))
  assert.equal(fired.length, 0, 'nothing fires before any schedule exists')

  // Every second, six-field. The point is that no restart was needed.
  live = [{ ...base, id: 'ticker', cron: '* * * * * *', enabled: true }]

  await new Promise(r => setTimeout(r, 3500))
  assert.ok(fired.length >= 2,
    `a schedule enabled after startScheduleRunner() fires on its own timer (observed ${fired.length})`)

  live = []
  const settled = fired.length
  await new Promise(r => setTimeout(r, 1500))
  assert.equal(fired.length, settled, 'and stops firing once it is deleted')

  sched.stopScheduleRunner()
}

// ══ 9. state store ════════════════════════════════════════════════════════
{
  const written = await state.recordScheduleFire('st-1', { lastOutcome: 'started', lastRunId: 'r1' })
  assert.equal(written.lastRunId, 'r1')
  assert.ok(written.lastFiredAt > 0, 'a fire is always timestamped')
  assert.deepEqual(await state.getScheduleState('st-1'), written, 'and reads back')

  assert.deepEqual(await state.getScheduleState('never-fired'), {},
    'a schedule that never fired reads back empty rather than throwing')

  writeFileSync(join(process.env.CLAUDE_DIR, 'schedule-state', 'st-1.json'), 'not json')
  assert.deepEqual(await state.getScheduleState('st-1'), {}, 'a corrupt state file reads back empty')

  assert.equal(await state.deleteScheduleState('st-1'), true)
  assert.equal(existsSync(join(process.env.CLAUDE_DIR, 'schedule-state', 'st-1.json')), false)
  assert.equal(await state.deleteScheduleState('st-1'), false, 'deleting twice is not an error')
}

console.log('schedule runner: all assertions passed')
