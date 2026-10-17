/**
 * Jira field sync: the custom fields a run fills on its ticket, with Jira
 * stubbed. Pins the stage and risk-class derivations, that an unmapped field
 * is never written, that a Yes/No gate field is set only when the evidence
 * exists, and that nothing leaves the process without JIRA_POST_ENABLED.
 *
 *   node scripts/test-jira-field-sync.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'jfs-runs-'))
process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'jfs-claude-'))
process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'jfs-users-'))
process.env.JIRA_BASE_URL = 'https://jira.test'
process.env.JIRA_EMAIL = 'dev@example.test'
process.env.JIRA_API_TOKEN = 'not-a-real-token'
process.env.AGENT_MANAGER_URL = 'https://am.test'
delete process.env.JIRA_POST_ENABLED

const J = await import('../server/utils/jiraFieldSync.ts')

const settings = (agentManager) => writeFileSync(join(process.env.CLAUDE_DIR, 'settings.json'), JSON.stringify({ agentManager }))

const base = {
  id: 'run-1', ticketKey: 'CSUP-1', status: 'running', workflowName: 'Runbook A', workflowSlug: 'runbook-a', watch: 'direct-invocation',
  steps: [], currentStepIds: [], nextStepIds: [], startedAt: Date.now(), budget: { maxMinutes: 1, maxTokens: 1 }, pid: 1, autoRun: true, initialPrompt: 'CSUP-1',
}

// ── 1. stage from status ──────────────────────────────────────────────────
{
  const s = (run, changes) => J.agentStageFor({ ...base, ...run }, changes)
  assert.equal(s({ status: 'queued' }), 'NEW')
  assert.equal(s({ status: 'queued', blastRadius: 'docs' }), 'TRIAGED', 'classified while queued reads as triaged')
  assert.equal(s({ status: 'running' }), 'AGENT IN PROGRESS')
  assert.equal(s({ status: 'awaiting_review' }), 'SME REVIEW')
  assert.equal(s({ status: 'paused', question: { stepId: 'g', text: '', kind: 'approval', askedAt: 1 } }), 'SME REVIEW', 'a review gate')
  assert.equal(s({ status: 'paused', question: { stepId: 'g', text: '', kind: 'approval', askedAt: 1, reason: 'budget' } }), 'NEEDS HUMAN', 'a budget pause is not a review')
  assert.equal(s({ status: 'paused', question: { stepId: 'g', text: '', kind: 'question', askedAt: 1 } }), 'NEEDS HUMAN')
  assert.equal(s({ status: 'completed' }, { prUrls: ['https://github.com/o/r/pull/1'] }), 'PR READY')
  assert.equal(s({ status: 'completed' }, { prUrls: ['https://github.com/o/r/pull/1'], merged: true }), 'MERGED')
  assert.equal(s({ status: 'completed' }, { prUrls: [] }), 'NEEDS HUMAN', 'finished with nothing to show is a person\'s problem')
  assert.equal(s({ status: 'failed' }), 'NEEDS HUMAN')
}

// ── 2. risk class from blast radius ───────────────────────────────────────
{
  for (const b of ['protocol', 'money', 'schema']) assert.equal(J.riskClassFor({ blastRadius: b }), 'A', b)
  assert.equal(J.riskClassFor({ blastRadius: 'deployment', origin: 'production' }), 'A')
  assert.equal(J.riskClassFor({ blastRadius: 'deployment', origin: 'qa' }), 'B')
  assert.equal(J.riskClassFor({ blastRadius: 'deployment' }), 'B')
  assert.equal(J.riskClassFor({ blastRadius: 'ui_parsing' }), 'B')
  assert.equal(J.riskClassFor({ blastRadius: 'docs' }), 'C')
  assert.equal(J.riskClassFor({}), undefined, 'unclassified gets no class, not a guess')
}

// ── 3. values: evidence-only Yes fields ───────────────────────────────────
{
  const v = await J.fieldValuesFor({ ...base, blastRadius: 'money', workType: 'bug', product: { name: 'billing', repos: ['alepolab/billing'], branches: {}, stack: {}, tests: {} } })
  assert.equal(v.agentStage, 'AGENT IN PROGRESS')
  assert.equal(v.riskClass, 'A')
  assert.equal(v.changeType, 'bug')
  assert.equal(v.product, 'billing')
  assert.equal(v.impactedRepos, 'alepolab/billing')
  assert.equal(v.agentSession, 'https://am.test/workflows/runbook-a?run=run-1')
  assert.equal(v.evidenceManifest, 'https://am.test/api/runs/run-1/artifacts')
  for (const k of ['codeCommitted', 'ciApproved', 'codeReviewed', 'atddReviewed', 'smeMinutes']) assert.equal(v[k], undefined, `${k} is absent, never "No", when there is no evidence`)

  mkdirSync(join(process.env.AGENT_RUNS_DIR, 'run-1', 'artifacts'), { recursive: true })
  writeFileSync(join(process.env.AGENT_RUNS_DIR, 'run-1', 'artifacts', 'meta.json'), JSON.stringify({ fix: { commits: ['abc'], files_changed: 2, repos: [{ repo: 'alepolab/billing', pr: 'https://github.com/alepolab/billing/pull/9' }] } }))
  const w = await J.fieldValuesFor({
    ...base, status: 'completed',
    ci: { pr: 'x', status: 'passing', checks: [], checkedAt: 1, final: true },
    decisions: [{ stepId: 'g', label: 'Dev Done', at: 1, by: 'alice', verdict: 'approved', waitedMs: 10, minutes: 15 }, { stepId: 'h', label: 'QA', at: 2, by: 'bob', verdict: 'approved', waitedMs: 10, minutes: 5 }],
    steps: [{ stepId: 'a', label: 'ATDD run', agentSlug: 'sdlc-atdd', status: 'completed', input: '', output: '', visits: 1 }],
  })
  assert.equal(w.agentStage, 'PR READY', 'a real PR in meta.json')
  assert.equal(w.codeCommitted, 'Yes')
  assert.equal(w.ciApproved, 'Yes')
  assert.equal(w.codeReviewed, 'Yes')
  assert.equal(w.atddReviewed, 'Yes')
  assert.equal(w.smeMinutes, '20', 'the reviewers\' reported minutes, summed')

  // A carried approval is not a person's review.
  const carried = await J.fieldValuesFor({ ...base, decisions: [{ stepId: 'g', label: 'PR', at: 1, by: 'alice', verdict: 'approved', waitedMs: 0, auto: true }] })
  assert.equal(carried.codeReviewed, undefined)
  // CI still pending is not approved.
  const pending = await J.fieldValuesFor({ ...base, ci: { pr: 'x', status: 'pending', checks: [], checkedAt: 1, final: false } })
  assert.equal(pending.ciApproved, undefined)
}

// ── 4. no field map: nothing is written, nothing is called ────────────────
{
  const r = await J.syncJiraFields(base, {}, async () => { throw new Error('must not be called') })
  assert.equal(r.posted, false)
  assert.match(r.reason, /jiraFieldMap/)
  assert.deepEqual(r.fields, {})
  assert.equal(r.computed.agentStage, 'AGENT IN PROGRESS', 'the values are still computed, for the caller to read')
}

// ── 5. mapped but posting off: says what it would set, calls nothing ──────
settings({ jiraFieldMap: { agentStage: 'customfield_10001', riskClass: 'customfield_10002', codeReviewed: 'customfield_10003', smeMinutes: '' } })
{
  const calls = []
  const r = await J.syncJiraFields({ ...base, blastRadius: 'docs' }, {}, async (url, init) => { calls.push([String(url), init?.method ?? 'GET']); return new Response('{}') })
  assert.equal(r.posted, false)
  assert.match(r.reason, /JIRA_POST_ENABLED/)
  assert.deepEqual(r.fields, { customfield_10001: 'AGENT IN PROGRESS', customfield_10002: 'C' }, 'only mapped fields with a value; codeReviewed has no evidence, smeMinutes has no id')
  assert.equal(calls.length, 0, 'no request left the process')
  assert.equal((await J.syncJiraFields({ ...base, ticketKey: undefined })).reason, 'this run has no ticket key')
}

// ── 6. enabled: reads editmeta, shapes an option field, PUTs the issue ────
process.env.JIRA_POST_ENABLED = '1'
{
  const calls = []
  const editmeta = { fields: {
    customfield_10001: { name: 'Agent Stage', schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
    customfield_10002: { name: 'Risk Class', schema: { type: 'string' } },
  } }
  const jira = async (url, init) => {
    calls.push([String(url), init?.method ?? 'GET', init?.body])
    if (String(url).endsWith('/editmeta')) return new Response(JSON.stringify(editmeta), { status: 200 })
    return new Response(null, { status: 204 })
  }
  const r = await J.syncJiraFields({ ...base, blastRadius: 'protocol', decisions: [{ stepId: 'g', label: 'Dev Done', at: 1, by: 'alice', verdict: 'approved', waitedMs: 1 }] }, {}, jira)
  assert.equal(r.posted, true, r.reason)
  assert.deepEqual(calls.map(c => c[1]), ['GET', 'PUT'], 'one read of the edit screen, one write')
  assert.ok(calls.every(c => c[0].startsWith('https://jira.test/rest/api/3/issue/CSUP-1')), calls.map(c => c[0]).join(','))
  const sent = JSON.parse(calls[1][2])
  assert.deepEqual(sent, { fields: { customfield_10001: { value: 'AGENT IN PROGRESS' }, customfield_10002: 'A' } },
    'an option field is sent as { value }; codeReviewed is mapped and has evidence but is not on the edit screen, so it is dropped rather than failing the PUT')

  // A Jira error is reported, not thrown.
  const bad = await J.syncJiraFields({ ...base, blastRadius: 'docs' }, {}, async (url) => String(url).endsWith('/editmeta') ? new Response(JSON.stringify(editmeta)) : new Response('nope', { status: 400 }))
  assert.equal(bad.posted, false)
  assert.match(bad.reason, /HTTP 400/)
}

// ── 7. the transition hook posts once per status ──────────────────────────
{
  // The hook uses the global fetch; point it at a counter for this block.
  const realFetch = globalThis.fetch
  let puts = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/editmeta')) return new Response(JSON.stringify({ fields: { customfield_10001: { schema: { type: 'string' } } } }))
    if (init?.method === 'PUT') puts++
    return new Response(null, { status: 204 })
  }
  try {
    J._resetSynced()
    J.syncJiraFieldsOnTransition({ ...base, id: 'run-h', status: 'running' })
    J.syncJiraFieldsOnTransition({ ...base, id: 'run-h', status: 'running' })
    J.syncJiraFieldsOnTransition({ ...base, id: 'run-h', status: 'paused', question: { stepId: 'g', text: '', kind: 'approval', askedAt: 1 } })
    await new Promise(r => setTimeout(r, 50))
    assert.equal(puts, 2, 'running once, paused once; the repeated running publish is deduped')
    J.syncJiraFieldsOnTransition({ ...base, id: 'run-h2', ticketKey: undefined, status: 'running' })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(puts, 2, 'no ticket, no sync')
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('jira field sync: all assertions passed')
