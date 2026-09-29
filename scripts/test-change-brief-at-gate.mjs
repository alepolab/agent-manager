/**
 * A change that reaches an approval gate without a brief of what approving it
 * gains and risks gets one from the step that made it, after the pause.
 *
 * ASECRM-288's approval showed commits and files, and the person approving
 * still had to read a 200-line plan to learn the advantages and disadvantages.
 * Seven other gates open that day had the same gap.
 *
 *   node scripts/test-change-brief-at-gate.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'brief-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'brief-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'brief-ws-'))
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const runner = await import('../server/utils/workflowRunner.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const wf = { slug: 'gated', name: 'Gated', steps: [
  { id: 'fix', agentSlug: 'sdlc-fix-implementer', label: 'Implement Fix', next: ['done'] },
  { id: 'done', agentSlug: 'sdlc-jira-tracker-stub', label: 'Jira: Dev Done', next: [], approval: true },
] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'gated.json'), JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))

const BRIEF = {
  question: 'Approve X-1: the change?', situation: 'The ticket asked for a thing; this does it.',
  findings: ['30/30 tests pass'],
  options: [
    { key: 'a', label: 'Approve', next: 'Dev Done', delivers: 'the fix', leaves: 'nothing', risk: 'low' },
    { key: 'b', label: 'Send back', next: 'Implement Fix again', delivers: 'another look', leaves: 'the bug' },
  ],
  recommendation: { option: 'a', why: 'it works' },
}
const asks = []
let writeGood = true
runner.setAgentCaller(async (slug, input) => {
  if (slug === 'sdlc-fix-implementer' && /reviewer's brief/.test(input)) {
    asks.push(input)
    const dir = input.match(/Write every artifact you produce into: (\S+)/)?.[1] ?? dirOf
    // While it is being written, the card can see that it is.
    assert.ok(existsSync(join(dir, 'change-brief.pending')), 'marked as being written')
    writeFileSync(join(dir, 'change-brief.json'), JSON.stringify(writeGood ? BRIEF : { question: 'q' }))
    return 'written'
  }
  return `out ${slug}`
})
let dirOf

const settle = async (id) => {
  for (let i = 0; i < 200 && !existsSync(join(runArtifactsDir(id), 'change-brief.json')); i++) await new Promise(r => setTimeout(r, 25))
  for (let i = 0; i < 200 && existsSync(join(runArtifactsDir(id), 'change-brief.pending')); i++) await new Promise(r => setTimeout(r, 25))
}

// ── At the gate ──────────────────────────────────────────────────────────────
{
  let run = (await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev1' })).run
  dirOf = runArtifactsDir(run.id)
  run = await runner.waitForSettled(run.id, 8000)
  assert.equal(run.status, 'paused', 'the gate pauses first: the brief never holds the run')
  assert.equal(run.question.kind, 'approval')
  await settle(run.id)
  assert.equal(asks.length, 1, 'the step that made the change was asked for its brief')
  assert.match(asks[0], /Do not edit, stage or commit anything/)
  assert.ok(existsSync(join(dirOf, 'change-brief.json')))
  assert.ok(!existsSync(join(dirOf, 'change-brief.pending')), 'the marker goes when it is done')

  // Once there, it is not asked for again.
  assert.equal(await runner.ensureChangeBrief(await runner.waitForSettled(run.id, 100)), 'present')
  assert.equal(asks.length, 1)
}

// ── A gate already waiting, at boot; an unusable brief is asked for again once ─
{
  writeGood = false
  let run = (await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev2' })).run
  dirOf = runArtifactsDir(run.id)
  run = await runner.waitForSettled(run.id, 8000)
  await settle(run.id)
  const before = asks.length
  assert.ok(before >= 2, 'asked')
  rmSync(join(dirOf, 'change-brief.json'), { force: true })
  // As a server stopped mid-write leaves it.
  const stale = (await runner.startOrQueue({ workflow: { ...wf, steps: [wf.steps[0]] }, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev3' })).run
  await runner.waitForSettled(stale.id, 8000)
  writeFileSync(join(runArtifactsDir(stale.id), 'change-brief.pending'), 'then')
  writeGood = true
  const written = await runner.backfillChangeBriefs()
  assert.deepEqual(written, [run.id], 'the waiting gate without a usable brief got one at boot')
  assert.ok(!existsSync(join(dirOf, 'change-brief.pending')))
  assert.ok(!existsSync(join(runArtifactsDir(stale.id), 'change-brief.pending')), 'a stale marker is cleared at boot')
}

console.log('ok - a change waiting at a gate gets a brief of its advantages and disadvantages from the step that made it')
process.exit(0)
