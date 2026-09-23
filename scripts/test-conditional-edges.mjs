/**
 * A workflow must be able to branch on what a step decided.
 *
 * Before this, `next` was an unconditional fan-out: markCompleted armed EVERY
 * successor, so a graph could express "do these in parallel" and "loop back",
 * but never "on FAIL go here, on PASS go there". The conditional routing that
 * did exist lived in agent prose — PIPELINE-REWORK, matched fuzzily against
 * step labels, and a miss killed the run (workflowRunner.ts records one that
 * cost 70.3 minutes and $7.96). None of it was in the graph, so the canvas
 * could not draw it and a reader could not see that a step could send work
 * back.
 *
 * The property that makes branching safe is the one a fan-out never needed:
 * a target whose only predecessor took the OTHER arm must be settled, not left
 * pending, or every join below it waits on a step that will never run.
 *
 *   node scripts/test-conditional-edges.mjs
 */
import assert from 'node:assert/strict'
import {
  buildGraph, initRunState, readyNodes, markRunning, markCompleted, markFailed, edgeKey,
} from '../shared/utils/workflowGraph.ts'

/** Drive a graph to quiescence, answering each step from `outcomes`. */
function drive(nodes, outcomes = {}) {
  const g = buildGraph(nodes)
  const st = initRunState(g)
  const order = []
  for (let guard = 0; guard < 50; guard++) {
    const ready = readyNodes(g, st)
    if (!ready.length) break
    const id = ready[0]
    markRunning(st, id)
    order.push(id)
    if (outcomes[id] === 'FAILSTEP') markFailed(st, id)
    else markCompleted(g, st, id, outcomes[id])
  }
  return { g, st, order }
}

// ---- 1. Unconditional graphs are untouched -------------------------------
{
  const { st, order } = drive([
    { id: 'a', next: ['b', 'c'] },
    { id: 'b', next: ['d'] },
    { id: 'c', next: ['d'] },
    { id: 'd', next: [] },
  ])
  assert.deepEqual(order, ['a', 'b', 'c', 'd'], 'a plain fan-out still fans out and still joins')
  assert.equal(st.status.d, 'completed', 'the join ran')
  assert.ok(Object.values(st.status).every(s => s !== 'skipped'), 'nothing is skipped without a condition')
}

// ---- 2. A branch takes exactly one arm -----------------------------------
const review = [
  { id: 'build', next: ['review'] },
  { id: 'review', next: [{ to: 'fixit', when: 'fail' }, { to: 'ship', when: 'pass' }] },
  { id: 'fixit', next: [] },
  { id: 'ship', next: [] },
]
{
  const { st, order } = drive(review, { review: 'fail' })
  assert.ok(order.includes('fixit'), 'a FAIL must reach the step that can fix it')
  assert.ok(!order.includes('ship'), 'a FAIL must not reach ship')
  assert.equal(st.status.ship, 'skipped', 'the arm not taken is skipped, not left pending')
  assert.equal(st.edges[edgeKey('review', 'ship')], false, 'the untaken edge is decided false, not absent')
  assert.equal(st.edges[edgeKey('review', 'fixit')], true, 'the taken edge is recorded')
}
{
  const { st, order } = drive(review, { review: 'pass' })
  assert.ok(order.includes('ship') && !order.includes('fixit'), 'a PASS ships and does not rework')
  assert.equal(st.status.fixit, 'skipped')
}

// ---- 3. `default` is the else arm ----------------------------------------
{
  const nodes = [
    { id: 'gate', next: [{ to: 'urgent', when: 'fail' }, { to: 'normal', when: 'default' }] },
    { id: 'urgent', next: [] },
    { id: 'normal', next: [] },
  ]
  const passed = drive(nodes, { gate: 'pass' })
  assert.ok(passed.order.includes('normal'), 'default catches an outcome no sibling matched')
  assert.equal(passed.st.status.urgent, 'skipped')

  const failed = drive(nodes, { gate: 'fail' })
  assert.ok(failed.order.includes('urgent'), 'an explicit match beats default')
  assert.equal(failed.st.status.normal, 'skipped', 'default must NOT also fire when a sibling matched')
}

// ---- 4. The join below a branch must not hang ----------------------------
// This is the property that makes conditional routing usable at all: `done`
// has two forward predecessors and only one arm ever runs.
{
  const { st, order } = drive([
    { id: 'review', next: [{ to: 'fixit', when: 'fail' }, { to: 'ship', when: 'pass' }] },
    { id: 'fixit', next: ['done'] },
    { id: 'ship', next: ['done'] },
    { id: 'done', next: [] },
  ], { review: 'pass' })
  assert.ok(order.includes('done'), 'the join must run even though one predecessor was skipped')
  assert.equal(st.status.fixit, 'skipped')
  assert.equal(st.status.done, 'completed')
}

// ---- 5. Skipping propagates through a chain ------------------------------
{
  const { st } = drive([
    { id: 'gate', next: [{ to: 'x1', when: 'fail' }, { to: 'ok', when: 'pass' }] },
    { id: 'x1', next: ['x2'] },
    { id: 'x2', next: ['x3'] },
    { id: 'x3', next: [] },
    { id: 'ok', next: [] },
  ], { gate: 'pass' })
  for (const id of ['x1', 'x2', 'x3']) {
    assert.equal(st.status[id], 'skipped', `${id} is unreachable and must be skipped, not pending`)
  }
}

// ---- 6. A failed step still blocks, as it always has ---------------------
// `failed` must never be treated as a settled predecessor: that would let a run
// walk past a step that blew up.
{
  const { st } = drive([
    { id: 'a', next: ['b'] },
    { id: 'b', next: ['c'] },
    { id: 'c', next: [] },
  ], { b: 'FAILSTEP' })
  assert.equal(st.status.b, 'failed')
  assert.equal(st.status.c, 'pending', 'a failed predecessor blocks its target rather than skipping past it')
}

// ---- 7. Loops still loop -------------------------------------------------
// The back edge is conditional here, which is the shape a bounded retry wants:
// go round again only on FAIL.
{
  const nodes = [
    { id: 'work', next: ['check'] },
    { id: 'check', maxVisits: 3, next: [{ to: 'work', when: 'fail' }, { to: 'out', when: 'pass' }] },
    { id: 'out', next: [] },
  ]
  const g = buildGraph(nodes)
  assert.ok(g.backEdges.has(edgeKey('check', 'work')), 'the arm pointing back is still classified a back edge')
  assert.equal(g.conditions[edgeKey('check', 'work')], 'fail', 'a back edge may carry a condition')

  const st = initRunState(g)
  markRunning(st, 'work'); markCompleted(g, st, 'work')
  markRunning(st, 'check'); markCompleted(g, st, 'check', 'fail')
  assert.equal(st.armed.work, true, 'a FAIL sends the loop round again')
  assert.notEqual(st.status.out, 'skipped', 'the exit is not dead while the loop can still run')
}

// ---- 8. buildGraph keeps conditions out of the shape ---------------------
// succ, back-edge classification and layout must not change because an edge
// gained a condition — everything that asks "where can this go" gets the same
// answer it always did.
{
  const plain = buildGraph([{ id: 'a', next: ['b'] }, { id: 'b', next: [] }])
  const cond = buildGraph([{ id: 'a', next: [{ to: 'b', when: 'fail' }] }, { id: 'b', next: [] }])
  assert.deepEqual(cond.succ, plain.succ, 'a condition must not change the shape of the graph')
  assert.deepEqual(cond.forwardPreds, plain.forwardPreds)
  assert.deepEqual(cond.conditions, { [edgeKey('a', 'b')]: 'fail' })
  assert.deepEqual(plain.conditions, {}, 'an unconditional graph records no conditions')
}

console.log('conditional edges: one arm taken, the other skipped, joins still join, loops still loop, failures still block')
