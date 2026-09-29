/**
 * Self-check for shared/utils/workflowStack.ts: the workflow graph as a
 * vertical stack of steps and paths.
 *
 * The rule these protect: every workflow the team ships converts, converts
 * back to the same graph, and a graph the stack cannot draw is refused with a
 * reason rather than reshaped.
 *
 *   node scripts/test-workflow-stack.mjs
 */
import assert from 'node:assert/strict'

const { toStack, fromStack, stackForRun, stepIdsOf, sendBackArrows, stepKind } = await import('../shared/utils/workflowStack.ts')
const { buildGraph } = await import('../shared/utils/workflowGraph.ts')
const { workflowTemplates, RUNBOOK_FILES, materializeTemplateSteps } = await import('../app/utils/workflowTemplates.ts')

/** Successors as sorted lists, so implicit and explicit `next` compare equal. */
const succOf = steps => Object.fromEntries(Object.entries(buildGraph(steps).succ).map(([k, v]) => [k, [...v].sort()]))
const step = (id, next, extra = {}) => ({ id, label: id.toUpperCase(), ...(next ? { next } : {}), ...extra })

// ── 1. every shipped workflow converts, and round-trips ────────────────────
const shipped = workflowTemplates.filter(t => RUNBOOK_FILES[t.id])
assert.ok(shipped.length >= 11, `expected the 11 shipped workflows, got ${shipped.length}`)
for (const t of shipped) {
  const slugs = Object.fromEntries(t.steps.map(s => [s.agentTemplateId, s.agentTemplateId]))
  const steps = materializeTemplateSteps(t, slugs)
  const r = toStack(steps)
  assert.ok(r.ok, `${t.id} converts: ${r.ok ? '' : r.reason}`)
  const ids = stepIdsOf(r.blocks)
  assert.equal(ids.length, steps.length, `${t.id}: every step appears once`)
  assert.equal(new Set(ids).size, steps.length, `${t.id}: no step appears twice`)
  assert.deepEqual(succOf(fromStack(r.blocks, steps)), succOf(steps), `${t.id}: fromStack gives back the same graph`)
}

// ── 2. the two shapes the team uses ────────────────────────────────────────
{
  const runbookA = workflowTemplates.find(t => t.id === 'runbook-a-jira-to-diff')
  const steps = materializeTemplateSteps(runbookA, Object.fromEntries(runbookA.steps.map(s => [s.agentTemplateId, s.agentTemplateId])))
  const r = toStack(steps)
  const paths = r.blocks.filter(b => b.kind === 'paths')
  assert.equal(paths.length, 1, 'Runbook A splits once')
  assert.equal(paths[0].branches.length, 3, 'into three parallel steps')
  assert.equal(paths[0].rejoin, true, 'which rejoin')

  const scan = workflowTemplates.find(t => t.id === 'scan-security-to-dispatch')
  const s2 = materializeTemplateSteps(scan, Object.fromEntries(scan.steps.map(s => [s.agentTemplateId, s.agentTemplateId])))
  const r2 = toStack(s2)
  const last = r2.blocks.at(-1)
  assert.equal(last.kind, 'paths', 'a scan ends in paths')
  assert.equal(last.rejoin, false, 'whose branches end separately')
}

// ── 3. simple shapes ───────────────────────────────────────────────────────
assert.deepEqual(toStack([]), { ok: true, blocks: [] })
assert.deepEqual(toStack([step('a'), step('b'), step('c')]).blocks.map(b => b.stepId), ['a', 'b', 'c'], 'no next = array order')
{
  // a -> [b, c]; b -> d; c -> d  (diamond)
  const r = toStack([step('a', ['b', 'c']), step('b', ['d']), step('c', ['d']), step('d', [])])
  assert.ok(r.ok)
  assert.deepEqual(r.blocks, [
    { kind: 'step', stepId: 'a' },
    { kind: 'paths', rejoin: true, branches: [[{ kind: 'step', stepId: 'b' }], [{ kind: 'step', stepId: 'c' }]] },
    { kind: 'step', stepId: 'd' },
  ])
}
{
  // a -> [b, d]; b -> d : one branch is empty (goes straight on)
  const steps = [step('a', ['b', 'd']), step('b', ['d']), step('d', [])]
  const r = toStack(steps)
  assert.ok(r.ok)
  assert.deepEqual(r.blocks[1].branches, [[{ kind: 'step', stepId: 'b' }], []])
  assert.deepEqual(succOf(fromStack(r.blocks, steps)), succOf(steps))
}
{
  // nested paths meeting at the outer join: a -> [b, c]; b -> [d, e]; d, e, c -> f
  const steps = [step('a', ['b', 'c']), step('b', ['d', 'e']), step('c', ['f']), step('d', ['f']), step('e', ['f']), step('f', [])]
  const r = toStack(steps)
  assert.ok(r.ok, r.reason)
  assert.equal(r.blocks[1].branches[0][1].kind, 'paths', 'the inner split sits inside the first branch')
  assert.deepEqual(succOf(fromStack(r.blocks, steps)), succOf(steps))
}

// ── 4. refused, with a reason ──────────────────────────────────────────────
{
  const back = toStack([step('a', ['b']), step('b', ['a'])])
  assert.equal(back.ok, false)
  assert.match(back.reason, /back to an earlier step/)

  const two = toStack([step('a', []), step('b', [])])
  assert.equal(two.ok, false)
  assert.match(two.reason, /2 first steps/)

  // a -> [b, c]; b -> [d, e]; c -> e; d -> f; e -> f : e joins steps from two branches
  const cross = toStack([step('a', ['b', 'c']), step('b', ['d', 'e']), step('c', ['e']), step('d', ['f']), step('e', ['f']), step('f', [])])
  assert.equal(cross.ok, false)
  assert.match(cross.reason, /"E"/, 'the reason names the step by label')

  // a -> [b, c, d]; b -> e; c -> e; e -> f; d -> f : b and c meet at e, before d's branch meets them at f
  const early = toStack([step('a', ['b', 'c', 'd']), step('b', ['e']), step('c', ['e']), step('e', ['f']), step('d', ['f']), step('f', [])])
  assert.equal(early.ok, false)
  assert.match(early.reason, /brings "B" and "C" together before the other branches after "A" meet/)
}

// ── 5. fromStack refuses a step after paths that do not rejoin ─────────────
assert.throws(
  () => fromStack([
    { kind: 'step', stepId: 'a' },
    { kind: 'paths', rejoin: false, branches: [[{ kind: 'step', stepId: 'b' }], [{ kind: 'step', stepId: 'c' }]] },
    { kind: 'step', stepId: 'd' },
  ], [step('a'), step('b'), step('c'), step('d')]),
  /after paths that do not rejoin/,
)

// ── 6. a run whose workflow changed is shown in run order ──────────────────
{
  const wf = [step('a', ['b', 'c']), step('b', ['d']), step('c', ['d']), step('d', [])]
  assert.equal(stackForRun(wf, ['a', 'b', 'c', 'd']).note, undefined)
  assert.equal(stackForRun(wf, ['a', 'b', 'c', 'd']).blocks[1].kind, 'paths')
  const changed = stackForRun(wf, ['a', 'x'])
  assert.deepEqual(changed.blocks, [{ kind: 'step', stepId: 'a' }, { kind: 'step', stepId: 'x' }])
  assert.match(changed.note, /changed since this run/)
  assert.match(stackForRun(null, ['a']).note, /no longer exists/)
}

// ── 7. send-back arrows merge people and agents, oldest first ──────────────
{
  const arrows = sendBackArrows({
    decisions: [
      { stepId: 'gate', verdict: 'approved', by: 'amy', at: 1, label: 'Gate', waitedMs: 0 },
      { stepId: 'gate', verdict: 'sent-back', target: 'fix', by: 'amy', note: 'tighten', at: 30, label: 'Gate', waitedMs: 0 },
    ],
    sendBacks: [{ from: 'verify', target: 'fix', instruction: 'JPY', by: 'agent:sdlc-verifier', at: 10 }],
  })
  assert.deepEqual(arrows, [
    { from: 'verify', to: 'fix', by: 'agent:sdlc-verifier', note: 'JPY', at: 10 },
    { from: 'gate', to: 'fix', by: 'amy', note: 'tighten', at: 30 },
  ])
}

// ── 8. step kinds ──────────────────────────────────────────────────────────
assert.equal(stepKind(undefined), 'agent')
assert.equal(stepKind({ agentSlug: 'x' }), 'agent')
assert.equal(stepKind({ jira: { transition: 'In Review' } }), 'jira')
assert.equal(stepKind({ jira: { action: 'create', source: 'a.json' } }), 'jira-create')
assert.equal(stepKind({ notify: { channel: 'c' } }), 'notify')
assert.equal(stepKind({ triggerWorkflow: { source: 'x' } }), 'loop')

console.log('workflowStack: all checks passed')
