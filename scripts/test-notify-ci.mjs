/**
 * Self-checks for the Slack notifier and the CI poller, with their outbound
 * calls stubbed.
 *
 *   node scripts/test-notify-ci.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'notify-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'notify-artifacts-'))

const N = await import('../server/utils/notify.ts')
const C = await import('../server/utils/ciPoller.ts')
const store = await import('../server/utils/workflowRunStore.ts')
const A = await import('../server/utils/runArtifacts.ts')

// ── notify: one message per transition, none without a webhook ───────────
// notifyRunTransition returns its delivery promise so this can await the send.
// Resolving a NAMED channel reads from disk, so a transition message is no
// longer delivered synchronously the way a bare env-var webhook was.
const posted = []
N.setPoster(async (url, body) => { posted.push({ url, body }) })
const run = await store.createRun({ workflowSlug: 'w', workflowName: 'Runbook', autoRun: true, initialPrompt: 'SCN-1 upload fails', watch: 'direct-invocation',
  steps: [{ stepId: 'a', label: 'Intake', agentSlug: 'x' }, { stepId: 'b', label: 'Fix', agentSlug: 'y' }] })
delete process.env.SLACK_WEBHOOK_URL
await N.notifyRunTransition({ ...run, status: 'failed', error: 'boom' })
assert.equal(posted.length, 0, 'no webhook configured, nothing sent')
process.env.SLACK_WEBHOOK_URL = 'https://hooks.example/abc'
await N.notifyRunTransition({ ...run, status: 'running' })
assert.equal(posted.length, 0, 'running is not worth a message')
await N.notifyRunTransition({ ...run, status: 'paused', nextStepIds: ['b'] })
await N.notifyRunTransition({ ...run, status: 'paused', nextStepIds: ['b'] })
assert.equal(posted.length, 1, 'the same status is announced once')
assert.match(posted[0].body.text, /Runbook: PAUSED at Fix — SCN-1 upload fails/, 'message names workflow, status, step and ticket')
assert.match(posted[0].body.text, /\/workflows\/w\?run=/, 'message links to the run')
// The status a message was never sent for must not be deduped against: the
// 'failed' above found nothing configured, so this one still announces.
await N.notifyRunTransition({ ...run, status: 'failed', error: 'Budget exceeded: 9 tokens over the 1 token cap', steps: [{ ...run.steps[0], status: 'failed' }, run.steps[1]] })
assert.equal(posted.length, 2)
assert.match(posted[1].body.text, /FAILED at Intake .* Budget exceeded/, 'a failure carries its reason')

// What is being decided rides along, so an awaiting_review message says more
// than which step it stopped at.
N._resetNotified()
await N.notifyRunTransition({ ...run, status: 'awaiting_review', nextStepIds: ['b'],
  question: { stepId: 'b', kind: 'approval', askedAt: 1, text: 'Decide which entries of escalated-drafts.json to act on before "Fix" runs', artifact: 'escalated-drafts.json' } })
assert.equal(posted.length, 3)
assert.match(posted[2].body.text, /Decide which entries of escalated-drafts\.json/, 'the message carries the question')
delete process.env.SLACK_WEBHOOK_URL

// ── ci poller: classification, persistence, and stopping when final ──────
assert.equal(C.classify([]), 'pending')
assert.equal(C.classify([{ bucket: 'pass' }, { bucket: 'skipping' }]), 'passing')
assert.equal(C.classify([{ bucket: 'pass' }, { bucket: 'fail' }]), 'failing')
assert.equal(C.classify([{ bucket: 'pass' }, { bucket: 'pending' }]), 'pending')

const done = await store.createRun({ workflowSlug: 'w', workflowName: 'Runbook', autoRun: true, initialPrompt: 'SCN-2', watch: 'direct-invocation',
  steps: [{ stepId: 'a', label: 'Intake', agentSlug: 'x' }] })
await store.saveRun({ ...done, status: 'completed', endedAt: Date.now() })
mkdirSync(A.runArtifactsDir(done.id), { recursive: true })
writeFileSync(join(A.runArtifactsDir(done.id), 'meta.json'), JSON.stringify({ fix: { repos: [{ repo: 'o/r', commits: ['abc'], pr: 'https://github.com/o/r/pull/7' }] } }))
const placeholder = await store.createRun({ workflowSlug: 'w', workflowName: 'Runbook', autoRun: true, initialPrompt: 'SCN-3', watch: 'direct-invocation',
  steps: [{ stepId: 'a', label: 'Intake', agentSlug: 'x' }] })
await store.saveRun({ ...placeholder, status: 'completed', endedAt: Date.now() })
mkdirSync(A.runArtifactsDir(placeholder.id), { recursive: true })
writeFileSync(join(A.runArtifactsDir(placeholder.id), 'meta.json'), JSON.stringify({ fix: { repos: [{ repo: 'o/r', commits: ['abc'], pr: 'https://example.invalid/pending' }] } }))

const asked = []
let answer = [{ name: 'build', bucket: 'pending' }]
C.setCheckReader(async (url) => { asked.push(url); return answer })
assert.equal(await C.pollOnce(), 1, 'only the run with a real PR is polled')
assert.deepEqual(asked, ['https://github.com/o/r/pull/7'])
let after = await store.getRun(done.id)
assert.equal(after.ci.status, 'pending'); assert.equal(after.ci.final, false)
answer = [{ name: 'build', bucket: 'pass' }, { name: 'lint', bucket: 'pass' }]
assert.equal(await C.pollOnce(), 1, 'a pending PR is polled again')
after = await store.getRun(done.id)
assert.equal(after.ci.status, 'passing'); assert.equal(after.ci.final, true)
assert.equal(await C.pollOnce(), 0, 'a final result is not polled again')
C.setCheckReader(async () => { throw new Error('gh: not logged in') })
const errRun = await store.createRun({ workflowSlug: 'w', workflowName: 'Runbook', autoRun: true, initialPrompt: 'SCN-4', watch: 'direct-invocation',
  steps: [{ stepId: 'a', label: 'Intake', agentSlug: 'x' }] })
await store.saveRun({ ...errRun, status: 'completed', endedAt: Date.now() })
mkdirSync(A.runArtifactsDir(errRun.id), { recursive: true })
writeFileSync(join(A.runArtifactsDir(errRun.id), 'meta.json'), JSON.stringify({ fix: { repos: [{ repo: 'o/r', commits: ['abc'], pr: 'https://github.com/o/r/pull/8' }] } }))
await C.pollOnce()
after = await store.getRun(errRun.id)
assert.equal(after.ci.status, 'unknown'); assert.match(after.ci.error, /not logged in/, 'a gh failure is recorded, not hidden')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
console.log('notify + ciPoller: all assertions passed')
