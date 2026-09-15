/**
 * A drafts artifact is read the same way by every step that consumes it.
 *
 *   node scripts/test-artifact-shapes.mjs
 *
 * The drafting agents are told to write "a JSON array of ticket objects". On
 * 2026-09-11 the drafter wrote one. On 2026-09-15, from an unchanged prompt and
 * unchanged code, it wrapped the same array in
 * `{note, run_id, repo, checkout, drafts: [...]}` - and the run failed, because
 * the two consumers disagreed about what that meant:
 *
 *   gateSatisfied  -> "an object with 5 keys" -> RUN the step
 *   planDispatch   -> "holds object, not an array" -> dispatch nothing, fail
 *
 * So an EMPTY drafts array inside a wrapper ran a create step that had nothing
 * to create, and a full one dispatched nobody. The dimension that varies is the
 * SHAPE the agent chose, so that is what this table covers.
 */
import assert from 'node:assert/strict'
import { entriesOf, gateSatisfied, planDispatch } from '../shared/utils/workflowGraph.ts'

const draft = (id, work_type = 'bug') => ({ draft_id: id, work_type, summary: `s-${id}` })
const cfg = { source: 'approved-drafts.json', routeBy: 'work_type', routes: { bug: 'runbook-a' } }

const ROWS = [
  { name: 'bare array, one entry',      json: [draft('D-1')],                                   entries: 1 },
  { name: 'bare array, empty',          json: [],                                               entries: 0 },
  { name: 'wrapper, one entry',         json: { note: 'n', run_id: 'r', drafts: [draft('D-1')] }, entries: 1 },
  { name: 'wrapper, empty array',       json: { note: 'n', run_id: 'r', drafts: [] },            entries: 0 },
  { name: 'wrapper, differently named', json: { tickets: [draft('D-1')], count: 1 },             entries: 1 },
]

for (const row of ROWS) {
  const raw = JSON.stringify(row.json)

  // 1. The gate and the dispatch step agree on how many entries there are.
  const gate = gateSatisfied(raw)
  assert.equal(gate.count, row.entries, `${row.name}: the gate counts ${row.entries}`)
  assert.equal(gate.verdict, row.entries ? 'run' : 'skip',
    `${row.name}: an empty artifact skips its step whatever shape it arrived in`)

  const plan = planDispatch(raw, cfg)
  assert.equal(plan.targets.length, row.entries, `${row.name}: dispatch plans ${row.entries} child run(s)`)
  assert.equal(plan.error, undefined, `${row.name}: and calls it no error`)
}

// Genuinely ambiguous shapes are still refused - guessing which array a step
// meant is exactly the silent wrong answer this is here to avoid.
for (const row of [
  { name: 'two arrays', json: { drafts: [draft('D-1')], skipped: [draft('D-2')] } },
  { name: 'no array at all', json: { note: 'nothing here' } },
  { name: 'a bare string', json: 'DRAFT-001' },
]) {
  const raw = JSON.stringify(row.json)
  assert.equal(entriesOf(JSON.parse(raw)), null, `${row.name}: no single array to read`)
  assert.ok(planDispatch(raw, cfg).error, `${row.name}: dispatch refuses it rather than guessing`)
}

// And the absent/unwritten cases are unchanged.
assert.equal(gateSatisfied(null).verdict, 'skip')
assert.equal(planDispatch(null, cfg).detail, 'was not written')
assert.ok(planDispatch('{not json', cfg).error)

console.log('artifact shapes: every consumer reads a drafts file the same way, however the agent shaped it')
