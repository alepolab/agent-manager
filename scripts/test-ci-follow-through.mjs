/**
 * The defect: CI follow-through was one-shot, silent, single-repo and expiring.
 *
 * A review of thirteen real runs measured it. The poller stopped at the first
 * non-pending result, so a green PR that was never merged read as finished and
 * a red one that got fixed read as red forever. It polled `urls[0]` only, so
 * the second and third pull requests of a multi-repo run were never looked at
 * once. It recorded no merge, so not one of the thirteen runs could answer "did
 * this ship?". And when a bucket turned red it updated a field on a record and
 * told nobody.
 *
 * Every GitHub call is stubbed the way scripts/test-notify-ci.mjs stubs them:
 * `gh` is never executed and no network call is made.
 *
 *   node scripts/test-ci-follow-through.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'ci-follow-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'ci-follow-artifacts-'))
delete process.env.SLACK_WEBHOOK_URL

const C = await import('../server/utils/ciPoller.ts')
const N = await import('../server/utils/notify.ts')
const store = await import('../server/utils/workflowRunStore.ts')
const A = await import('../server/utils/runArtifacts.ts')

const posted = []
N.setPoster(async (url, body) => { posted.push({ url, body }) })

/** A completed run whose meta.json names these pull requests. */
const runWithPrs = async (prompt, prs) => {
  const run = await store.createRun({
    workflowSlug: 'w', workflowName: 'Runbook', autoRun: true, initialPrompt: prompt, watch: 'direct-invocation',
    steps: [{ stepId: 'a', label: 'Intake', agentSlug: 'x' }],
  })
  await store.saveRun({ ...run, status: 'completed', endedAt: Date.now() })
  mkdirSync(A.runArtifactsDir(run.id), { recursive: true })
  writeFileSync(join(A.runArtifactsDir(run.id), 'meta.json'),
    JSON.stringify({ fix: { repos: prs.map((pr, i) => ({ repo: `o/r${i}`, commits: ['abc'], pr })) } }))
  return run
}

// ── every pull request a run recorded is polled, not just the first ─────────
{
  const urls = ['https://github.com/o/r0/pull/1', 'https://github.com/o/r1/pull/2', 'https://github.com/o/r2/pull/3']
  const run = await runWithPrs('SCN-10 multi-repo fix', urls)
  const checked = []
  const viewed = []
  C.setCheckReader(async (u) => { checked.push(u); return [{ name: 'build', bucket: 'pass' }] })
  C.setPrReader(async (u) => { viewed.push(u); return { state: 'open' } })

  assert.equal(await C.pollOnce(), 1)
  assert.deepEqual(checked, urls, `every PR's checks are read; got ${JSON.stringify(checked)}`)
  assert.deepEqual(viewed, urls, 'and every PR is asked whether it merged')
  const after = await store.getRun(run.id)
  assert.equal(after.ci.prs.length, 3, 'all three are recorded, not just urls[0]')
  assert.equal(after.ci.status, 'passing')
  assert.equal(after.ci.final, false, 'three open pull requests are not a finished story')
}

// ── polling continues past the first final state, until merged or closed ────
{
  const url = 'https://github.com/o/r/pull/7'
  const run = await runWithPrs('SCN-11 one repo', [url])
  let checks = [{ name: 'build', bucket: 'pending' }]
  let facts = { state: 'open' }
  // Earlier cases left their own unsettled runs behind, so "was THIS PR looked
  // at" is the question, not how many runs the pass covered.
  let seen = []
  C.setCheckReader(async (u) => { seen.push(u); return checks })
  C.setPrReader(async () => facts)
  const poll = async () => { seen = []; await C.pollOnce(); return seen.includes(url) }

  assert.equal(await poll(), true, 'pending: polled')
  checks = [{ name: 'build', bucket: 'pass' }, { name: 'lint', bucket: 'pass' }]
  assert.equal(await poll(), true, 'passing but unmerged: still polled — this is the defect')
  let after = await store.getRun(run.id)
  assert.equal(after.ci.status, 'passing')
  assert.equal(after.ci.final, false, 'green checks are not the end of the story; a merge is')

  // and a green PR can still go red afterwards, which the old poller never saw
  checks = [{ name: 'build', bucket: 'fail' }, { name: 'lint', bucket: 'pass' }]
  await poll()
  after = await store.getRun(run.id)
  assert.equal(after.ci.status, 'failing', 'a check that turns red after passing is seen')

  // ── merge facts are recorded: "did this ship?" has an answer ──────────────
  facts = { state: 'merged', merged_sha: 'deadbeefcafe', merged_at: '2026-09-20T11:02:00Z' }
  checks = [{ name: 'build', bucket: 'pass' }, { name: 'lint', bucket: 'pass' }]
  await poll()
  after = await store.getRun(run.id)
  assert.equal(after.ci.merged_sha, 'deadbeefcafe', 'the merge commit is on the record')
  assert.equal(after.ci.merged_at, '2026-09-20T11:02:00Z')
  assert.equal(after.ci.prs[0].state, 'merged')
  assert.equal(after.ci.final, true, 'merged is the one state that ends the watch')
  assert.equal(await poll(), false, 'and a merged run is not polled again')
}

// ── a closed-without-merging PR also ends the watch, with no merge claimed ──
{
  const run = await runWithPrs('SCN-12 abandoned', ['https://github.com/o/r/pull/9'])
  C.setCheckReader(async () => [{ name: 'build', bucket: 'pass' }])
  C.setPrReader(async () => ({ state: 'closed' }))
  await C.pollOnce()
  const after = await store.getRun(run.id)
  assert.equal(after.ci.final, true)
  assert.equal(after.ci.merged_sha, undefined, 'closed is not merged, and nothing invents a sha')
}

// ── a transition to failing notifies, once ──────────────────────────────────
{
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.example/abc'
  N._resetNotified()
  posted.length = 0
  const url = 'https://github.com/o/r/pull/11'
  const run = await runWithPrs('SCN-13 goes red', [url])
  let checks = [{ name: 'build', bucket: 'pending' }]
  C.setCheckReader(async () => checks)
  C.setPrReader(async () => ({ state: 'open' }))

  await C.pollOnce()
  assert.equal(posted.length, 0, 'pending is not news')

  checks = [{ name: 'build', bucket: 'fail' }, { name: 'e2e', bucket: 'pass' }]
  await C.pollOnce()
  assert.equal(posted.length, 1, 'turning red notifies')
  assert.match(posted[0].body.text, /CI FAILING/, `message says what happened: ${posted[0].body.text}`)
  assert.match(posted[0].body.text, /build/, 'and which check')
  assert.equal(posted[0].body.reason, 'ci-failing', 'the payload carries WHY it fired, so the reaction is obvious')

  await C.pollOnce()
  await C.pollOnce()
  assert.equal(posted.length, 1, 'still red is not news again')

  // ── the record exists even with no webhook anywhere ──────────────────────
  const log = join(process.env.AGENT_RUNS_DIR, 'notifications.jsonl')
  // The appends are fire-and-forget; give the event loop a turn to flush them.
  await new Promise(r => setTimeout(r, 50))
  assert.ok(existsSync(log), 'notifications.jsonl is written under the runs directory')
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const mine = lines.filter(l => l.runId === run.id)
  assert.equal(mine.length, 1, `one line for this run's red CI; got ${JSON.stringify(mine)}`)
  assert.equal(mine[0].reason, 'ci-failing')
  assert.equal(mine[0].pr, url, 'the ledger names the pull request')
  assert.ok(mine[0].reaction.length > 0, 'and what a person is expected to do about it')
  delete process.env.SLACK_WEBHOOK_URL
}

// ── a paused-on-budget run is recorded with its own reason, webhook or not ──
{
  N._resetNotified()
  posted.length = 0
  const run = await store.createRun({ workflowSlug: 'w', workflowName: 'Runbook', autoRun: true, initialPrompt: 'SCN-14 stuck', watch: 'direct-invocation',
    steps: [{ stepId: 'a', label: 'Intake', agentSlug: 'x' }] })
  N.notifyRunTransition({ ...run, status: 'paused', question: { stepId: 'a', text: 'more budget?', kind: 'approval', askedAt: Date.now(), reason: 'budget' } })
  assert.equal(posted.length, 0, 'no webhook configured, so nothing is posted')
  await new Promise(r => setTimeout(r, 50))
  const lines = readFileSync(join(process.env.AGENT_RUNS_DIR, 'notifications.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const mine = lines.filter(l => l.runId === run.id)
  assert.equal(mine.length, 1, 'but the twenty-hour pause is on the record')
  assert.equal(mine[0].reason, 'paused-on-budget',
    'and it is distinguishable from a gate, a failure and a red check — four different reactions')
  assert.match(mine[0].delivered, /log-only/, 'the record says it reached nobody')
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
console.log('ci follow-through: every PR is polled to merge or close, merges are recorded, and a red check tells somebody')
