/**
 * A scan does not file what an open ticket, or a live run for another ticket,
 * already covers - decided by the code a draft names, not by its wording.
 *
 * ASECRM-584 was filed although ASECRM-368 covered it: the shared file
 * (SubscriberApprovalService.java) was ASECRM-368's second finding, past the
 * 400-character excerpt triage was given, and the summaries were worded
 * differently. ASECRM-368's run had changed that very file on an unpushed
 * branch. The gate escalated for blast radius alone and the review said nothing.
 *
 *   node scripts/test-scan-dedupe.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'dedupe-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'dedupe-runs-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'dedupe-ws-'))
delete process.env.JIRA_POST_ENABLED
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const dup = await import('../server/utils/duplicateCheck.ts')
const { fetchExistingTickets } = await import('../server/utils/existingTickets.ts')

// ASECRM-368, as Jira holds it: three findings, the approval one far past 400 characters.
const DESCRIPTION_368 = [
  '## Summary',
  '[backend/subscriber] Onboarding fee resolution, approval rollback and child-subscriber lookup each resolve rows one at a time instead of batching',
  '## Description', '### What was found',
  'Three independent methods in the subscriber module resolve a list of related rows with one `findById` per element inside a loop, instead of a single batched read.',
  '**Finding PERF-005 — SubscriberOnboardingService** resolves each fee type by id, one query per fee row, while onboarding a subscriber with many service allowances.',
  'x'.repeat(300),
  '**Finding PERF-011 — approval rollback**',
  '`backend/subscriber/.../approval/SubscriberApprovalService.java:404-412` reloads each snapshotted service transaction with findById then save.',
  '### Locations', '| File | Line | Description |', '|---|---|---|',
  '| SubscriberOnboardingService.java | 210-230 | fee type per row |',
  '| SubscriberApprovalService.java | 404-412 | rollback per row |',
].join('\n')
const adf = text => ({ type: 'doc', version: 1, content: text.split('\n').map(l => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })) })

// ── 1. the existing ticket carries the code its WHOLE description names ──
const tickets = await fetchExistingTickets({ baseUrl: 'https://jira.test', email: 'a@b', apiToken: 't' }, 'ASECRM', async () => new Response(JSON.stringify({
  isLast: true,
  issues: [
    { key: 'ASECRM-368', fields: { summary: '[backend/subscriber] Onboarding fee resolution, approval rollback and child-subscriber lookup each resolve rows one at a time', status: { name: 'In Progress' }, labels: [], description: adf(DESCRIPTION_368) } },
    { key: 'ASECRM-100', fields: { summary: 'Unrelated', status: { name: 'To Do' }, labels: [], description: adf('Change `frontend/src/pages/index.ts` and docs at https://example.com/a.java') } },
  ],
}), { status: 200, headers: { 'content-type': 'application/json' } }))
const t368 = tickets.find(t => t.key === 'ASECRM-368')
assert.ok(!t368.excerpt.includes('SubscriberApprovalService'), 'the shape of the bug: the shared file is past the excerpt')
assert.ok((t368.locations ?? []).some(l => /SubscriberApprovalService\.java:404-412$/.test(l)), `THE REGRESSION: the ticket's code past its excerpt is not indexed: ${t368.locations}`)
assert.ok(!(tickets.find(t => t.key === 'ASECRM-100').locations ?? []).some(l => l.includes('example.com')), 'a URL is not a file')

// The draft that became ASECRM-584, with its findings' full paths from triage.
const findings = new Map([
  ['PERF-005', { file: 'backend/subscriber/src/main/java/com/alepo/se/crm/subscriber/approval/SubscriberApprovalService.java', line: '404-412' }],
  ['PERF-012', { file: 'backend/subscriber/src/main/java/com/alepo/se/crm/subscriber/approval/SubscriberUnapprovalService.java', line: '145-155' }],
])
const draft584 = { draft_id: 'DRAFT-002', finding_ids: ['PERF-005', 'PERF-012'], summary: '[backend/subscriber] Approval-undo and unapproval guard reload service transactions one row at a time' }

// ── 2. matched by code, though worded differently ──
{
  const m = dup.findDuplicates(draft584, findings, tickets, [])
  assert.equal(m.length, 1, 'THE REGRESSION: a draft whose file an open ticket names was not marked')
  assert.equal(m[0].key, 'ASECRM-368')
  assert.equal(m[0].source, 'ticket')
  assert.deepEqual(m[0].matched, ['SubscriberApprovalService.java:404-412'])
  assert.equal(dup.duplicateSentence(m), 'Possibly covered by ASECRM-368 (SubscriberApprovalService.java:404-412)')

  // What triage had before this change: summary and excerpt, no locations.
  const before = tickets.map(({ locations, ...t }) => t)
  assert.equal(dup.findDuplicates(draft584, findings, before, []).length, 0, 'and the excerpt alone could not have found it - the reason for the index')
}

// ── 3. not marked: other files, and a generic name with no directory ──
{
  const other = { draft_id: 'D9', finding_ids: [], description: 'Fix `backend/pipeline/src/main/java/Foo.java:10`' }
  assert.equal(dup.findDuplicates(other, findings, tickets, []).length, 0, 'a different file is not a duplicate')
  const generic = { draft_id: 'D8', description: 'index.ts loops' }
  assert.equal(dup.findDuplicates(generic, new Map(), tickets, []).length, 0, 'index.ts with no directory matches nothing')
  assert.equal(dup.findDuplicates({ ...draft584, jira_key: 'ASECRM-368' }, findings, tickets, []).length, 0, 'a draft is never its own duplicate')
  // The same file is not the same code: a shared file names many tickets.
  const farAway = new Map([['P1', { file: 'backend/subscriber/src/main/java/com/alepo/se/crm/subscriber/approval/SubscriberApprovalService.java', line: '1200-1210' }]])
  assert.equal(dup.findDuplicates({ draft_id: 'D7', finding_ids: ['P1'] }, farAway, tickets, []).length, 0, 'the same file, far from the ticket\'s lines, is not a duplicate')
  assert.equal(dup.findDuplicates({ draft_id: 'D6', description: 'touches `src/components/data-table.tsx`' }, new Map(), [{ key: 'ASECRM-419', summary: '', status: '', labels: [], excerpt: '', locations: ['src/components/data-table.tsx'] }], []).length, 0, 'a file named without lines on either side is not enough')
  // An elided path matches the full one; a different directory does not.
  assert.ok(dup.sameFile({ path: 'backend/subscriber/.../approval/SubscriberApprovalService.java' }, { path: 'backend/subscriber/src/main/java/com/alepo/se/crm/subscriber/approval/SubscriberApprovalService.java' }))
  assert.ok(!dup.sameFile({ path: 'backend/billing/approval/SubscriberApprovalService.java' }, { path: 'backend/subscriber/approval/SubscriberApprovalService.java' }))
}

// ── 4. a live run for another ticket that changed the file ──
{
  const repo = mkdtempSync(join(tmpdir(), 'dedupe-repo-'))
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  const file = 'backend/subscriber/src/main/java/com/alepo/se/crm/subscriber/approval/SubscriberUnapprovalService.java'
  mkdirSync(join(repo, file, '..'), { recursive: true })
  const lines = Array.from({ length: 300 }, (_, i) => `// line ${i + 1}`)
  writeFileSync(join(repo, file), lines.join('\n') + '\n'); git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  lines[149] = 'List<ServicesTransactions> txns = repo.findAllById(ids);'
  writeFileSync(join(repo, file), lines.join('\n') + '\n'); git('commit', '-qam', 'fix')
  writeFileSync(join(repo, 'README.java'), 'uncommitted\n')
  const run368 = { id: 'run-368', ticketKey: 'ASECRM-368', status: 'paused', projectDir: repo, baseCommit: base, product: { name: 'ase-crm' } }
  const settled = { ...run368, id: 'run-old', ticketKey: 'ASECRM-1', status: 'completed' }
  const otherProduct = { ...run368, id: 'run-ffm', ticketKey: 'FFM-1', product: { name: 'ffm' } }
  const live = await dup.liveRunChanges({ id: 'scan', product: { name: 'ase-crm' } }, [run368, settled, otherProduct])
  assert.deepEqual(live.map(r => r.runId), ['run-368'], 'only a live run, for a ticket, on the same product')
  assert.deepEqual(live[0].changes, [{ path: file, from: 150, to: 150 }], 'its committed change is read from the worktree, as the lines it changed')
  const m = dup.findDuplicates(draft584, findings, [], live)
  assert.equal(m.length, 1, 'THE REGRESSION: the unpushed branch that already fixed it was not seen')
  assert.equal(m[0].source, 'run'); assert.equal(m[0].runId, 'run-368')
  assert.match(dup.duplicateSentence(m), /ASECRM-368 \(SubscriberUnapprovalService\.java:145-155, on its run's unmerged branch\)/)
}

// ── 5. the runner: marked before the gate, held after it ──
const store = await import('../server/utils/workflowRunStore.ts')
const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const wf = { slug: 'scan-dedupe', name: 'Scan', steps: [
  { id: 'prep', agentSlug: 'agent-prep', label: 'Draft Tickets', next: ['gate'] },
  { id: 'gate', agentSlug: 'sdlc-decision-gate', label: 'Decision Gate', next: [] },
] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${wf.slug}.json`), JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))

let seenByGate
runner.setAgentCaller(async (slug, input) => {
  const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
  const w = (n, v) => writeFileSync(join(dir, n), JSON.stringify(v, null, 2))
  if (slug === 'agent-prep') {
    w('existing-tickets.json', { project: 'ASECRM', fetchedAt: new Date().toISOString(), tickets })
    w('triage-report.json', { findings: [...findings].map(([id, f]) => ({ id, ...f, category: 'perf', severity: 'medium' })), existing_tickets_checked: [] })
    w('ticket-drafts.json', [draft584, { draft_id: 'DRAFT-009', finding_ids: [], summary: 'Elsewhere', description: '`backend/pipeline/Foo.java:3`' }])
    return 'drafted'
  }
  // A gate that approves everything, as a careless one might.
  const drafts = JSON.parse(readFileSync(join(dir, 'ticket-drafts.json'), 'utf8'))
  seenByGate = drafts
  w('approved-drafts.json', drafts.map(d => ({ ...d, gate: { verdict: 'auto-approved', reason: 'clear-cut' } })))
  w('escalated-drafts.json', [])
  return 'gated'
})
const { run } = await runner.startOrQueue({ workflow: wf, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true, startedBy: 'dev' })
const done = await runner.waitForSettled(run.id, 15000)
assert.equal(done.status, 'completed', done.error)

assert.equal(seenByGate[0].possible_duplicate_of?.[0]?.key, 'ASECRM-368', 'THE REGRESSION: the gate read drafts the runner had not checked')
assert.equal(seenByGate[1].possible_duplicate_of, undefined, 'and the unrelated draft is not marked')
const dir = join(process.env.AGENT_RUNS_DIR, run.id, 'artifacts')
const approved = JSON.parse(readFileSync(join(dir, 'approved-drafts.json'), 'utf8'))
const escalated = JSON.parse(readFileSync(join(dir, 'escalated-drafts.json'), 'utf8'))
assert.deepEqual(approved.map(d => d.draft_id), ['DRAFT-009'], 'THE REGRESSION: a possible duplicate was auto-approved and would have been filed')
assert.equal(escalated.length, 1)
assert.equal(escalated[0].draft_id, 'DRAFT-002')
assert.equal(escalated[0].gate.verdict, 'escalated')
assert.ok(escalated[0].gate.escalation_criteria.includes('possible_duplicate'))
assert.match(escalated[0].gate.decision_prompt, /^Possibly covered by ASECRM-368 .*fold it into ASECRM-368/)
assert.match(escalated[0].gate.reason, /The gate had approved it: clear-cut/, 'the gate\'s own verdict is kept, not erased')
assert.ok(!escalated[0].gate.reason.includes('Possibly covered'), 'the matches are said once, by the prompt and the mark, not again in the reason')
assert.ok(JSON.parse(readFileSync(join(dir, 'duplicate-check.json'), 'utf8')).drafts.length === 2, 'the check is recorded')

// ── 6. what the reviewer is shown ──
const { loadReviewQueue } = await import('../server/utils/runReview.ts')
const q = await loadReviewQueue({ ...done, status: 'awaiting_review', question: { kind: 'approval', stepId: 'gate', artifact: 'escalated-drafts.json', text: 'review' } })
assert.deepEqual(q.items[0].possibleDuplicateOf, [{ key: 'ASECRM-368', source: 'ticket', matched: ['SubscriberApprovalService.java:404-412'] }], 'the review item carries the mark for the panel')

console.log('ok - a draft an open ticket or a live run already covers is marked by its code, and never auto-filed')
process.exit(0)
