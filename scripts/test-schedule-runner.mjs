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

  // ── 5d. a projectDir in `parameters` is not where a directory is stated ─
  // The FIELD steers a run (5g); a key in the parameters map does not. The
  // save route strips that key, so the only way to get one is a hand-edit of
  // schedules.json - which is exactly the path with no validation behind it.
  const pinned = { ...base, id: 'pinned', parameters: { jira_project: 'DEVOPS', projectDir: '/somewhere/else' } }
  const wontMove = await starterMod.realScheduleStarter(pinned)
  const pinnedRun = await store.getRun(wontMove.lastRunId)
  assert.notEqual(pinnedRun.projectDir, '/somewhere/else',
    'a directory in parameters is ignored: the projectDir FIELD is the one place it is stated')
  assert.equal(pinnedRun.projectDir, starterMod.scheduleWorkspace(pinned),
    'with no field set, the effective directory is still the derived one')
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

  // The same rule for the STATED case. This is the regression the field can
  // introduce: substituting the DERIVED path into the parameters while
  // starting the run in the stated one, so the agents are told to work
  // somewhere they are not.
  const statedDir = join(process.env.AGENT_WORKSPACE_ROOT, 'a-real-checkout')
  mkdirSync(statedDir, { recursive: true })
  const needsDirStated = { ...base, id: 'needs-dir-stated', workflowSlug: 'needs-dir', projectDir: statedDir, parameters: {} }
  const statedRes = await starterMod.realScheduleStarter(needsDirStated)
  assert.equal(statedRes.lastOutcome, 'started', statedRes.lastDetail ?? '')
  const statedRun = await store.getRun(statedRes.lastRunId)
  assert.equal(statedRun.projectDir, statedDir,
    'a required projectDir is satisfied by the directory the schedule STATES')
  assert.equal(statedRun.parameters.projectDir, statedDir,
    'and the agents are told that same directory - one answer holds for the stated case too')
  await runner.waitForSettled(statedRes.lastRunId, 5000)

  // ── 5f. THE TRAP: the directory a run is TOLD it works in must exist ────
  // callAgent resolves its cwd as
  // `projectDir && existsSync(projectDir) ? projectDir : claudeDir`, so a
  // directory that does not exist yet does not fail - it silently runs every
  // agent inside the Claude config directory, with bypassPermissions, while
  // the step header names the derived path. A schedule's derived directory has
  // never existed on its FIRST fire, which is every schedule exactly once.
  {
    const fresh = { ...base, id: 'never-fired-before', parameters: { jira_project: 'DEVOPS' } }
    const derived = starterMod.scheduleWorkspace(fresh)
    assert.ok(!existsSync(derived), 'precondition: the derived directory does not exist yet')
    const first = await starterMod.realScheduleStarter(fresh)
    assert.equal(first.lastOutcome, 'started', first.lastDetail ?? '')
    assert.ok(existsSync(derived),
      'the first fire creates its directory, so the agents are not silently run in ~/.claude')
    const freshRun = await store.getRun(first.lastRunId)
    assert.equal(freshRun.projectDir, derived,
      'and the run still records the directory its header names')
    await runner.waitForSettled(first.lastRunId, 5000)
  }

  // ── 5g. the directory a schedule STATES is where its runs work ──────────
  // Without this a scan workflow pointed at a checkout by hand would, on a
  // schedule, work in an empty derived directory and find nothing to scan.
  {
    const aimedDir = join(process.env.AGENT_WORKSPACE_ROOT, 'aimed-checkout')
    mkdirSync(aimedDir, { recursive: true })
    const aimed = { ...base, id: 'aimed', projectDir: aimedDir, parameters: { jira_project: 'DEVOPS' } }
    const res = await starterMod.realScheduleStarter(aimed)
    assert.equal(res.lastOutcome, 'started', res.lastDetail ?? '')
    const aimedRun = await store.getRun(res.lastRunId)
    assert.equal(aimedRun.projectDir, aimedDir, 'the directory a schedule states is where its runs work')
    assert.notEqual(aimedRun.projectDir, starterMod.scheduleWorkspace(aimed), 'and it is not the derived one')
    await runner.waitForSettled(res.lastRunId, 5000)

    // The resolver every caller shares. Three copies of this rule is how the
    // save pre-check, the page and the run lock drift apart.
    assert.equal(starterMod.scheduleProjectDir(aimed), aimedDir)
    assert.equal(starterMod.scheduleProjectDir(base), starterMod.scheduleWorkspace(base),
      'no field means derived')
    assert.equal(starterMod.scheduleProjectDir({ ...base, projectDir: '   ' }), starterMod.scheduleWorkspace(base),
      'whitespace is not a directory')
    assert.equal(starterMod.scheduleProjectDir({ ...base, projectDir: '/a', parameters: { projectDir: '/b' } }), '/a',
      'the field beats a parameters entry')
    assert.equal(starterMod.scheduleWorkspace({ ...base, projectDir: '/a' }), starterMod.scheduleWorkspace(base),
      'the DERIVED answer stays untainted by the field - the assertions above depend on it')

    // A stated directory that has gone missing is reported, not recreated: an
    // empty directory where a checkout used to be would scan nothing and pass.
    const gone = { ...base, id: 'gone', projectDir: join(process.env.AGENT_WORKSPACE_ROOT, 'deleted-checkout'), parameters: { jira_project: 'DEVOPS' } }
    const goneRes = await starterMod.realScheduleStarter(gone)
    assert.equal(goneRes.lastOutcome, 'error', 'a stated directory that no longer exists is an error')
    assert.match(goneRes.lastDetail, /does not exist/)
    assert.equal(goneRes.lastRunId, undefined, 'and no run was started')
  }

  // ── 5h. TWO schedules aimed at ONE checkout: the loser is skipped ───────
  // The safety claim the stated-directory decision rests on. The guard keys on
  // the directory (findRunInWorkspace), not on the schedule id, so it should
  // hold for two different schedules sharing one checkout.
  {
    runner.setAgentCaller((agentSlug, input, projectDir, { signal } = {}) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(`late ${agentSlug}`), 4000)
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
    }))
    const shared = join(process.env.AGENT_WORKSPACE_ROOT, 'shared-checkout')
    mkdirSync(shared, { recursive: true })
    const nightly = { ...base, id: 'shared-a', projectDir: shared, parameters: { jira_project: 'DEVOPS' } }
    const weekly = { ...base, id: 'shared-b', projectDir: shared, parameters: { jira_project: 'DEVOPS' } }
    const held = await starterMod.realScheduleStarter(nightly)
    assert.equal(held.lastOutcome, 'started', held.lastDetail ?? '')
    const blocked = await starterMod.realScheduleStarter(weekly)
    assert.equal(blocked.lastOutcome, 'skipped',
      'two schedules aimed at one checkout: the loser is skipped, not run concurrently over the same files')
    assert.equal(blocked.lastRunId, held.lastRunId,
      "and points at the OTHER schedule's run, so the skip is attributable")
    await runner.stopRun(held.lastRunId)
    await runner.waitForSettled(held.lastRunId, 5000)
    runner.setAgentCaller(async agentSlug => `output of ${agentSlug}`)
  }

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

// ══ 6b. THE REQUIREMENT: two SIMULTANEOUS fires cannot both start ═════════
//
// The check in section 6 reads PERSISTED runs, and startRun takes hundreds of
// milliseconds to persist one - captureBaseline alone spawns two git
// processes. Two fires inside that window both saw an idle directory and both
// proceeded, which is two runs editing one checkout: exactly the corruption
// the lock exists to prevent, reached by passing the lock.
{
  runner.setAgentCaller(async agentSlug => `output of ${agentSlug}`)
  const s = { ...base, id: 'racing', parameters: { jira_project: 'DEVOPS' } }

  // Started together, so neither can see the other's run record yet.
  const [a, b] = await Promise.all([
    starterMod.realScheduleStarter(s),
    starterMod.realScheduleStarter(s),
  ])
  const outcomes = [a.lastOutcome, b.lastOutcome].sort()
  assert.deepEqual(outcomes, ['skipped', 'started'],
    `exactly one of two simultaneous fires starts (observed ${outcomes.join(' + ')})`)

  const winner = a.lastOutcome === 'started' ? a : b
  const loser = a.lastOutcome === 'started' ? b : a
  assert.ok(loser.lastDetail, 'and the one that did not start says why')

  // The decisive assertion: one run in that directory, not two.
  const inDir = (await store.listRuns()).filter(r => r.projectDir === starterMod.scheduleWorkspace(s))
  assert.equal(inDir.length, 1, 'one run exists in the directory, not two racing over the same files')
  assert.equal(inDir[0].id, winner.lastRunId)
  await runner.waitForSettled(winner.lastRunId, 5000)
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
