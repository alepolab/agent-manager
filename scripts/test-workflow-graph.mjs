/**
 * Self-check for app/utils/workflowGraph.ts - the scheduler behind parallel branches,
 * cycles and monitor retries. No test framework in this repo, so: plain asserts.
 *
 *   node scripts/test-workflow-graph.mjs
 */
import assert from 'node:assert/strict'
import {
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
  edgeKey,
  MAX_CONCURRENCY,
  ancestorsOf,
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

const step = (id, extra = {}) => ({ id, ...extra })

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

console.log('workflowGraph: all checks passed')
