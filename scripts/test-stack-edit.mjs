/**
 * Self-check for shared/utils/stackEdit.ts: every edit the stack builder can
 * make, and the save check that stands between those edits and the file.
 *
 * The rule these protect: an edit either produces a stack that saves to a
 * graph the stack can draw again, or it is refused with a sentence a person
 * can act on. Nothing is ever mutated in place.
 *
 *   node scripts/test-stack-edit.mjs
 */
import assert from 'node:assert/strict'

const E = await import('../shared/utils/stackEdit.ts')
const { toStack, stepKind, stepIdsOf } = await import('../shared/utils/workflowStack.ts')
const { buildGraph } = await import('../shared/utils/workflowGraph.ts')
const { workflowTemplates, materializeTemplateSteps } = await import('../app/utils/workflowTemplates.ts')

const S = id => ({ kind: 'step', stepId: id })
const P = (branches, rejoin = true) => ({ kind: 'paths', branches, rejoin })
const step = (id, next, extra = {}) => ({ id, label: id.toUpperCase(), agentSlug: 'x', ...(next ? { next } : {}), ...extra })
const frozen = v => JSON.stringify(v)

// ── 1. addressing ──────────────────────────────────────────────────────────
{
  const blocks = [S('a'), P([[S('b'), S('c')], [S('d')]]), S('e')]
  assert.deepEqual(E.findStep(blocks, 'e'), { seq: [], index: 2 })
  assert.deepEqual(E.findStep(blocks, 'c'), { seq: [{ block: 1, branch: 0 }], index: 1 })
  assert.equal(E.findStep(blocks, 'zz'), null)
  assert.deepEqual(E.seqAt(blocks, [{ block: 1, branch: 1 }]), [S('d')])
  assert.throws(() => E.seqAt(blocks, [{ block: 0, branch: 0 }]), /not a split/)
}

// ── 2. insert, remove, move — never in place ───────────────────────────────
{
  const blocks = [S('a'), S('b')]
  const before = frozen(blocks)
  assert.deepEqual(E.insertStep(blocks, { seq: [], index: 1 }, 'n'), [S('a'), S('n'), S('b')])
  assert.deepEqual(E.insertStep(blocks, { seq: [], index: 2 }, 'n'), [S('a'), S('b'), S('n')])
  assert.deepEqual(E.removeStep(blocks, 'a'), [S('b')])
  assert.deepEqual(E.moveWithin(blocks, [], 0, 1), [S('b'), S('a')])
  assert.equal(frozen(blocks), before, 'the input is untouched')
  assert.throws(() => E.removeStep(blocks, 'zz'), /Unknown step "zz"/)
  assert.throws(() => E.moveWithin(blocks, [], 0, 5), /out of range/)

  const nested = [S('a'), P([[S('b'), S('c')], [S('d')]]), S('e')]
  assert.deepEqual(E.moveWithin(nested, [{ block: 1, branch: 0 }], 1, 0), [S('a'), P([[S('c'), S('b')], [S('d')]]), S('e')])
  assert.deepEqual(E.insertStep(nested, { seq: [{ block: 1, branch: 1 }], index: 0 }, 'n'), [S('a'), P([[S('b'), S('c')], [S('n'), S('d')]]), S('e')])
}

// ── 3. paths: split, branches, rejoin ──────────────────────────────────────
{
  assert.deepEqual(E.splitAt([S('a'), S('b')], { seq: [], index: 1 }), [S('a'), P([[], []]), S('b')])
  assert.throws(() => E.splitAt([S('a'), P([[S('b')], [S('c')]])], { seq: [{ block: 1, branch: 0 }], index: 1 }), /one level of paths/)

  const at = { seq: [], index: 1 }
  const withPaths = [S('a'), P([[S('b')], [S('c')]]), S('d')]
  assert.deepEqual(E.addBranch(withPaths, at), [S('a'), P([[S('b')], [S('c')], []]), S('d')])
  assert.deepEqual(E.removeBranch(E.addBranch(withPaths, at), at, 2), withPaths)
  assert.deepEqual(E.removeBranch(withPaths, at, 1), [S('a'), S('b'), S('d')], 'one branch left: the split unwraps in place')

  assert.throws(() => E.setRejoin(withPaths, at, false), /Steps follow these paths, so they have to rejoin/)
  const last = [S('a'), P([[S('b')], [S('c')]])]
  assert.deepEqual(E.setRejoin(last, at, false), [S('a'), P([[S('b')], [S('c')]], false)])

  const open = [S('a'), P([[S('b')], [S('c')]], false)]
  assert.throws(() => E.insertStep(open, { seq: [], index: 2 }, 'n'), /Nothing can follow paths that end separately/)
  assert.throws(() => E.splitAt(open, { seq: [], index: 2 }), /Nothing can follow paths that end separately/)
  assert.throws(() => E.moveWithin([S('a'), S('b'), P([[S('c')], [S('d')]], false)], [], 2, 0), /have to stay last/)
}

// ── 4. prune ───────────────────────────────────────────────────────────────
assert.deepEqual(E.pruneEmptyPaths([S('a'), P([[], []]), S('b')]), [S('a'), S('b')])
assert.deepEqual(E.pruneEmptyPaths([S('a'), P([[S('b')], []]), S('c')]), [S('a'), P([[S('b')], []]), S('c')], 'one empty branch is a real shape (b is optional)')
assert.deepEqual(E.pruneEmptyPaths([P([[P([[], []])], [S('b')]])]), [P([[], [S('b')]])], 'nested all-empty splits go first')

// ── 5. canSave: shipped workflows, edited, still round-trip ────────────────
for (const t of workflowTemplates.filter(x => ['runbook-a-jira-to-diff', 'scan-security-to-dispatch'].includes(x.id))) {
  const steps = materializeTemplateSteps(t, Object.fromEntries(t.steps.map(s => [s.agentTemplateId, s.agentTemplateId])))
  const blocks = toStack(steps).blocks
  const added = E.newStep('agent', { agentSlug: 'sdlc-verifier', id: 'new-step' })
  const edited = E.insertStep(blocks, { seq: [], index: 1 }, added.id)
  const r = E.canSave(edited, [...steps, added])
  assert.ok(r.ok, `${t.id}: ${r.reason}`)
  assert.equal(r.steps.length, steps.length + 1)
  assert.deepEqual(stepIdsOf(toStack(r.steps).blocks).sort(), [...steps.map(s => s.id), 'new-step'].sort(), `${t.id}: every step survives`)
  const firstId = stepIdsOf(blocks)[0]
  assert.deepEqual(r.steps.find(s => s.id === firstId).next, ['new-step'], `${t.id}: the new step follows the first`)
  assert.ok(r.steps.every(s => Array.isArray(s.next)), 'every step has explicit next[]')
  const original = steps.find(s => s.id === firstId)
  assert.equal(r.steps.find(s => s.id === firstId).label, original.label, 'other fields untouched')
}
{
  // Removing a step reconnects its neighbours.
  const steps = [step('a', ['b']), step('b', ['c']), step('c', [])]
  const r = E.canSave(E.removeStep(toStack(steps).blocks, 'b'), steps)
  assert.ok(r.ok)
  assert.deepEqual(r.steps.map(s => [s.id, s.next]), [['a', ['c']], ['c', []]])
}
{
  // An empty split is dropped on save rather than saved as nothing.
  const steps = [step('a'), step('b')]
  const r = E.canSave([S('a'), P([[], []]), S('b')], steps)
  assert.ok(r.ok)
  assert.deepEqual(buildGraph(r.steps).succ, { a: ['b'], b: [] })
}
{
  // A stack whose graph would not draw again is refused with toStack's reason:
  // a branch that opens with its own split meets before the other branch does.
  const steps = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => step(id))
  const uneven = [S('a'), P([[P([[S('b')], [S('c')]]), S('e')], [S('d')]]), S('f')]
  const r = E.canSave(uneven, steps)
  assert.equal(r.ok, false, 'fromStack writes it, but toStack cannot draw it again')
  assert.match(r.reason, /brings "B" and "C" together before the other branches after "A" meet/)
  const bad = E.canSave([S('a'), P([[S('b')], [S('c')]], false), S('d')], steps.slice(0, 4))
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /follow after paths that do not rejoin/)
}

// ── 6. new steps carry the config their kind needs ─────────────────────────
{
  const kinds = { 'agent': 'agent', 'jira': 'jira', 'jira-create': 'jira-create', 'notify': 'notify', 'loop': 'loop' }
  for (const [kind, expected] of Object.entries(kinds)) {
    const s = E.newStep(kind, { agentSlug: kind === 'agent' ? 'sdlc-verifier' : undefined })
    assert.equal(stepKind(s), expected, `${kind} reads back as ${expected}`)
    assert.equal(s.agentSlug, kind === 'agent' ? 'sdlc-verifier' : E.ACTION_AGENT[kind])
    assert.equal(s.label, kind === 'agent' ? 'sdlc-verifier' : E.ACTION_LABEL[kind])
    assert.match(s.id, /^[0-9a-f-]{36}$/)
  }
  assert.deepEqual(E.newStep('jira-create', {}).jira, { action: 'create' })
  assert.deepEqual(E.newStep('notify', {}).notify, { channel: '' })
  assert.throws(() => E.newStep('agent', {}), /Choose an agent/)
}

console.log('stackEdit: all checks passed')
