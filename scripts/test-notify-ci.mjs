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
const posted = []
N.setPoster(async (url, body) => { posted.push({ url, body }) })
const run = await store.createRun({ workflowSlug: 'w', workflowName: 'Runbook', autoRun: true, initialPrompt: 'SCN-1 upload fails', watch: 'direct-invocation',
  steps: [{ stepId: 'a', label: 'Intake', agentSlug: 'x' }, { stepId: 'b', label: 'Fix', agentSlug: 'y' }] })
delete process.env.SLACK_WEBHOOK_URL
N.notifyRunTransition({ ...run, status: 'failed', error: 'boom' })
assert.equal(posted.length, 0, 'no webhook configured, nothing sent')
process.env.SLACK_WEBHOOK_URL = 'https://hooks.example/abc'
N.notifyRunTransition({ ...run, status: 'running' })
assert.equal(posted.length, 0, 'running is not worth a message')
N.notifyRunTransition({ ...run, status: 'paused', nextStepIds: ['b'] })
N.notifyRunTransition({ ...run, status: 'paused', nextStepIds: ['b'] })
assert.equal(posted.length, 1, 'the same status is announced once')
assert.match(posted[0].body.text, /Runbook: PAUSED at Fix — SCN-1 upload fails/, 'message names workflow, status, step and ticket')
assert.match(posted[0].body.text, /\/workflows\/w\?run=/, 'message links to the run')
N.notifyRunTransition({ ...run, status: 'failed', error: 'Budget exceeded: 9 tokens over the 1 token cap', steps: [{ ...run.steps[0], status: 'failed' }, run.steps[1]] })
assert.equal(posted.length, 2)
assert.match(posted[1].body.text, /FAILED at Intake .* Budget exceeded/, 'a failure carries its reason')
delete process.env.SLACK_WEBHOOK_URL

// ── jira write-back: terminal statuses only, once each, with the PR when known ──
const comments = []
N.setCommenter(async (key, body) => { comments.push({ key, body }) })
await N.commentTicket({ ...run, status: 'completed' })
assert.equal(comments.length, 0, 'no comment unless the jira CLI is the ticket source')
process.env.JIRA_TICKET_SOURCE = 'cli'
await N.commentTicket({ ...run, status: 'paused' })
assert.equal(comments.length, 0, 'a pause is not commented')
await N.commentTicket({ ...run, status: 'completed' })
await N.commentTicket({ ...run, status: 'completed' })
assert.equal(comments.length, 1, 'one comment per terminal status')
assert.equal(comments[0].key, 'SCN-1', 'the key comes from the run prompt')
assert.match(comments[0].body, /run completed: Runbook/, 'the comment states the outcome')
assert.match(comments[0].body, /Run: .*\/workflows\/w\?run=/, 'and links the run')
await N.commentTicket({ ...run, initialPrompt: 'no key here', status: 'failed' })
assert.equal(comments.length, 1, 'no key, no comment')
delete process.env.JIRA_TICKET_SOURCE

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
