/**
 * Self-check for `jira: { action: 'create' }` — the step that turns approved
 * drafts into real issues.
 *
 *   node scripts/test-jira-create.mjs
 *
 * The behaviour this proves exists at all: JiraStepConfig modelled only
 * transition/comment/attach, so the `action`/`source` the scan workflows have
 * always declared were read by nothing. `runJiraStep` returned "Nothing
 * configured for this Jira step", the step completed green, and the pipeline
 * whose purpose is filing tickets filed none.
 *
 * A stub fetch stands in for Jira, so every branch — refusal, malformed reply,
 * a network throw, posting disabled — is exercised without an account.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'jiracreate-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'jiracreate-artifacts-'))
process.env.JIRA_BASE_URL = 'https://jira.invalid'
process.env.JIRA_EMAIL = 'someone@example.invalid'
process.env.JIRA_API_TOKEN = 'not-a-real-token'
delete process.env.JIRA_POST_ENABLED

const { createIssuesFrom, createFromArtifact } = await import('../server/utils/jiraCreate.ts')
const { runJiraStep } = await import('../server/utils/jiraSteps.ts')
const artifacts = await import('../server/utils/runArtifacts.ts')

const run = { id: 'run-1', workflowName: 'Scan', steps: [], status: 'running', startedBy: undefined }

const draft = (over = {}) => ({
  draft_id: 'DRAFT-001',
  summary: 'Validate the payment amount',
  description: 'Body line one\n\nBody line two',
  acceptance_criteria: ['the amount is rejected when negative'],
  fields: { project: 'SEC', issue_type: 'Bug', priority: 'High', component: 'billing/charge.py', labels: ['scan'] },
  ...over,
})

/** Records what was sent and answers as Jira would. */
function stubJira(answers) {
  const sent = []
  const impl = async (url, init) => {
    sent.push({ url, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers })
    const next = answers.shift()
    if (typeof next === 'function') return next()
    return {
      ok: next.ok ?? true,
      status: next.status ?? 201,
      json: async () => next.json ?? {},
      text: async () => next.text ?? '',
    }
  }
  impl.sent = sent
  return impl
}

// ── 1. Posting disabled: nothing is sent, nothing is claimed ──────────────
{
  const entry = draft()
  const out = await createIssuesFrom(run, [{ index: 0, entry }], stubJira([]))
  assert.equal(out.length, 1)
  assert.equal(out[0].jiraKey, undefined, 'no key is invented')
  assert.match(out[0].line, /Would create a Bug in SEC/, 'it says what it would have done')
  assert.match(out[0].line, /JIRA_POST_ENABLED is not 1/, 'and exactly why it did not')
  assert.equal(entry.jira_key, undefined, 'and stamps nothing onto the entry')
}

process.env.JIRA_POST_ENABLED = '1'

// ── 2. Posting enabled: one issue per entry, stamped back onto the entry ──
{
  const entries = [draft(), draft({ draft_id: 'DRAFT-002', summary: 'Second' })]
  const fetchImpl = stubJira([{ json: { key: 'SEC-11' } }, { json: { key: 'SEC-12' } }])
  const out = await createIssuesFrom(run, entries.map((entry, index) => ({ index, entry })), fetchImpl)

  assert.deepEqual(out.map(o => o.jiraKey), ['SEC-11', 'SEC-12'])
  assert.deepEqual(entries.map(e => e.jira_key), ['SEC-11', 'SEC-12'], 'the key is stamped onto the entry')
  // jira_key is the FIRST of workflowGraph's ENTRY_KEY_FIELDS, which is the
  // whole reason for stamping: a dispatch step downstream names its child run
  // after the real ticket instead of "entry 2".
  assert.deepEqual(entries.map(e => e.work_type), ['bug', 'bug'], 'and the work_type a dispatch routes on')
  assert.equal(fetchImpl.sent.length, 2)
  assert.equal(fetchImpl.sent[0].url, 'https://jira.invalid/rest/api/3/issue')

  const body = fetchImpl.sent[0].body.fields
  assert.deepEqual(body.project, { key: 'SEC' })
  assert.deepEqual(body.issuetype, { name: 'Bug' })
  assert.deepEqual(body.priority, { name: 'High' })
  assert.deepEqual(body.labels, ['scan'])
  assert.equal(body.summary, 'Validate the payment amount')
  // v3 rejects a plain string for description; it must be an ADF document.
  assert.equal(body.description.type, 'doc')
  assert.equal(body.description.version, 1)
  const text = JSON.stringify(body.description)
  assert.match(text, /Body line one/)
  assert.match(text, /the amount is rejected when negative/, 'acceptance criteria travel into the body')
  assert.match(text, /billing\/charge\.py/, 'and so does the code location')
  // The scanner's component is a file path, not a Jira component: sending it as
  // one fails against any project that has not defined it by that name.
  assert.equal(body.components, undefined, 'the code location is never sent as a Jira component')
}

// ── 3. work_type: stated wins, and only unambiguous types are inferred ────
{
  const ROWS = [
    { name: 'stated on the entry', entry: draft({ work_type: 'infra' }), expect: 'infra' },
    { name: 'stated wins over the issue type', entry: draft({ work_type: 'change_request' }), expect: 'change_request' },
    { name: 'Bug inverts', entry: draft({ fields: { project: 'SEC', issue_type: 'Bug' } }), expect: 'bug' },
    { name: 'Security inverts', entry: draft({ fields: { project: 'SEC', issue_type: 'Security' } }), expect: 'security' },
    // A Task could have come from infra or from a change request. Guessing
    // would route the child pipeline to a runbook nobody chose; leaving it
    // unset makes the dispatch step say so by name.
    { name: 'Task is not guessed', entry: draft({ fields: { project: 'SEC', issue_type: 'Task' } }), expect: undefined },
    { name: 'Story is not guessed', entry: draft({ fields: { project: 'SEC', issue_type: 'Story' } }), expect: undefined },
  ]
  for (const row of ROWS) {
    await createIssuesFrom(run, [{ index: 0, entry: row.entry }], stubJira([{ json: { key: 'SEC-20' } }]))
    assert.equal(row.entry.work_type, row.expect, `work_type: ${row.name}`)
  }
}

// ── 4. A field that cannot be guessed is named, never defaulted ───────────
{
  const ROWS = [
    { name: 'no project', entry: draft({ fields: { issue_type: 'Bug' } }), match: /missing project/ },
    { name: 'no issue type', entry: draft({ fields: { project: 'SEC' } }), match: /missing issue_type/ },
    { name: 'no summary', entry: draft({ summary: '' }), match: /missing summary/ },
    { name: 'no fields at all', entry: { description: 'x' }, match: /missing project, issue_type, summary/ },
  ]
  for (const row of ROWS) {
    const fetchImpl = stubJira([{ json: { key: 'SEC-99' } }])
    const [out] = await createIssuesFrom(run, [{ index: 0, entry: row.entry }], fetchImpl)
    assert.match(out.error, row.match, `refusal names what is missing: ${row.name}`)
    assert.equal(out.jiraKey, undefined, `${row.name}: nothing is claimed`)
    assert.equal(fetchImpl.sent.length, 0, `${row.name}: and nothing is sent`)
  }
}

// ── 5. A refusal or a throw is a sentence, never an exception ─────────────
{
  const ROWS = [
    { name: 'Jira refuses it', answers: [{ ok: false, status: 400, text: 'field priority is not on the screen' }], match: /HTTP 400.*not on the screen/ },
    { name: 'Jira answers with no key', answers: [{ json: {} }], match: /returned no issue key/ },
    { name: 'the network throws', answers: [() => { throw new Error('ECONNREFUSED') }], match: /ECONNREFUSED/ },
  ]
  for (const row of ROWS) {
    const entry = draft()
    const [out] = await createIssuesFrom(run, [{ index: 0, entry }], stubJira(row.answers))
    assert.match(out.line, row.match, `reported as a sentence: ${row.name}`)
    assert.equal(entry.jira_key, undefined, `${row.name}: and the entry claims no ticket`)
  }
}

// ── 6. One bad entry must not cost the batch its other tickets ────────────
{
  const entries = [draft(), draft({ fields: { issue_type: 'Bug' } }), draft({ draft_id: 'DRAFT-003' })]
  const out = await createIssuesFrom(
    run, entries.map((entry, index) => ({ index, entry })),
    stubJira([{ json: { key: 'SEC-31' } }, { json: { key: 'SEC-32' } }]),
  )
  assert.deepEqual(out.map(o => o.jiraKey), ['SEC-31', undefined, 'SEC-32'],
    'the entry that could not be filed does not take the others down with it')
}

// ── 7. createFromArtifact writes the keys back and records them ───────────
{
  const dir = artifacts.runArtifactsDir('run-7')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'approved-drafts.json'), JSON.stringify([draft(), draft({ draft_id: 'DRAFT-002' })], null, 2))

  const r7 = { ...run, id: 'run-7' }
  const output = await createFromArtifact(r7, 'approved-drafts.json', stubJira([{ json: { key: 'SEC-41' } }, { json: { key: 'SEC-42' } }]))
  assert.match(output, /Created SEC-41 in SEC/)
  assert.match(output, /Created SEC-42 in SEC/)

  const after = JSON.parse(readFileSync(join(dir, 'approved-drafts.json'), 'utf8'))
  assert.deepEqual(after.map(e => e.jira_key), ['SEC-41', 'SEC-42'], 'the artifact carries the keys afterwards')
  const created = JSON.parse(readFileSync(join(dir, 'tickets-created.json'), 'utf8'))
  assert.deepEqual(created.map(c => c.jira_key), ['SEC-41', 'SEC-42'], 'and the run records what it filed')

  // A second create in the same run appends rather than replacing: the
  // auto-approved branch and the reviewed one both file tickets.
  writeFileSync(join(dir, 'more-drafts.json'), JSON.stringify([draft({ draft_id: 'DRAFT-003' })], null, 2))
  await createFromArtifact(r7, 'more-drafts.json', stubJira([{ json: { key: 'SEC-43' } }]))
  const both = JSON.parse(readFileSync(join(dir, 'tickets-created.json'), 'utf8'))
  assert.deepEqual(both.map(c => c.jira_key), ['SEC-41', 'SEC-42', 'SEC-43'], 'a second creating step does not erase the first')
}

// ── 8. An artifact with nothing in it is an outcome, not a failure ────────
{
  const dir = artifacts.runArtifactsDir('run-8')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'empty.json'), '[]')
  assert.match(await createFromArtifact({ ...run, id: 'run-8' }, 'empty.json', stubJira([])), /Created nothing: empty\.json holds no entries/)
  assert.match(await createFromArtifact({ ...run, id: 'run-8' }, 'absent.json', stubJira([])), /Created nothing: absent\.json was not written/)
  writeFileSync(join(dir, 'broken.json'), '{')
  assert.match(await createFromArtifact({ ...run, id: 'run-8' }, 'broken.json', stubJira([])), /not valid JSON/)
  assert.match(await createFromArtifact({ ...run, id: 'run-8' }, '../../../etc/passwd', stubJira([])), /outside the run's artifacts directory/)
}

// ── 9. The step itself: a creating step needs no ticket key of its own ────
{
  const dir = artifacts.runArtifactsDir('run-9')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'approved-drafts.json'), JSON.stringify([draft()], null, 2))
  const r9 = { ...run, id: 'run-9', ticketKey: undefined }

  // Before this change the guard below returned PIPELINE-SKIP first, so a
  // create step on a run with no ticket of its own produced nothing at all.
  const out = await runJiraStep(r9, { action: 'create', source: 'approved-drafts.json' }, stubJira([{ json: { key: 'SEC-51' } }]))
  assert.match(out, /Created SEC-51 in SEC/, 'a create step runs without the run having a ticket key')
  assert.doesNotMatch(out, /PIPELINE-SKIP/)

  // And a create step that names no source says so rather than silently passing.
  assert.match(await runJiraStep(r9, { action: 'create' }, stubJira([])), /names no artifact to create them from/)

  // A step configured for nothing at all still reports that, and now mentions
  // creation among the things it could have been set to do.
  assert.match(await runJiraStep({ ...r9, ticketKey: 'SEC-1' }, {}, stubJira([])), /Nothing configured for this Jira step.*ticket creation/)
}

console.log('jira create: declared drafts become real issues, and every refusal is named')
