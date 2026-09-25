/**
 * Interrupted runs resume within their group's cap.
 *
 * After a burst of server reloads, every interrupted run resumed at once: nine
 * Runbook A runs came back together against a cap of 2, each standing up a
 * ~2 GiB stack, and the machine ran out of memory and killed the server.
 *
 *   node scripts/test-resume-respects-cap.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'resume-cap-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'resume-cap-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'resume-cap-ws-'))
process.env.AGENT_MAX_CONCURRENT_PIPELINES = '2'
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const store = await import('../server/utils/workflowRunStore.ts')
const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const TIMEOUT = 15000
const workflow = { slug: 'cap-demo', name: 'Cap demo', steps: [{ id: 'a', agentSlug: 'agent-a', label: 'A', next: [] }] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'cap-demo.json'),
  JSON.stringify({ name: workflow.name, description: '', steps: workflow.steps, createdAt: new Date().toISOString() }))

// Three runs frozen mid-step, as a dead process leaves them, oldest first.
runner.setAgentCaller(async () => 'done')
const ids = []
for (let i = 1; i <= 3; i++) {
  let r = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: `dev${i}` })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  Object.assign(r.steps[0], { status: 'running', visits: 1 })
  Object.assign(r, { status: 'interrupted', currentStepIds: ['a'], startedAt: Date.now() - (10 - i) * 1000 })
  await store.saveRun(r)
  runner._dropLive(r.id)
  ids.push(r.id)
}

// The resumed step is held open, so the two it resumes keep their slots.
let release
const held = new Promise(r => { release = r })
runner.setAgentCaller(async () => { await held; return 'done' })

const out = await runner.resumeInterruptedRuns()
assert.deepEqual(out.resumed, ids.slice(0, 2), `the two oldest resume: ${JSON.stringify(out)}`)
assert.deepEqual(out.waiting, [ids[2]], 'the third waits for a slot')
assert.equal((await store.getRun(ids[2])).status, 'interrupted', 'and is left as it was')
assert.equal((await store.getRun(ids[2])).interruptions ?? 0, 0, 'waiting for a slot is not another interruption')

// A slot frees: the waiting run is resumed, not left for a person to notice.
release()
const third = await runner.waitForSettled(ids[2], TIMEOUT)
assert.equal(third.status, 'completed', 'resumed when a run settled and finished')
for (const id of ids.slice(0, 2)) assert.equal((await runner.waitForSettled(id, TIMEOUT)).status, 'completed')

console.log('ok - interrupted runs resume within their group cap')
