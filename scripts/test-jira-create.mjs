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

/**
 * The project schema a stub answers createmeta with. Permissive by default —
 * every case that is not ABOUT the schema should behave as it did before it
 * existed.
 */
function schemaBody({ priorities = ['High', 'Medium', 'Low'], required = [] } = {}) {
  const fields = {
    summary: { name: 'Summary', required: true },
    priority: { name: 'Priority', required: false, allowedValues: priorities.map(name => ({ name })) },
  }
  for (const f of required) fields[f.id] = { name: f.name, required: true, hasDefaultValue: false }
  return { projects: [{ issuetypes: [{ fields }] }] }
}

/** Records what was sent and answers as Jira would.
 *
 *  createmeta is answered from `schema` and does NOT consume the answer queue:
 *  the queue is about the issues a case files, and creation now asks what the
 *  project accepts before filing the first one. */
function stubJira(answers, schema = schemaBody()) {
  const sent = []
  const impl = async (url, init) => {
    sent.push({ url, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers })
    if (String(url).includes('/issue/createmeta')) {
      return { ok: true, status: 200, json: async () => schema, text: async () => '' }
    }
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
  impl.posts = () => sent.filter(s => !String(s.url).includes('/issue/createmeta'))
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
  assert.equal(fetchImpl.posts().length, 2)
  assert.ok(fetchImpl.sent.some(r => String(r.url).includes("/issue/createmeta")), "it asks what the project accepts before filing anything")
  assert.equal(fetchImpl.posts()[0].url, 'https://jira.invalid/rest/api/3/issue')

  const body = fetchImpl.posts()[0].body.fields
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
    assert.equal(fetchImpl.posts().length, 0, `${row.name}: and nothing is sent`)
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


// ── 10. The project's own schema decides what may be sent ─────────────────
//
// A real run drafted three good tickets and had all three refused: priority
// "High" against a Blocker/Critical/Major/Minor scheme, plus two required
// custom fields nobody had asked about. Both are one GET away.
{
  // A priority the scheme does not offer is dropped, and the issue still files.
  const entry = draft({ fields: { project: 'SEC', issue_type: 'Bug', priority: 'High' } })
  const fetchImpl = stubJira([{ json: { key: 'SEC-60' } }], schemaBody({ priorities: ['Blocker', 'Critical', 'Major', 'Minor'] }))
  const out = await createIssuesFrom(run, [{ index: 0, entry }], fetchImpl)

  assert.equal(out[0].jiraKey, 'SEC-60', 'the ticket matters more than the field')
  assert.equal(fetchImpl.posts()[0].body.fields.priority, undefined, 'the invalid priority is never sent')
  assert.match(out[0].line, /without priority "High"/, 'and the line says what was dropped')
  assert.match(out[0].line, /Blocker, Critical, Major, Minor/, 'naming what the project does offer')
}
{
  // A priority the scheme DOES offer travels untouched.
  const entry = draft({ fields: { project: 'SEC', issue_type: 'Bug', priority: 'Major' } })
  const fetchImpl = stubJira([{ json: { key: 'SEC-61' } }], schemaBody({ priorities: ['Blocker', 'Major'] }))
  await createIssuesFrom(run, [{ index: 0, entry }], fetchImpl)
  assert.deepEqual(fetchImpl.posts()[0].body.fields.priority, { name: 'Major' })
}
{
  // A required field with no value is refused BEFORE the POST, by name and id.
  const entry = draft()
  const fetchImpl = stubJira([], schemaBody({
    required: [{ id: 'customfield_10182', name: 'Steps to Reproduce' }, { id: 'customfield_10202', name: 'Business Value' }],
  }))
  const out = await createIssuesFrom(run, [{ index: 0, entry }], fetchImpl)

  assert.equal(out[0].jiraKey, undefined)
  assert.equal(fetchImpl.posts().length, 0, 'nothing is sent that Jira would only refuse')
  assert.match(out[0].line, /Steps to Reproduce \(customfield_10182\)/)
  assert.match(out[0].line, /Business Value \(customfield_10202\)/)
}
{
  // Supplied values satisfy it, by field id or by the human name.
  const rows = [
    { name: 'by id', custom: { customfield_10182: 'Call the endpoint twice.' } },
    { name: 'by name', custom: { 'Steps to Reproduce': 'Call the endpoint twice.' } },
    { name: 'by name, different case', custom: { 'steps to reproduce': 'Call the endpoint twice.' } },
  ]
  for (const row of rows) {
    const entry = draft({ fields: { project: 'SEC', issue_type: 'Bug', custom: row.custom } })
    const fetchImpl = stubJira([{ json: { key: 'SEC-62' } }], schemaBody({
      required: [{ id: 'customfield_10182', name: 'Steps to Reproduce' }],
    }))
    const out = await createIssuesFrom(run, [{ index: 0, entry }], fetchImpl)
    assert.equal(out[0].jiraKey, 'SEC-62', `${row.name}: the required field is satisfied`)
    assert.ok(fetchImpl.posts()[0].body.fields.customfield_10182, `${row.name}: and travels under its id`)
  }
}
{
  // A schema lookup that fails files exactly as before it existed.
  const entry = draft({ fields: { project: 'SEC', issue_type: 'Bug', priority: 'High' } })
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/issue/createmeta')) return { ok: false, status: 403, json: async () => ({}), text: async () => '' }
    return { ok: true, status: 201, json: async () => ({ key: 'SEC-63' }), text: async () => '' }
  }
  const out = await createIssuesFrom(run, [{ index: 0, entry }], fetchImpl)
  assert.equal(out[0].jiraKey, 'SEC-63', 'an unreadable schema must not become a new way for creation to stop')
}

function seed(id, name, entries) {
  const dir = artifacts.runArtifactsDir(id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify(entries, null, 2))
}

// ── 11. A step that created nothing must not report success ───────────────
//
// The run that prompted this filed none of three, reported itself completed,
// and dispatched three child pipelines at tickets that did not exist.
{
  const r11 = { ...run, id: 'run-11' }
  seed(r11.id, 'approved-drafts.json', [draft(), draft({ draft_id: 'DRAFT-002' })])
  const refuse = { ok: false, status: 400, text: 'the priority selected is invalid' }
  const output = await createFromArtifact(r11, 'approved-drafts.json', stubJira([refuse, refuse]))

  assert.match(output, /^PIPELINE-HALT: /, 'zero created out of two is a halt, not a result')
  assert.match(output, /nothing downstream has a ticket to work on/)
  assert.match(output, /the priority selected is invalid/, 'and the refusals are still reported verbatim')
}
{
  // One created out of two is NOT a halt: the batch did some of its job.
  const r11b = { ...run, id: 'run-11b' }
  seed(r11b.id, 'approved-drafts.json', [draft(), draft({ draft_id: 'DRAFT-002' })])
  const output = await createFromArtifact(r11b, 'approved-drafts.json', stubJira([
    { json: { key: 'SEC-70' } },
    { ok: false, status: 400, text: 'nope' },
  ]))
  assert.doesNotMatch(output, /PIPELINE-HALT/)
  assert.match(output, /Created SEC-70/)
}
{
  // And a dry run creates nothing BY DESIGN, so it never halts.
  const saved = process.env.JIRA_POST_ENABLED
  process.env.JIRA_POST_ENABLED = ''
  const r11c = { ...run, id: 'run-11c' }
  seed(r11c.id, 'approved-drafts.json', [draft()])
  const output = await createFromArtifact(r11c, 'approved-drafts.json', stubJira([]))
  assert.doesNotMatch(output, /PIPELINE-HALT/, 'a dry run created nothing on purpose')
  assert.match(output, /Would create/)
  process.env.JIRA_POST_ENABLED = saved
}

console.log('jira create: declared drafts become real issues, and every refusal is named')
