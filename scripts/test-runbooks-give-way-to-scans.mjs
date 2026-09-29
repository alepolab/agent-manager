/**
 * Runbooks give the machine to the scans: while a scan is working no runbook
 * run starts, and one that is working steps aside at its next step boundary,
 * then carries on when the scans are done.
 *
 * Four Runbook A runs and two scans at once is more than 8 cores and 32 GB
 * hold without swapping, and the scans are the work with a deadline. So
 * runbooks got four slots on the condition that they yield to scans - decided
 * from the runs themselves each time, never on a schedule.
 *
 *   node scripts/test-runbooks-give-way-to-scans.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'yield-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'yield-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'yield-ws-'))
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
writeFileSync(join(process.env.CLAUDE_DIR, 'workflow-groups.json'), JSON.stringify([
  { id: 'default', name: 'Runbooks', maxConcurrent: 4, yieldsTo: 'scans' },
  { id: 'scans', name: 'Nightly scans', maxConcurrent: 2 },
]))

const runner = await import('../server/utils/workflowRunner.ts')
const store = await import('../server/utils/workflowRunStore.ts')
const queue = await import('../server/utils/runQueue.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const TIMEOUT = 15000

const save = (wf) => writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${wf.slug}.json`),
  JSON.stringify({ name: wf.name, description: '', group: wf.group, steps: wf.steps, createdAt: new Date().toISOString() }))
const runbook = { slug: 'runbook', name: 'Runbook', steps: [
  { id: 'a', agentSlug: 'agent-a', label: 'First', next: ['b'] },
  { id: 'b', agentSlug: 'agent-b', label: 'Second', next: [] },
] }
const scan = { slug: 'scan', name: 'Scan', group: 'scans', steps: [{ id: 's', agentSlug: 'agent-s', label: 'Scan', next: [] }] }
save(runbook); save(scan)

const gates = {}
const gate = (key) => { let open; const p = new Promise(r => { open = r }); gates[key] = { p, open }; return p }
const calls = []
let hold = null
runner.setAgentCaller(async (slug, input) => {
  calls.push(slug)
  const key = slug === 'agent-s' ? 'scan' : `${slug}:${input.match(/Run id: (\S+)/)?.[1]?.slice(0, 8)}`
  if (gates[key]) await gates[key].p
  if (hold && slug !== 'agent-s') await hold.p
  return `out ${slug}`
})
const until = async (fn, what) => {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 25)) }
  throw new Error(`timed out waiting for ${what}`)
}
const status = async id => (await store.getRun(id)).status

// ── Four runbooks at once when no scan is working ───────────────────────────
{
  let open; hold = { p: new Promise(r => { open = r }) }
  const started = []
  for (let i = 0; i < 5; i++) started.push((await runner.startOrQueue({ workflow: runbook, initialPrompt: `go ${i}`, watch: 'direct-invocation', autoRun: true, startedBy: `dev${i}` })))
  assert.deepEqual(started.map(s => s.queued), [false, false, false, false, true], 'four slots, the fifth waits')
  hold = null; open()
  for (const s of started) await runner.waitForSettled(s.run.id, TIMEOUT)
  for (const s of started) assert.equal(await status(s.run.id), 'completed')
}

// ── A scan starts: new runbooks wait, a working one steps aside ─────────────
{
  const working = (await runner.startOrQueue({ workflow: runbook, initialPrompt: 'working', watch: 'direct-invocation', autoRun: true, startedBy: 'devW' })).run
  const w8 = working.id.slice(0, 8)
  gate(`agent-a:${w8}`)
  await until(() => calls.includes('agent-a') && gates[`agent-a:${w8}`], 'the runbook to be in its first step')

  gate('scan')
  const s = await runner.startOrQueue({ workflow: scan, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true, startedBy: 'nightly' })
  assert.equal(s.queued, false, 'the scan starts at once')
  assert.equal(await queue.givingWayTo('default'), 'scans')

  const late = await runner.startOrQueue({ workflow: runbook, initialPrompt: 'late', watch: 'direct-invocation', autoRun: true, startedBy: 'devL' })
  assert.equal(late.queued, true, 'no runbook starts while a scan is working, though three slots are free')

  // The step in flight is not cut off: it finishes, then the run steps aside.
  assert.equal(await status(working.id), 'running')
  gates[`agent-a:${w8}`].open()
  await until(async () => (await status(working.id)) === 'queued', 'the runbook to step aside')
  const aside = await store.getRun(working.id)
  assert.equal(aside.parked.gaveWayTo, 'scans')
  assert.equal(aside.steps.find(x => x.stepId === 'a').status, 'completed', 'the step it had finished stays finished')
  assert.equal(aside.steps.find(x => x.stepId === 'b').status, 'pending', 'and nothing after it started')

  // The scan finishes: both runbooks go, the one that stepped aside first.
  gates.scan.open()
  await runner.waitForSettled(s.run.id, TIMEOUT)
  const done = await runner.waitForSettled(working.id, TIMEOUT)
  assert.equal(done.status, 'completed', done.error)
  assert.equal(done.steps.find(x => x.stepId === 'a').visits, 1, 'the finished step did not run again')
  assert.equal(done.parked, undefined)
  assert.equal((await runner.waitForSettled(late.run.id, TIMEOUT)).status, 'completed')
}

// ── A group with no yieldsTo is unaffected ──────────────────────────────────
{
  assert.equal(await queue.givingWayTo('scans'), undefined, 'scans give way to nothing')
}

// ── Saving caps from the Groups editor keeps it ─────────────────────────────
{
  const { replaceGroups, listGroups } = await import('../server/utils/workflowGroups.ts')
  await replaceGroups([{ id: 'default', name: 'Runbooks', maxConcurrent: 3 }, { id: 'scans', name: 'Nightly scans', maxConcurrent: 2 }])
  assert.equal((await listGroups()).find(g => g.id === 'default').yieldsTo, 'scans', 'the editor saves id, name and cap only')
  await replaceGroups([{ id: 'default', name: 'Runbooks', maxConcurrent: 3, yieldsTo: '' }, { id: 'scans', name: 'Nightly scans', maxConcurrent: 2 }])
  assert.equal((await listGroups()).find(g => g.id === 'default').yieldsTo, undefined, 'an empty value clears it')
}

console.log('ok - runbooks run four at once, and give way to scans at a step boundary')
process.exit(0)
