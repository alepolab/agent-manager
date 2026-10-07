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
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
const askedOf = []
let writeGood = true
runner.setAgentCaller(async (slug, input) => {
  if ((slug === 'sdlc-fix-implementer' || slug === 'sdlc-ce-review') && /reviewer's brief/.test(input)) {
    asks.push(input)
    askedOf.push(slug)
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

// ── Intake left questions open: the brief answers each, or is asked for again ─
{
  let run = (await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev4' })).run
  dirOf = runArtifactsDir(run.id)
  run = await runner.waitForSettled(run.id, 8000)
  await settle(run.id)
  // ASECRM-297: two questions above a brief that answered neither.
  writeFileSync(join(dirOf, 'intent.md'), '# Intent\n\n## Open questions\n\n- Which branch row applies to security?\n- Are the other generators in scope?\n\n## Scope\n\n- one file\n')
  const before = asks.length
  BRIEF.open_questions = [{ question: 'Which branch row applies to security?', answer: 'develop, as every row' }, { question: 'Are the other generators in scope?', answer: 'No: send back to add them' }]
  assert.equal(await runner.ensureChangeBrief(run), 'written', 'a brief that answers none of them is not present')
  assert.equal(asks.length, before + 1)
  assert.match(asks.at(-1), /Intake left 2 question\(s\) open/)
  assert.match(asks.at(-1), /- Are the other generators in scope\?/, 'each question is named in the ask')
  assert.equal(await runner.ensureChangeBrief(run), 'present', 'answered, it is not asked for again')
  // One of them answered twice is not both answered: asked again, naming the missing one.
  BRIEF.open_questions = [BRIEF.open_questions[0], BRIEF.open_questions[0]]
  writeFileSync(join(dirOf, 'change-brief.json'), JSON.stringify(BRIEF))
  const good = [{ question: 'Which branch row applies to security?', answer: 'develop, as every row' }, { question: 'Are the other generators in scope?', answer: 'No: send back to add them' }]
  const fixed = { ...BRIEF, open_questions: good }
  const prev = asks.length
  BRIEF.open_questions = good
  writeFileSync(join(dirOf, 'change-brief.json'), JSON.stringify({ ...fixed, open_questions: [good[0], good[0]] }))
  assert.equal(await runner.ensureChangeBrief(run), 'written', 'a duplicated answer is not complete')
  assert.equal(asks.length, prev + 1)
  delete BRIEF.open_questions
}

// ── Code Review commits a fix after the implementer wrote its brief ──────────
// The brief was present, so the gate showed it - describing the code before
// the review changed it. A commit after the brief means it is asked for again,
// from the reviewer; a review that committed nothing leaves it standing.
{
  let run = (await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev5' })).run
  dirOf = runArtifactsDir(run.id)
  run = await runner.waitForSettled(run.id, 8000)
  await settle(run.id)
  const file = join(dirOf, 'change-brief.json')
  const repo = mkdtempSync(join(tmpdir(), 'brief-repo-'))
  const git = (args, at) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) } })
  git(['init', '-q'])
  const hourAgo = new Date(Date.now() - 3600_000)
  git(['commit', '-q', '--allow-empty', '-m', 'fix: the implementer'], hourAgo.toISOString())
  // The implementer's brief, written after its commit and before the review.
  const halfHourAgo = (Date.now() - 1800_000) / 1000
  utimesSync(file, halfHourAgo, halfHourAgo)
  const reviewed = { ...run, projectDir: repo, steps: [...run.steps,
    { stepId: 'review', agentSlug: 'sdlc-ce-review', label: 'Code Review', status: 'completed', output: '', visits: 1, startedAt: Date.now() - 60_000, completedAt: Date.now() }] }

  const before = asks.length
  assert.equal(await runner.ensureChangeBrief(reviewed), 'present', 'a review that committed nothing leaves the brief standing')
  assert.equal(asks.length, before)

  git(['commit', '-q', '--allow-empty', '-m', 'fix: review - a P1'])
  assert.equal(await runner.ensureChangeBrief(reviewed), 'written', 'THE GAP: a brief older than the review\'s commit was shown as present')
  assert.equal(askedOf.at(-1), 'sdlc-ce-review', 'asked of the reviewer, which made the last commit')
  assert.match(asks.at(-1), /written before your commits changed it\. Rewrite `change-brief\.json`/)
  assert.equal(await runner.ensureChangeBrief(reviewed), 'present', 'rewritten, it is not asked for again')
}

console.log('ok - a change waiting at a gate gets a brief of its advantages and disadvantages from the step that made it')
process.exit(0)
