/**
 * Self-check for the `panel` step kind (shared/utils/verdictPanel.ts,
 * server/utils/panelStep.ts, and the runner's panel branch).
 *
 * A stub agent caller plays two members. One fails the change; the runner
 * must send the run back to the implementer with the findings, as many times
 * as the panel's maxLoops allows, then pause with question.reason 'rework'
 * for a person. Along the way: the implementer's session id never reaches a
 * member (no `resume` on any member call, and no member input carries the
 * implementer's output); every member verdict lands under panel/<slug>.json;
 * a verdict the schema rejects counts as a fail.
 *
 *   node scripts/test-panel-step.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'panel-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'panel-artifacts-'))

const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const V = await import('../shared/utils/verdictPanel.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')
const { stepKind } = await import('../shared/utils/workflowStack.ts')
const { canSave, newStep } = await import('../shared/utils/stackEdit.ts')
const { toStack } = await import('../shared/utils/workflowStack.ts')

const TIMEOUT = 30_000
const schema = JSON.parse(readFileSync(new URL('../engineering/schemas/verdict.v0.1.schema.json', import.meta.url), 'utf8'))

// ── 1. The pure parts: parsing, schema, aggregation ───────────────────────
{
  const good = '{"verdict":"pass","ticket":"T-1","criteria":[{"id":"c1","result":"pass","evidence":["ran x"]}],"risks":[]}'
  const r = V.readMemberVerdict({ agentSlug: 'a' }, `some prose\n\`\`\`json\n${good}\n\`\`\`\n`, schema, 'T-1')
  assert.ok(r.verdict, 'a fenced verdict is read')
  assert.equal(r.verdict.verdict, 'pass')

  const bad = V.readMemberVerdict({ agentSlug: 'b' }, '{"verdict":"maybe","ticket":"T-1","criteria":[],"risks":[]}', schema, 'T-1')
  assert.equal(bad.verdict, undefined, 'a verdict outside the enum is rejected')
  assert.ok(bad.problems.some(p => /verdict/.test(p)), `the schema problem names the field: ${bad.problems}`)

  const missing = V.readMemberVerdict({ agentSlug: 'c' }, '{"verdict":"pass","ticket":"T-1","criteria":[]}', schema, 'T-1')
  assert.ok(missing.problems.some(p => /risks/.test(p)), 'a missing required key is a problem')

  const other = V.readMemberVerdict({ agentSlug: 'd' }, good, schema, 'T-2')
  assert.ok(other.problems.some(p => /T-1/.test(p) && /T-2/.test(p)), 'a verdict about another ticket is refused')

  const none = V.readMemberVerdict({ agentSlug: 'e' }, 'I looked and it seems fine.', schema, 'T-1')
  assert.match(none.problems[0], /without a JSON verdict/)

  // Objects in prose before the verdict do not confuse it; the last `verdict` object wins.
  const two = V.extractVerdict('{"note":"x"} then {"verdict":"fail","ticket":"T-1","criteria":[],"risks":["r"]} and {"verdict":"pass","ticket":"T-1","criteria":[],"risks":[]}')
  assert.equal(two.verdict, 'pass')

  const agg = V.aggregateVerdicts([r, bad])
  assert.equal(agg.verdict, 'fail', 'one unusable member fails the panel')
  assert.deepEqual(agg.failing, ['b'])
  assert.match(agg.findings, /no usable verdict/)

  const allPass = V.aggregateVerdicts([r, { agentSlug: 'z', verdict: { verdict: 'pass', ticket: 'T-1', criteria: [], risks: ['latent'] }, problems: [] }])
  assert.equal(allPass.verdict, 'pass')
  assert.match(allPass.summary, /latent/, 'risks from a passing member are carried into the summary')

  // Config validation refuses the shapes a blank builder field produces.
  assert.deepEqual(V.validatePanelConfig({ members: [{ agentSlug: 'a' }], budgetTokens: 10, maxLoops: 1 }), [])
  assert.ok(V.validatePanelConfig({ members: [], budgetTokens: 10, maxLoops: 1 }).length)
  assert.ok(V.validatePanelConfig({ members: [{ agentSlug: 'a' }], budgetTokens: 0, maxLoops: 1 }).length)
  assert.ok(V.validatePanelConfig({ members: [{ agentSlug: 'a' }], budgetTokens: 10, maxLoops: 0 }).length)

  // Risk adds the protocol specialist once, for protocol and money, and never twice.
  assert.deepEqual(V.membersForRisk([{ agentSlug: 'x' }], 'docs').map(m => m.agentSlug), ['x'])
  assert.deepEqual(V.membersForRisk([{ agentSlug: 'x' }], 'protocol').map(m => m.agentSlug), ['x', 'sdlc-specialist-protocol'])
  assert.deepEqual(V.membersForRisk([{ agentSlug: 'x' }], 'money').map(m => m.agentSlug), ['x', 'sdlc-specialist-protocol'])
  assert.deepEqual(V.membersForRisk([{ agentSlug: 'sdlc-specialist-protocol' }], 'money').map(m => m.agentSlug), ['sdlc-specialist-protocol'])
  assert.deepEqual(V.membersForRisk([{ agentSlug: 'x' }], 'docs', 'protocol').map(m => m.agentSlug), ['x', 'sdlc-specialist-protocol'], 'a risk policy naming the specialist wins over the radius')
  assert.deepEqual(V.membersForRisk([{ agentSlug: 'x' }], 'protocol', 'none').map(m => m.agentSlug), ['x'], 'and a policy saying none is honoured')

  // The brief carries the facts and nothing else.
  const brief = V.panelMemberBrief({ ticketKey: 'T-1', criteria: 'AC1: it works', diffRange: 'abc..def', tests: { unit: 'make test' }, stack: { project: 'sdlc-x', endpoints: ['http://h:1'] }, artifactsDir: '/a', member: { agentSlug: 'm', criterion: 'only this' } })
  for (const want of ['T-1', 'abc..def', 'AC1: it works', 'make test', 'http://h:1', 'only this', '"verdict":"pass|fail"']) assert.ok(brief.includes(want), `brief carries ${want}`)
  assert.equal(V.endpointsFrom('up at http://localhost:8080/api and https://h:9/x.').join(','), 'http://localhost:8080/api,https://h:9/x')
}

// ── 2. The builder accepts a panel step ───────────────────────────────────
{
  const step = newStep('panel', {})
  assert.equal(stepKind(step), 'panel')
  assert.equal(step.panel.members.length, 3)
  const steps = [{ id: 'a', agentSlug: 'agent-a', label: 'A', next: [step.id] }, { ...step, next: [] }]
  const stack = toStack(steps)
  assert.ok(stack.ok)
  const saved = canSave(stack.blocks, steps)
  assert.ok(saved.ok, `canSave accepts a panel step: ${saved.ok ? '' : saved.reason}`)
  assert.equal(saved.steps.find(s => s.id === step.id).kind, 'panel', 'the kind survives the save')
}

// ── 3. The runner: two members, one failing, RETRY then pause ─────────────
const workflow = {
  slug: 'panelwf', name: 'Panel WF',
  steps: [
    { id: 'impl', agentSlug: 'agent-impl', label: 'Implement Fix', next: ['panel'] },
    { id: 'panel', agentSlug: 'sdlc-verdict-panel', label: 'Verdict panel', kind: 'panel', next: ['after'], panel: { members: [{ agentSlug: 'member-pass' }, { agentSlug: 'member-fail', criterion: 'no double charge' }], budgetTokens: 100_000, maxLoops: 2 } },
    { id: 'after', agentSlug: 'agent-after', label: 'After', next: [] },
  ],
}
mkdirSync(join(CLAUDE_DIR, 'workflows'), { recursive: true })
writeFileSync(join(CLAUDE_DIR, 'workflows', 'panelwf.json'), JSON.stringify(workflow, null, 2))

const IMPL_SESSION = 'impl-session-0001'
const calls = []
let implVisits = 0
const verdict = (v, extra = {}) => `Looked at it.\n\`\`\`json\n${JSON.stringify({ verdict: v, ticket: 'KEY-1', criteria: [{ id: 'c1', result: v, evidence: ['ran the test: 1 failed'], notes: 'the second grant lands twice' }], risks: [], ...extra })}\n\`\`\``
runner.setAgentCaller(async (agentSlug, input, projectDir, opts = {}) => {
  calls.push({ agentSlug, input, opts })
  if (agentSlug === 'agent-impl') {
    implVisits++
    // The implementer reports a session, which is what must never reach a member.
    opts.onSession?.(IMPL_SESSION, projectDir ?? CLAUDE_DIR)
    return { output: `implemented, attempt ${implVisits}. SECRET-IMPLEMENTER-REASONING`, model: 'stub', usage: { input_tokens: 10, output_tokens: 5 } }
  }
  if (agentSlug === 'member-pass') return { output: verdict('pass'), model: 'stub', usage: { input_tokens: 100, output_tokens: 20 } }
  if (agentSlug === 'member-fail') return { output: verdict('fail'), model: 'stub', usage: { input_tokens: 120, output_tokens: 30 } }
  return `output of ${agentSlug}`
})

const started = await runner.startRun({ workflow, initialPrompt: 'KEY-1: fix the double grant', watch: 'direct-invocation', autoRun: true })
const run = await runner.waitForSettled(started.id, TIMEOUT)

assert.equal(run.status, 'paused', 'after the panel\'s send-backs are spent the run pauses')
assert.equal(run.question?.kind, 'approval')
assert.equal(run.question?.reason, 'rework', 'and asks the person about the send-back')
assert.equal(run.question?.rework?.target, 'impl', 'the send-back targets the implementer')
assert.equal(run.question?.stepId, 'impl')
assert.match(run.question?.text ?? '', /Verdict panel/)
assert.equal(run.reworksBy?.panel, 3, 'maxLoops 2 means the third fail asks a person')
assert.equal(implVisits, 3, 'the implementer ran once, then once per automatic send-back')
assert.equal(run.steps.find(s => s.stepId === 'after').status, 'pending', 'nothing after the panel ran')

const panelRec = run.steps.find(s => s.stepId === 'panel')
assert.equal(panelRec.monitorVerdict, 'RETRY', 'a failing panel is a RETRY on the step')
assert.ok(panelRec.checks?.every(c => c.verdict === 'RETRY'), 'every visit recorded RETRY')
assert.equal(panelRec.usage.input_tokens, 220, 'the panel\'s usage is the members\' sum')

// The implementer's second and third visits were handed the findings.
const implInputs = calls.filter(c => c.agentSlug === 'agent-impl').map(c => c.input)
assert.equal(implInputs.length, 3)
assert.match(implInputs[1], /verdict panel failed the change/i)
assert.match(implInputs[1], /no double charge/, 'the finding is attributed to the member and its criterion')
assert.match(implInputs[1], /second grant lands twice/, 'the finding carries the member\'s notes')

// Isolation: no member call resumed anything, and no member saw the implementer's output.
const memberCalls = calls.filter(c => c.agentSlug.startsWith('member-'))
assert.equal(memberCalls.length, 6, 'two members sat on each of three panel visits')
for (const c of memberCalls) {
  assert.equal(c.opts.resume, undefined, `${c.agentSlug} was never handed a session to resume`)
  assert.equal(c.opts.onSteer, undefined, `${c.agentSlug} cannot be steered`)
  assert.ok(!c.input.includes(IMPL_SESSION), 'the implementer session id never reaches a member')
  assert.ok(!c.input.includes('SECRET-IMPLEMENTER-REASONING'), 'the implementer output never reaches a member')
  assert.ok(c.input.includes('KEY-1'), 'the member knows the ticket')
  assert.ok(c.input.includes('Diff range:'), 'and the diff range')
}
assert.ok(memberCalls.find(c => c.agentSlug === 'member-fail').input.includes('no double charge'), 'a member is told its criterion')

// The verdicts are on disk, per member, under panel/.
const panelDir = join(runArtifactsDir(run.id), 'panel')
for (const slug of ['member-pass', 'member-fail']) {
  const f = join(panelDir, `${slug}.json`)
  assert.ok(existsSync(f), `${f} exists`)
  const j = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(j.verdict.verdict, slug === 'member-pass' ? 'pass' : 'fail')
}
assert.equal(JSON.parse(readFileSync(join(panelDir, 'panel.json'), 'utf8')).verdict, 'fail')

// Continue grants one more send-back; the panel sits again.
const cont = await runner.continueRun(run.id, 'try once more')
assert.ok(cont)
const again = await runner.waitForSettled(run.id, TIMEOUT)
assert.equal(again.status, 'paused', 'still failing, it asks again')
assert.equal(implVisits, 4, 'the granted send-back ran the implementer once more')
// A paused run holds its workspace; the next cases start their own runs there.
await runner.stopRun(run.id)

// ── 4. A panel that passes carries on; a schema-invalid verdict fails it ──
{
  let mode = 'pass'
  runner.setAgentCaller(async (agentSlug) => {
    if (agentSlug.startsWith('member-')) {
      if (mode === 'invalid' && agentSlug === 'member-fail') return 'VERDICT: pass'
      return verdict('pass')
    }
    return `output of ${agentSlug}`
  })
  const ok = await runner.waitForSettled((await runner.startRun({ workflow, initialPrompt: 'KEY-1: again', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
  assert.equal(ok.status, 'completed', 'a passing panel lets the run finish')
  assert.equal(ok.steps.find(s => s.stepId === 'panel').monitorVerdict, 'CONTINUE')
  assert.equal(ok.steps.find(s => s.stepId === 'after').status, 'completed')

  mode = 'invalid'
  await runner.stopRun(ok.id)
  const bad = await runner.waitForSettled((await runner.startRun({ workflow, initialPrompt: 'KEY-1: once more', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
  assert.equal(bad.status, 'paused', 'a member whose verdict is not schema-valid fails the panel, so the run is sent back and then pauses')
  assert.equal(bad.question?.reason, 'rework')
  const stored = JSON.parse(readFileSync(join(runArtifactsDir(bad.id), 'panel', 'member-fail.json'), 'utf8'))
  assert.equal(stored.verdict, null)
  assert.match(stored.problems[0], /without a JSON verdict/)
  await runner.stopRun(bad.id)
}

// ── 5. The panel's own token budget pauses the run ────────────────────────
{
  const tight = { ...workflow, slug: 'panelbudget', steps: workflow.steps.map(s => s.id === 'panel' ? { ...s, panel: { ...s.panel, budgetTokens: 50 } } : s) }
  writeFileSync(join(CLAUDE_DIR, 'workflows', 'panelbudget.json'), JSON.stringify(tight, null, 2))
  let implRuns = 0
  runner.setAgentCaller(async (agentSlug) => {
    if (agentSlug.startsWith('member-')) return { output: verdict('pass'), model: 'stub', usage: { input_tokens: 100, output_tokens: 20 } }
    if (agentSlug === 'agent-impl') implRuns++
    return `output of ${agentSlug}`
  })
  const r = await runner.waitForSettled((await runner.startRun({ workflow: tight, initialPrompt: 'KEY-1: budget', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
  assert.equal(r.status, 'paused', 'a panel over its token budget pauses the run')
  assert.equal(r.question?.reason, 'budget')
  assert.match(r.question?.text ?? '', /panel budget/)
  const members = JSON.parse(readFileSync(join(runArtifactsDir(r.id), 'panel', 'panel.json'), 'utf8')).members
  assert.ok(members.some(m => m.problems.some(p => /budget was spent/.test(p))), 'the member that did not sit says why')
  assert.equal(r.reworksBy?.panel ?? 0, 0, 'the send-back the unseated member caused waits behind the budget question')
  assert.equal(r.deferredRework?.target, 'impl', 'held on the record, so a restart keeps it')
  const resumed = await runner.continueRun(r.id)
  assert.ok(resumed)
  const done = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(implRuns, 2, 'accepting the spend carries the held send-back out: the implementer ran again')
  assert.equal(done.reworksBy?.panel, 1, 'and it counts against the panel\'s own loops')
  assert.equal(done.status, 'paused', 'the panel sat again over the same budget and asks again')
  await runner.stopRun(r.id)
}

console.log('OK  panel step: verdicts parsed and schema-checked, isolation held, RETRY until maxLoops then a person, budget pause')
