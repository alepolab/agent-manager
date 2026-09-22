/**
 * A gate can answer "this step should not happen".
 *
 * A reviewer could approve, reject, send back or stop. Someone who wanted none
 * of those was stuck: a Jira transition step on a run whose ticket must not
 * move, where approving does the wrong thing, rejecting ends a healthy run,
 * and sending back re-does work that was fine. The only option left was to
 * stop the run over one step nobody wanted.
 *
 *   node scripts/test-skip-step.mjs
 */
import assert from 'node:assert/strict'
import { buildGraph, initRunState, markRunning, markCompleted, markSkipped, readyNodes, isFinished } from '../shared/utils/workflowGraph.ts'

const steps = [
  { id: 'a', agentSlug: 'x', label: 'A', next: ['b'] },
  { id: 'b', agentSlug: 'x', label: 'Jira: In Progress', next: ['c'] },
  { id: 'c', agentSlug: 'x', label: 'C' },
]
const graph = buildGraph(steps)

// ---- A skipped step is not a completed one, and the run carries on ------
{
  const state = initRunState(graph)
  markRunning(state, 'a'); markCompleted(graph, state, 'a')
  assert.deepEqual(readyNodes(graph, state), ['b'])

  markSkipped(graph, state, 'b')
  assert.equal(state.status.b, 'skipped', 'skipped, never completed — it produced no output to read as evidence')
  assert.deepEqual(readyNodes(graph, state), ['c'],
    'and its successor is armed, so the run does not stall with nothing running')
}

// ---- Skipping the last step settles the run ----------------------------
{
  const state = initRunState(graph)
  markRunning(state, 'a'); markCompleted(graph, state, 'a')
  markSkipped(graph, state, 'b')
  markRunning(state, 'c'); markCompleted(graph, state, 'c')
  assert.deepEqual(readyNodes(graph, state), [], 'nothing left')
  assert.equal(state.status.b, 'skipped', 'and the skip is still on the record at the end')
}

// ---- A skip on a branching step takes its edges regardless of outcome ---
// A step that did not run produced no verdict to branch on, so a conditional
// successor must not be left waiting for a `pass` that can never arrive.
{
  const branching = buildGraph([
    { id: 'p', agentSlug: 'x', label: 'P', next: [{ to: 'q', when: 'pass' }, { to: 'r', when: 'fail' }] },
    { id: 'q', agentSlug: 'x', label: 'Q' },
    { id: 'r', agentSlug: 'x', label: 'R' },
  ])
  const state = initRunState(branching)
  markSkipped(branching, state, 'p')
  // Either something is ready, or the run is finished. What must never happen
  // is a run left `running` with nothing ready and nothing to explain it.
  assert.ok(readyNodes(branching, state).length > 0 || isFinished(branching, state),
    'a skipped branch either arms a successor or settles the run — never stalls')
}

console.log('skip step: a skipped step is not a completed one, its successors still run, and a skipped branch cannot deadlock')
