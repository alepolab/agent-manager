/**
 * Self-check for app/utils/workflowGraph.ts - the scheduler behind parallel branches,
 * cycles and monitor retries. No test framework in this repo, so: plain asserts.
 *
 *   node scripts/test-workflow-graph.mjs
 */
import assert from 'node:assert/strict'
import {
  monitorPrompt,
  maxVisitsOf,
  DEFAULT_MAX_VISITS,
  buildGraph,
  initRunState,
  readyNodes,
  markRunning,
  markCompleted,
  isFinished,
  armNode,
  canRevisit,
  joinInputs,
  parseVerdict,
  parseHalt,
  parseSkip,
  edgeKey,
  MAX_CONCURRENCY,
  ancestorsOf,
  gateSatisfied,
  markSkippedByCondition,
  markFailed,
  planDispatch,
} from '../shared/utils/workflowGraph.ts'

/**
 * Drive a graph to completion, recording one entry per wave. `onComplete` may arm a node
 * again, which is how a monitor RETRY verdict behaves.
 */
function simulate(nodes, onComplete = () => {}) {
  const graph = buildGraph(nodes)
  const state = initRunState(graph)
  const waves = []

  for (let guard = 0; guard < 100; guard++) {
    const wave = readyNodes(graph, state).slice(0, MAX_CONCURRENCY)
    if (!wave.length) break
    waves.push(wave)
    for (const id of wave) markRunning(state, id)
    for (const id of wave) {
      const retry = onComplete(id, state, graph)
      if (retry) {
        state.status[id] = 'completed'
        armNode(state, id)
      } else {
        markCompleted(graph, state, id)
      }
    }
  }

  return { graph, state, waves }
}

// Written as a function declaration, not an arrow. As an arrow with a default
// parameter this line was a PARSE error under vue-tsc (TS1005), and a parse
// error aborts the build before the rest of the project is checked - so this
// one line hid 419 further typecheck errors and made CI green on a build that
// never ran. Keep it a declaration.
function step(id, extra = {}) { return { id, ...extra } }

// ── 1. Legacy workflows (no `next`) still walk in array order ──────────────
{
  const { graph, waves, state } = simulate([step('a'), step('b'), step('c')])
  assert.deepEqual(graph.entries, ['a'])
  assert.equal(graph.backEdges.size, 0)
  // The editor freezes this implicit chain into explicit `next` arrays on the first
  // hand-drawn edge, so a legacy workflow must not lose links when it is edited.
  assert.deepEqual(graph.succ, { a: ['b'], b: ['c'], c: [] })
  assert.deepEqual(waves, [['a'], ['b'], ['c']])
  assert.ok(isFinished(graph, state))
}

// ── 2. Fan-out runs in parallel, the join waits for every branch ───────────
{
  const { waves } = simulate([
    step('a', { next: ['b', 'c'] }),
    step('b', { next: ['d'] }),
    step('c', { next: ['d'] }),
    step('d', { next: [] }),
  ])
  assert.deepEqual(waves, [['a'], ['b', 'c'], ['d']], 'b and c share a wave, d waits for both')
}

// ── 3. A branch that finishes early must not drag the join forward ─────────
{
  //   a -> b -> d
  //   a -> c ------> d      (c is one hop, b is two)
  const { waves } = simulate([
    step('a', { next: ['b', 'c'] }),
    step('b', { next: ['e'] }),
    step('c', { next: ['d'] }),
    step('e', { next: ['d'] }),
    step('d', { next: [] }),
  ])
  assert.deepEqual(waves, [['a'], ['b', 'c'], ['e'], ['d']])
}

// ── 4. Back edges: the loop body re-runs, and re-entry propagates forward ──
{
  //   a -> b -> c, and c -> b
  const nodes = [
    step('a', { next: ['b'] }),
    step('b', { next: ['c'], maxVisits: 2 }),
    step('c', { next: ['b'] }),
  ]
  const graph = buildGraph(nodes)
  assert.ok(graph.backEdges.has(edgeKey('c', 'b')), 'c -> b closes the cycle')
  assert.deepEqual(graph.forwardPreds.b, ['a'], 'the back edge must not gate b')
  assert.deepEqual(graph.entries, ['a'])

  const { waves, state } = simulate(nodes)
  assert.deepEqual(waves, [['a'], ['b'], ['c'], ['b'], ['c']], 'second lap re-runs c, not just b')
  assert.equal(state.visits.b, 2)
  assert.equal(state.triggeredBy.b, 'c', 'b knows it was re-entered from c')
}

// ── 4b. A loop must not swallow a parallel branch ─────────────────────────
{
  //   fetch -> repro -> qa          fetch also -> fix -> qa,  and qa loops back to fix.
  //   Cutting the cycle by traversal order would make fix wait on qa and destroy the fan-out.
  const nodes = [
    step('fetch', { next: ['repro', 'fix'] }),
    step('repro', { next: ['qa'] }),
    step('fix', { next: ['qa'] }),
    step('qa', { next: ['fix'], maxVisits: 2 }),
  ]
  const graph = buildGraph(nodes)
  assert.deepEqual([...graph.backEdges], [edgeKey('qa', 'fix')], 'the loop is cut at qa -> fix')
  assert.deepEqual(graph.forwardPreds.fix, ['fetch'], 'fix depends on fetch alone')
  assert.deepEqual(graph.forwardPreds.qa, ['repro', 'fix'], 'qa joins both branches')

  // qa runs twice (its own cap) and the run ends on a fix that consumes qa's last review -
  // stopping a wave earlier would throw that review away.
  const { waves, state } = simulate(nodes)
  assert.deepEqual(waves, [['fetch'], ['repro', 'fix'], ['qa'], ['fix'], ['qa'], ['fix']])
  assert.equal(state.visits.qa, 2)
  assert.equal(state.visits.fix, 3)
}

// ── 5. maxVisits terminates the loop ──────────────────────────────────────
{
  const { state, graph } = simulate([
    step('a', { next: ['b'] }),
    step('b', { next: ['c'], maxVisits: 3 }),
    step('c', { next: ['b'], maxVisits: 3 }),
  ])
  assert.equal(state.visits.b, 3)
  assert.ok(isFinished(graph, state), 'the run ends once the cap is hit')
}

// ── 6. A self-loop is just a back edge onto itself ────────────────────────
{
  const nodes = [step('a', { next: ['a'], maxVisits: 2 })]
  const graph = buildGraph(nodes)
  assert.ok(graph.backEdges.has(edgeKey('a', 'a')))
  assert.deepEqual(graph.entries, ['a'], 'a self-loop still has an entry')
  const { waves } = simulate(nodes)
  assert.deepEqual(waves, [['a'], ['a']])
}

// ── 7. A graph that is one closed loop still starts ───────────────────────
{
  const { waves } = simulate([
    step('a', { next: ['b'], maxVisits: 1 }),
    step('b', { next: ['a'], maxVisits: 1 }),
  ])
  assert.deepEqual(waves, [['a'], ['b']])
}

// ── 8. A monitor RETRY re-runs the node and holds back its successors ─────
{
  let retried = false
  const { waves, state } = simulate(
    [step('a', { next: ['b'] }), step('b', { next: ['c'] }), step('c', { next: [] })],
    (id, s, g) => {
      if (id !== 'b' || retried || !canRevisit(g, s, 'b')) return false
      retried = true
      return true
    },
  )
  assert.deepEqual(waves, [['a'], ['b'], ['b'], ['c']], 'c waits for the retried b')
  assert.equal(state.visits.b, 2)
}

// ── 9. Concurrency is capped ──────────────────────────────────────────────
{
  const fanout = ['b', 'c', 'd', 'e']
  const { waves } = simulate([
    step('a', { next: fanout }),
    ...fanout.map(id => step(id, { next: [] })),
  ])
  assert.equal(waves[1].length, MAX_CONCURRENCY, 'a wave never exceeds the cap')
  assert.deepEqual([...waves[1], ...waves[2]].sort(), fanout, 'the overflow runs in the next wave')
}

// ── 10. Dangling edges are ignored rather than crashing ───────────────────
{
  const { waves } = simulate([step('a', { next: ['ghost', 'b'] }), step('b', { next: [] })])
  assert.deepEqual(waves, [['a'], ['b']])
}

// ── 11. Verdict parsing ───────────────────────────────────────────────────
assert.equal(parseVerdict('looks fine\nVERDICT: CONTINUE'), 'CONTINUE')
assert.equal(parseVerdict('verdict: retry'), 'RETRY')
assert.equal(parseVerdict('I may say VERDICT: RETRY here.\n\nVERDICT: ABORT'), 'ABORT', 'last verdict wins')
assert.equal(parseVerdict('no verdict at all'), 'CONTINUE', 'unreadable means continue')
assert.equal(parseVerdict(''), 'CONTINUE')

// ── 12. Joining branch outputs ────────────────────────────────────────────
assert.equal(joinInputs([{ label: 'A', text: 'one' }]), 'one', 'a single input is passed through bare')
assert.match(joinInputs([{ label: 'A', text: 'one' }, { label: 'B', text: 'two' }]), /## Output from A[\s\S]*## Output from B/)
assert.equal(joinInputs([]), '')

// ancestorsOf: the full transitive forward ancestry
{
  const g = buildGraph([
    { id: 'a', agentSlug: 'x', label: 'A', next: ['b'] },
    { id: 'b', agentSlug: 'x', label: 'B', next: ['c'] },
    { id: 'c', agentSlug: 'x', label: 'C', next: ['d'] },
    { id: 'd', agentSlug: 'x', label: 'D', next: [] },
  ])
  assert.deepEqual(ancestorsOf(g, 'd'), ['c', 'b', 'a'],
    'nearest-first: d sees c, then b, then a')
  assert.deepEqual(ancestorsOf(g, 'a'), [], 'an entry node has no ancestors')

  // A diamond must not report the shared root twice.
  const diamond = buildGraph([
    { id: 'r', agentSlug: 'x', label: 'R', next: ['l', 'm'] },
    { id: 'l', agentSlug: 'x', label: 'L', next: ['j'] },
    { id: 'm', agentSlug: 'x', label: 'M', next: ['j'] },
    { id: 'j', agentSlug: 'x', label: 'J', next: [] },
  ])
  const anc = ancestorsOf(diamond, 'j')
  assert.equal(anc.filter(i => i === 'r').length, 1, 'diamond root appears once')
  assert.deepEqual([...anc].sort(), ['l', 'm', 'r'])

  // A cycle must terminate. buildGraph classifies the closing edge as a
  // back-edge and keeps it out of forwardPreds, so this is really a check
  // that ancestorsOf relies on forwardPreds and nothing else.
  const cyclic = buildGraph([
    { id: 'p', agentSlug: 'x', label: 'P', next: ['q'] },
    { id: 'q', agentSlug: 'x', label: 'Q', next: ['p'] },
  ])
  assert.deepEqual(ancestorsOf(cyclic, 'q'), ['p'], 'cycle terminates')
}

// maxVisits is capped at the policy limit, not clamped at report time.
// cost.attempts in the evidence bundle is the observed visit count and the
// schema caps it at 3; a workflow declaring more would produce a truthful
// number the schema rejects. The cap belongs here, where it is a policy
// decision, not in the reporting, where it would be a falsehood.
{
  assert.equal(maxVisitsOf({ id: 'a', agentSlug: 'x', label: 'A', maxVisits: 5 }), DEFAULT_MAX_VISITS,
    'a workflow asking for more visits than the policy allows gets the policy limit')
  assert.equal(maxVisitsOf({ id: 'a', agentSlug: 'x', label: 'A', maxVisits: 2 }), 2,
    'a lower explicit limit is still honoured')
  assert.equal(maxVisitsOf({ id: 'a', agentSlug: 'x', label: 'A' }), DEFAULT_MAX_VISITS)
}

// parseHalt: a step's structured way of stopping the run
{
  assert.equal(parseHalt('all good'), null, 'ordinary output does not halt')
  assert.equal(parseHalt('tried everything\nPIPELINE-HALT: stack would not come up'),
    'stack would not come up')
  assert.equal(parseHalt('PIPELINE-HALT: first\nPIPELINE-HALT: second'), 'second',
    'the last marker wins, matching parseVerdict')
  assert.equal(parseHalt('the agent may mention PIPELINE-HALT: mid-sentence in prose'), null,
    'the marker must start its own line — prose about it is not a halt')
  assert.equal(parseHalt(''), null)
  assert.equal(parseHalt(undefined), null, 'unreadable output does not halt')
  assert.equal(parseHalt('PIPELINE-HALT:   '), null, 'a marker with no reason is not a halt')
}

// parseSkip: the third honest outcome - work already done, or not applicable
{
  assert.equal(parseSkip('all good'), null, 'ordinary output does not skip')
  assert.equal(parseSkip('checked the compose render\nPIPELINE-SKIP: no stack needed for a static ticket'),
    'no stack needed for a static ticket')
  assert.equal(parseSkip('PIPELINE-SKIP: first\nPIPELINE-SKIP: second'), 'second',
    'the last marker wins, matching parseHalt and parseVerdict')
  assert.equal(parseSkip('the agent may mention PIPELINE-SKIP: mid-sentence in prose'), null,
    'the marker must start its own line - prose about it is not a skip')
  assert.equal(parseSkip(''), null)
  assert.equal(parseSkip(undefined), null, 'unreadable output does not skip')
  assert.equal(parseSkip('PIPELINE-SKIP:   '), null, 'a marker with no reason is not a skip')

  // The two markers are independent, and a step emitting both is in trouble
  // rather than idle - the runner checks halt first for exactly this reason.
  const both = 'PIPELINE-SKIP: nothing to do\nPIPELINE-HALT: actually blocked'
  assert.equal(parseHalt(both), 'actually blocked', 'a halt is still detected alongside a skip')
  assert.equal(parseSkip(both), 'nothing to do', 'a skip is still detected alongside a halt')
  assert.equal(parseSkip('PIPELINE-HALT: blocked'), null, 'a halt alone is not a skip')
  assert.equal(parseHalt('PIPELINE-SKIP: idle'), null, 'a skip alone is not a halt')
}

// monitorPrompt carries the artifacts dir and tells the monitor to read files
// before it sends a step back for missing proof. The largest source of wasted
// retries was a step doing the work but not pasting the evidence into its
// output; the monitor has a Read tool and must use it.
{
  const withDir = monitorPrompt({ label: 'Verify', agentSlug: 'sdlc-verifier', input: 'in', output: 'out', artifactsDir: '/runs/abc/artifacts' })
  assert.ok(withDir.includes('/runs/abc/artifacts'), 'the prompt names the artifacts directory to read')
  assert.match(withDir, /Read the files/i, 'and instructs reading them before a RETRY')
  assert.match(withDir, /RETRY only when the evidence is absent from both the output and the files/i, 'RETRY only when proof is in neither')
  const noDir = monitorPrompt({ label: 'Verify', agentSlug: 'sdlc-verifier', input: 'in', output: 'out' })
  assert.ok(noDir.includes('named in the input'), 'without a dir it still points the monitor at the files')
  assert.ok(noDir.includes('VERDICT: CONTINUE') && noDir.includes('VERDICT: ABORT'), 'the three verdicts survive')
}

// ── gateSatisfied: the emptiness rules a runWhen condition decides on ──────
// Table-driven over the SHAPE, not over the one case that prompted this: an
// empty escalated-drafts.json. The dimension that varies is what JSON a
// producing step can legitimately leave behind, and every row of it must land
// on one of the three verdicts on purpose rather than by accident.
{
  const cases = [
    // raw,            verdict,  a fragment of the sentence a reviewer reads
    [null, 'skip', /was not written/],
    ['', 'skip', /is empty/],
    ['   \n\t ', 'skip', /is empty/],
    ['[]', 'skip', /empty array/],
    ['[{}]', 'run', /1 entry/],
    ['[1,2,3]', 'run', /3 entries/],
    ['{}', 'skip', /empty object/],
    ['{"a":1}', 'run', /1 key/],
    ['{"a":1,"b":2}', 'run', /2 keys/],
    ['""', 'skip', /empty string/],
    ['"x"', 'run', /a string/],
    ['null', 'skip', /null/],
    ['0', 'skip', /0/],
    ['5', 'run', /5/],
    ['false', 'skip', /false/],
    ['true', 'run', /true/],
    ['not json', 'error', /not valid JSON/],
    ['{', 'error', /not valid JSON/],
    ['[1,2', 'error', /not valid JSON/],
  ]
  for (const [raw, verdict, detail] of cases) {
    const got = gateSatisfied(raw)
    assert.equal(got.verdict, verdict, `gateSatisfied(${JSON.stringify(raw)}) should be ${verdict}, got ${got.verdict}`)
    // The detail is not decoration: it becomes the step's skipReason and the
    // sentence the join downstream is handed, so a person has to be able to
    // read what was actually found.
    assert.match(got.detail, detail, `gateSatisfied(${JSON.stringify(raw)}) detail: ${got.detail}`)
  }
  // Missing and malformed are deliberately DIFFERENT verdicts: a file nobody
  // wrote is "no work here"; a file that is not JSON is a producer that broke,
  // and reading that as "no work here" would complete a run having done nothing.
  assert.equal(gateSatisfied(null).verdict, 'skip')
  assert.equal(gateSatisfied('{').verdict, 'error')
  assert.equal(gateSatisfied('[]').count, 0)
  assert.equal(gateSatisfied('[1,2,3]').count, 3)
}

// ── markSkippedByCondition clears `armed`, or the resolution loop hangs ────
// markCompleted does not clear it; markRunning normally does, and a condition
// skip deliberately never calls markRunning. This is the regression that
// matters: leave `armed` set and readyNodes hands the node straight back
// forever.
{
  const nodes = [step('a', { next: ['b', 'c'] }), step('b', { next: ['d'] }), step('c', { next: ['d'] }), step('d', { next: [] })]
  const graph = buildGraph(nodes)
  const state = initRunState(graph)

  markRunning(state, 'a')
  markCompleted(graph, state, 'a')
  assert.deepEqual(readyNodes(graph, state).sort(), ['b', 'c'])

  markSkippedByCondition(graph, state, 'b')
  assert.equal(state.armed.b, false, 'a condition skip must disarm the node')
  assert.equal(state.status.b, 'completed', 'graph status is completed so the join is not wedged')
  assert.deepEqual(readyNodes(graph, state), ['c'], 'the skipped node must not come back')
  // No visit, no billing: nothing was attempted.
  assert.equal(state.visits.b, 0, 'a condition skip spends no visit')
  assert.equal(state.totalRuns, 1, 'and no totalRun')

  // The AND-join still waits for the branch that IS running.
  assert.equal(state.armed.d, false, 'the join must not arm until c completes')
  markRunning(state, 'c')
  markCompleted(graph, state, 'c')
  assert.deepEqual(readyNodes(graph, state), ['d'], 'the join arms once the live branch completes')

  // And it still does not come back after the join runs.
  markRunning(state, 'd')
  markCompleted(graph, state, 'd')
  assert.deepEqual(readyNodes(graph, state), [])
  assert.ok(isFinished(graph, state))
}

// ── Both branches skipped: the join still runs, the graph still terminates ─
{
  const nodes = [step('a', { next: ['b', 'c'] }), step('b', { next: ['d'] }), step('c', { next: ['d'] }), step('d', { next: [] })]
  const graph = buildGraph(nodes)
  const state = initRunState(graph)
  markRunning(state, 'a'); markCompleted(graph, state, 'a')
  markSkippedByCondition(graph, state, 'b')
  markSkippedByCondition(graph, state, 'c')
  assert.deepEqual(readyNodes(graph, state), ['d'], 'a join whose every branch was empty still runs')
  markRunning(state, 'd'); markCompleted(graph, state, 'd')
  assert.ok(isFinished(graph, state))
}

// ── A terminal conditional step: skipping it FINISHES the run ──────────────
// Guards the stuck detector in the runner, which reports "No step can run"
// when something is still schedulable. A skipped tail is a completed run.
{
  const graph = buildGraph([step('a', { next: ['b'] }), step('b', { next: [] })])
  const state = initRunState(graph)
  markRunning(state, 'a'); markCompleted(graph, state, 'a')
  markSkippedByCondition(graph, state, 'b')
  assert.deepEqual(readyNodes(graph, state), [])
  assert.ok(isFinished(graph, state), 'a workflow ending in a skipped conditional step is finished, not stuck')
}

// ── Wave shape: the skipped branch never appears in a wave ─────────────────
{
  const nodes = [step('a', { next: ['b', 'c'] }), step('b', { next: ['d'] }), step('c', { next: ['d'] }), step('d', { next: [] })]
  const graph = buildGraph(nodes)
  const state = initRunState(graph)
  const waves = []
  for (let guard = 0; guard < 100; guard++) {
    // Mirrors runWave: conditions resolve BEFORE the wave is chosen.
    for (const id of readyNodes(graph, state)) {
      if (id === 'b') markSkippedByCondition(graph, state, id)
    }
    const wave = readyNodes(graph, state).slice(0, MAX_CONCURRENCY)
    if (!wave.length) break
    waves.push(wave)
    for (const id of wave) markRunning(state, id)
    for (const id of wave) markCompleted(graph, state, id)
  }
  assert.deepEqual(waves, [['a'], ['c'], ['d']], 'b is skipped before the wave, so it never occupies a slot')
  assert.ok(isFinished(graph, state))
}

// ── A failed condition is a normal failure: disarmed, and not 'completed' ──
{
  const graph = buildGraph([step('a', { next: ['b'] }), step('b', { next: ['c'] }), step('c', { next: [] })])
  const state = initRunState(graph)
  markRunning(state, 'a'); markCompleted(graph, state, 'a')
  markFailed(state, 'b')
  assert.equal(state.armed.b, false)
  assert.deepEqual(readyNodes(graph, state), [], 'an unevaluable condition must not arm anything downstream')
  assert.equal(state.armed.c, false, 'c stays unarmed - the run fails rather than skipping past')
}

// ── planDispatch: which children a triggerWorkflow step starts ────────────
// Same shape as the gateSatisfied table above: the artifact's TEXT in, a
// decision and the sentence a reviewer reads out.
{
  const ROUTES = { bug: 'runbook-a', security: 'runbook-a', feature: 'runbook-b' }
  const routing = { source: 'created-tickets.json', routeBy: 'work_type', routes: ROUTES }

  // Nothing to dispatch is not a failure - the step ran and found no work.
  const cases = [
    // raw,                       cfg,       expected target count, a fragment of the sentence
    [null, routing, 0, /was not written/],
    ['', routing, 0, /is empty/],
    ['   ', routing, 0, /is empty/],
    ['[]', routing, 0, /empty array/],
    ['[{"jira_key":"A-1","work_type":"bug"}]', routing, 1, /1 entry to dispatch/],
    ['[{"key":"A-1","work_type":"bug"},{"key":"A-2","work_type":"feature"}]', routing, 2, /2 entries to dispatch/],
    // A static slug and no routing at all is the single-target form.
    ['[{"key":"A-1"},{"key":"A-2"}]', { source: 's.json', slug: 'runbook-a' }, 2, /2 entries/],
  ]
  for (const [raw, cfg, count, detail] of cases) {
    const got = planDispatch(raw, cfg)
    assert.equal(got.error, undefined, `planDispatch(${JSON.stringify(raw)}) should not error, got: ${got.error}`)
    assert.equal(got.targets.length, count, `planDispatch(${JSON.stringify(raw)}) should plan ${count}, got ${got.targets.length}`)
    assert.match(got.detail, detail, `planDispatch(${JSON.stringify(raw)}) detail: ${got.detail}`)
  }

  // Malformed is an error, never "nothing to dispatch": a producer that
  // crashed mid-write must not read as a scan with no findings.
  const errors = [
    ['not json', routing, /not valid JSON/],
    ['{"jira_key":"A-1"}', routing, /holds object, not the array/],
    ['"A-1"', routing, /holds string, not the array/],
    ['null', routing, /holds null, not the array/],
    // Routing is all-or-nothing, and the sentence names what had no route.
    ['[{"key":"A-1","work_type":"bug"},{"key":"A-2","work_type":"docs"}]', routing, /A-2 routes on "work_type": "docs", which is in no route/],
    ['[{"key":"A-1"}]', routing, /A-1 has no "work_type" to route on/],
    ['[{"key":"A-1"}]', { source: 's.json' }, /names no workflow to dispatch to/],
  ]
  for (const [raw, cfg, detail] of errors) {
    const got = planDispatch(raw, cfg)
    assert.ok(got.error, `planDispatch(${JSON.stringify(raw)}) should error`)
    assert.equal(got.targets.length, 0, 'an errored plan dispatches nothing at all')
    assert.match(got.error, detail, `planDispatch(${JSON.stringify(raw)}) error: ${got.error}`)
  }

  // Routing picks per entry, and the fallback slug catches what routes miss.
  const mixed = planDispatch(
    '[{"key":"A-1","work_type":"bug"},{"key":"A-2","work_type":"feature"},{"key":"A-3","work_type":"docs"}]',
    { ...routing, slug: 'runbook-c' },
  )
  assert.deepEqual(mixed.targets.map(t => [t.key, t.slug]), [
    ['A-1', 'runbook-a'], ['A-2', 'runbook-b'], ['A-3', 'runbook-c'],
  ], 'each entry routes on its own field, and an unrouted one falls back')
  assert.equal(mixed.targets[0].entry.work_type, 'bug', 'the entry travels with the target, for the child prompt')

  // An entry with no identifying field is named by its position, so a report
  // can still say which one it was.
  const unnamed = planDispatch('[{"work_type":"bug"},{"work_type":"bug"}]', routing)
  assert.deepEqual(unnamed.targets.map(t => t.key), ['entry 1', 'entry 2'])

  // A non-object entry has no field to route on: it fails, named by position.
  const scalar = planDispatch('["A-1"]', routing)
  assert.match(scalar.error, /entry 1 has no "work_type" to route on/)
}

console.log('workflowGraph: all checks passed')
