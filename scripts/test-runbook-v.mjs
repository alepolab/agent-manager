/**
 * Runbook V ("Verify after merge"): the route starts a verification run and it
 * stops at the QA gate.
 *
 * Covered here, with a stub agent caller and a fake Jira:
 *   - the shipped template seeds as runbook-v-verify-after-merge with the agents
 *     it names, and ends at a gate addressed to `qa` that records
 *     verification.pass and sets Agent Stage=VERIFIED
 *   - startVerificationRun (what POST /api/v1/runs {issueKey, stage:'verify'}
 *     calls) refuses a non-key, a missing workflow, and a second start for a
 *     ticket already being verified
 *   - a run started that way runs brief, deploy and regression, then pauses at
 *     G5 with question.role 'qa'
 *   - approving G5 records events/verification.pass.json and the Jira step
 *     then sets the stage: as a comment with no field map, through the mapped
 *     field with one
 *   - the CI poller starts the same run when it sees a PR reach MERGED, once
 *   - the route file itself guards the capability and insists on stage 'verify'
 *
 *   node scripts/test-runbook-v.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'runbook-v-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'runbook-v-artifacts-'))
process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'runbook-v-users-'))
process.env.JIRA_BASE_URL = 'https://jira.test'
process.env.JIRA_EMAIL = 'dev@example.test'
process.env.JIRA_API_TOKEN = 'not-a-real-token'
delete process.env.JIRA_POST_ENABLED

const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const { workflowTemplates, materializeTemplateSteps, RUNBOOK_FILES } = await import('../app/utils/workflowTemplates.ts')
const { agentTemplates } = await import('../app/utils/templates.ts')
const V = await import('../server/utils/verificationRunStarter.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')
const { runJiraStep } = await import('../server/utils/jiraSteps.ts')
const store = await import('../server/utils/workflowRunStore.ts')
const poller = await import('../server/utils/ciPoller.ts')
const events = await import('../server/utils/runEvents.ts')

const TIMEOUT = 30_000

// ── 1. The template ───────────────────────────────────────────────────────
const template = workflowTemplates.find(t => t.id === 'runbook-v-verify-after-merge')
assert.ok(template, 'Runbook V ships')
assert.equal(RUNBOOK_FILES['runbook-v-verify-after-merge'], 'runbook-v-verify-after-merge', 'and is seeded by team sync under its slug')
for (const s of template.steps) assert.ok(agentTemplates.find(a => a.id === s.agentTemplateId), `${s.agentTemplateId} is a shipped agent template`)
const slugs = Object.fromEntries(template.steps.flatMap(s => [[s.agentTemplateId, s.agentTemplateId], ...(s.monitorSlug ? [[s.monitorSlug, s.monitorSlug]] : [])]))
const steps = materializeTemplateSteps(template, slugs)
assert.deepEqual(steps.map(s => s.agentSlug), ['sdlc-verification-brief', 'sdlc-stack-provisioner', 'sdlc-regression-runner', 'sdlc-jira-tracker'])
const gate = steps.at(-1)
assert.equal(gate.label, 'G5 verification sign-off')
assert.equal(gate.approval, true, 'G5 waits for a person')
assert.equal(gate.gateRole, 'qa', 'and that person is QA')
assert.equal(gate.records, 'verification.pass', 'approving it records the event')
assert.equal(gate.jira?.stage, 'VERIFIED', 'and the Jira step sets Agent Stage=VERIFIED')
assert.deepEqual(gate.next, [], 'it is the last step')
assert.match(agentTemplates.find(a => a.id === 'sdlc-verification-brief').body, /verification-brief\.md/)
for (const section of ['What changed', 'How to verify in staging', 'Exact commands, API calls and protocol flows', 'Expected evidence', 'Rollback']) {
  assert.ok(agentTemplates.find(a => a.id === 'sdlc-verification-brief').body.includes(section), `the brief has a "${section}" section`)
}
assert.match(agentTemplates.find(a => a.id === 'sdlc-regression-runner').body, /regression\.xml/)
assert.match(agentTemplates.find(a => a.id === 'sdlc-regression-runner').body, /screenshots\//)

// ── 2. The starter refuses what it should ─────────────────────────────────
await assert.rejects(V.startVerificationRun({ issueKey: 'not a key', watch: 'direct-invocation' }), /not a Jira issue key/)
await assert.rejects(V.startVerificationRun({ issueKey: 'KEY-7', watch: 'direct-invocation' }), /not seeded/, 'no Runbook V on disk is a 404, not a crash')

// Seed the workflow the way team sync does.
mkdirSync(join(CLAUDE_DIR, 'workflows'), { recursive: true })
writeFileSync(join(CLAUDE_DIR, 'workflows', `${V.VERIFY_WORKFLOW_SLUG}.json`), JSON.stringify({ name: template.name, description: template.description, steps, parameters: template.parameters, createdAt: new Date().toISOString() }, null, 2))

// ── 3. A run stops at the QA gate ─────────────────────────────────────────
const calls = []
const PRODUCES = { 'sdlc-verification-brief': ['verification-brief.md'], 'sdlc-stack-provisioner': ['stack-report.md'], 'sdlc-regression-runner': ['regression.xml', 'regression-report.md'] }
runner.setAgentCaller(async (agentSlug, input) => {
  calls.push({ agentSlug, input })
  // The stubs write what their steps declare, as a real agent would; the runner checks `produces`.
  const dir = input.match(/Write every artifact you produce into: (\S+)/)?.[1]
  if (dir) for (const f of PRODUCES[agentSlug] ?? []) writeFileSync(join(dir, f), `${agentSlug} wrote ${f}`)
  return { output: `${agentSlug} done`, model: 'stub', usage: { input_tokens: 10, output_tokens: 5 } }
})
const { run: started, queued } = await V.startVerificationRun({ issueKey: 'KEY-7', pr: 'https://github.com/alepolab/x/pull/9', revision: 'abc123', watch: 'direct-invocation', ticketText: 'KEY-7: the thing' })
assert.equal(queued, false)
assert.equal(started.workflowSlug, V.VERIFY_WORKFLOW_SLUG)
assert.equal(started.ticketKey, 'KEY-7')
assert.equal(started.parameters?.pr, 'https://github.com/alepolab/x/pull/9', 'the PR is a stated run parameter')
assert.equal(started.parameters?.revision, 'abc123')
assert.match(started.initialPrompt, /^KEY-7: verify the merged change in staging/)
assert.match(started.initialPrompt, /Merged pull request: https:\/\/github.com\/alepolab\/x\/pull\/9/)

const paused = await runner.waitForSettled(started.id, TIMEOUT)
assert.equal(paused.status, 'paused', 'the run stops')
assert.equal(paused.question?.kind, 'approval')
assert.equal(paused.question?.stepId, gate.id, 'at G5')
assert.equal(paused.question?.role, 'qa', 'addressed to QA')
assert.match(paused.question?.text ?? '', /G5 verification sign-off/)
assert.deepEqual(calls.map(c => c.agentSlug).filter(a => a !== 'sdlc-step-monitor'), ['sdlc-verification-brief', 'sdlc-stack-provisioner', 'sdlc-regression-runner'], 'brief, deploy, regression ran; the gate did not')
assert.ok(calls[0].input.includes('Merge commit: abc123'), 'the brief step is told the revision')

// A second start for the same ticket is refused while this one is live.
await assert.rejects(V.startVerificationRun({ issueKey: 'KEY-7', watch: 'direct-invocation' }), (err) => {
  assert.equal(err.statusCode, 409)
  assert.equal(err.runId, started.id, 'and names the run in the way')
  return true
})

// ── 4. Approving G5 records verification.pass and sets the stage ──────────
const heard = []
events.onRunEvent(async (e) => { heard.push(e) })
const cont = await runner.continueRun(started.id, 'verified in staging, counts match the brief', { decision: { stepId: gate.id, label: gate.label, at: Date.now(), by: 'qa-lead', verdict: 'approved', note: 'verified', waitedMs: 1 } })
assert.ok(cont)
const done = await runner.waitForSettled(started.id, TIMEOUT)
assert.equal(done.status, 'completed', 'after QA signs off the run finishes')
const eventFile = join(runArtifactsDir(started.id), 'events', 'verification.pass.json')
assert.ok(existsSync(eventFile), 'verification.pass is on the record')
const recorded = JSON.parse(readFileSync(eventFile, 'utf8'))
assert.equal(recorded.event, 'verification.pass')
assert.equal(recorded.by, 'qa-lead', 'attributed to the approver')
assert.equal(recorded.ticketKey, 'KEY-7')
assert.equal(heard.length, 1, 'and announced once to whoever listens')
assert.equal(heard[0].event, 'verification.pass')
const g5 = done.steps.find(s => s.stepId === gate.id)
assert.equal(g5.status, 'completed')
assert.match(g5.output, /Agent Stage: VERIFIED/, 'posting is off, so the step says what it would have recorded')
assert.match(g5.output, /JIRA_POST_ENABLED/)

// The Jira step itself, with posting on: a comment without a field map, the field with one.
process.env.JIRA_POST_ENABLED = '1'
const jiraRun = { id: 'jr-1', ticketKey: 'KEY-7', status: 'running', workflowName: 'Runbook V', workflowSlug: V.VERIFY_WORKFLOW_SLUG, watch: 'direct-invocation', steps: [], startedAt: Date.now(), budget: { maxMinutes: 1, maxTokens: 1 } }
let posted = []
const jira = async (url, init) => {
  posted.push([String(url), init?.method ?? 'GET', init?.body ? JSON.parse(init.body) : null])
  if (String(url).endsWith('/editmeta')) return new Response(JSON.stringify({ fields: { customfield_900: { name: 'Agent Stage', schema: { type: 'string' } } } }), { status: 200 })
  if (String(url).endsWith('?fields=assignee,reporter')) return new Response(JSON.stringify({ fields: {} }), { status: 200 })
  return new Response('{}', { status: 200 })
}
let out = await runJiraStep(jiraRun, { stage: 'VERIFIED' }, jira)
assert.match(out, /Agent Stage VERIFIED recorded on KEY-7 as a comment/, out)
assert.ok(posted.some(([u, m, b]) => u.endsWith('/comment') && m === 'POST' && JSON.stringify(b).includes('Agent Stage: VERIFIED')), 'the comment carries the stage')

writeFileSync(join(CLAUDE_DIR, 'settings.json'), JSON.stringify({ agentManager: { jira: { postEnabled: true, fieldMap: { agentStage: 'Agent Stage' } } } }))
posted = []
out = await runJiraStep(jiraRun, { stage: 'VERIFIED' }, jira)
assert.match(out, /Agent Stage set to VERIFIED via "Agent Stage"/, out)
const put = posted.find(([, m]) => m === 'PUT')
assert.ok(put, 'the field is set with a PUT')
assert.equal(put[2].fields.customfield_900, 'VERIFIED', 'on the mapped field')
assert.ok(!posted.some(([u, m]) => u.endsWith('/comment') && m === 'POST'), 'and no comment stands in for it')
delete process.env.JIRA_POST_ENABLED
writeFileSync(join(CLAUDE_DIR, 'settings.json'), '{}')

// ── 5. The poller starts Runbook V when a PR merges, once ─────────────────
{
  const source = await store.createRun({ workflowSlug: 'runbook-a-ticket-to-evidence-backed-pr', workflowName: 'Runbook A', autoRun: true, initialPrompt: 'KEY-8: fix', watch: 'direct-invocation', ticketKey: 'KEY-8', steps: [{ stepId: 'x', label: 'X', agentSlug: 'a' }] })
  source.status = 'completed'
  source.endedAt = Date.now()
  await store.saveRun(source)
  mkdirSync(runArtifactsDir(source.id), { recursive: true })
  writeFileSync(join(runArtifactsDir(source.id), 'meta.json'), JSON.stringify({ fix: { repos: [{ repo: 'alepolab/x', pr: 'https://github.com/alepolab/x/pull/42' }] } }))

  const startedFor = []
  poller.setVerificationStarter(async (s) => { startedFor.push(s); return { run: { id: 'verify-run-1' } } })
  poller.setMergeReader(async (url) => ({ merged: url.endsWith('/42'), mergeCommit: 'deadbeef', baseBranch: 'develop' }))
  assert.equal(await poller.detectMergedOnce(), 1, 'one merge seen')
  assert.equal(startedFor.length, 1, 'Runbook V started once')
  assert.equal(startedFor[0].issueKey, 'KEY-8')
  assert.equal(startedFor[0].pr, 'https://github.com/alepolab/x/pull/42')
  assert.equal(startedFor[0].revision, 'deadbeef')
  assert.equal(startedFor[0].branch, 'develop')
  assert.equal(startedFor[0].watch, `ci-poller:${source.id}`, 'the verification run says what triggered it')
  const after = await store.getRun(source.id)
  assert.equal(after.verification?.runId, 'verify-run-1', 'the source run records the verification it started')
  assert.equal(await poller.detectMergedOnce(), 0, 'and is not asked again')
  assert.equal(startedFor.length, 1)

  // A refusal is recorded too, so it is not retried every minute.
  const other = await store.createRun({ workflowSlug: 'runbook-a-ticket-to-evidence-backed-pr', workflowName: 'Runbook A', autoRun: true, initialPrompt: 'KEY-9: fix', watch: 'direct-invocation', ticketKey: 'KEY-9', steps: [{ stepId: 'x', label: 'X', agentSlug: 'a' }] })
  other.status = 'completed'; other.endedAt = Date.now(); await store.saveRun(other)
  mkdirSync(runArtifactsDir(other.id), { recursive: true })
  writeFileSync(join(runArtifactsDir(other.id), 'meta.json'), JSON.stringify({ fix: { repos: [{ repo: 'alepolab/x', pr: 'https://github.com/alepolab/x/pull/43' }] } }))
  poller.setMergeReader(async () => ({ merged: true }))
  poller.setVerificationStarter(async () => { throw new Error('KEY-9 already has a verification run') })
  assert.equal(await poller.detectMergedOnce(), 1)
  assert.match((await store.getRun(other.id)).verification?.reason ?? '', /already has a verification run/)
  assert.equal(await poller.detectMergedOnce(), 0)
}

// ── 6. The route ──────────────────────────────────────────────────────────
{
  const src = readFileSync(new URL('../server/api/v1/runs/index.post.ts', import.meta.url), 'utf8')
  assert.match(src, /requireCapability\(event, 'startRun'\)/, 'starting a verification run is a startRun capability')
  assert.match(src, /body\.stage !== 'verify'/, 'the route insists on stage verify')
  assert.match(src, /startVerificationRun\(/, 'and calls the shared starter')
  assert.match(src, /watch: 'direct-invocation'/, 'a route start is a direct invocation')
}

console.log('OK  runbook v: route starts a verification run; it stops at the qa gate; approval records verification.pass and Agent Stage=VERIFIED; the poller starts it on merge')
