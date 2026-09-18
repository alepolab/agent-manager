/**
 * Whose work a step IS, as data.
 *
 * A step already says which agent runs it (`agentSlug`) and whose decision its
 * gate is (`gateRole`, enforced by server/utils/gateRole.ts). Neither answers
 * the question a person asks when they open a run: which of these steps is
 * MINE. The end user said it plainly — "each role or persona has work, like
 * some steps will be defined by different roles" — and the console had no field
 * to render.
 *
 * `ownerRole` is that field, and this file pins the two properties that make it
 * safe. First, it survives the trip from template to workflow to run record,
 * because a chip that appears in the builder and vanishes on the run page is
 * worse than no chip. Second, it grants NOTHING: authority stays with
 * `can()` (shared/types/role.ts) and `requireGateRole` (server/utils/gateRole.ts),
 * and the ownership axis must never be read where a refusal is decided.
 *
 * Deriving the owner instead was considered and rejected on evidence: the CSUP
 * template's "Plan Review" step runs `architecture-reviewer` while its gate
 * belongs to `developer`, so agent and gate disagree on the first real step,
 * and most steps map to no role at all. A derived owner would be a guess
 * wearing a fact's shape.
 *
 *   node scripts/test-step-ownership.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')

const { ROLES } = await import('../shared/types/role.ts')
const { workflowTemplates, materializeTemplateSteps } = await import('../app/utils/workflowTemplates.ts')

// ── 1. a declared owner is a real role, in every shipped template ───────────
// A typo'd role would render as an empty chip rather than failing loudly, so it
// is caught here instead of on screen.
{
  let declared = 0
  for (const template of workflowTemplates) {
    for (const step of template.steps) {
      if (!step.ownerRole) continue
      declared++
      assert.ok(
        ROLES.includes(step.ownerRole),
        `${template.name}/${step.label}: ownerRole '${step.ownerRole}' is not a role`,
      )
    }
  }
  assert.ok(declared >= 3, `expected the shipped templates to declare step owners; found ${declared}`)
}

// ── 2. ownership survives materialisation ──────────────────────────────────
// `materializeTemplateSteps` copies a whitelist of fields (id, agentSlug, label,
// approval, gateRole, …). A field absent from that list is silently dropped, and
// the workflow JSON the runner actually reads would carry no owner at all — the
// exact failure mode that left `jira.after` working in the template and missing
// from the seeded workflow.
{
  const csup = workflowTemplates.find(t => t.steps.some(s => s.ownerRole))
  assert.ok(csup, 'no template declares an owner to materialise')
  const steps = materializeTemplateSteps(csup, {})
  const owned = steps.filter(s => s.ownerRole)
  const declared = csup.steps.filter(s => s.ownerRole)
  assert.equal(
    owned.length,
    declared.length,
    `materialiseTemplateSteps dropped ownerRole: ${declared.length} declared, ${owned.length} survived`,
  )
  // And it lands on the SAME steps, not merely the same count.
  for (const [i, step] of csup.steps.entries()) {
    if (step.ownerRole) assert.equal(steps[i].ownerRole, step.ownerRole, `${step.label}: owner changed in materialisation`)
  }
}

// ── 3. ownership is not authority ───────────────────────────────────────────
// Asserted against the source, the way scripts/test-roles.mjs asserts over route
// files: the capability table and the gate guard must not learn about ownership.
// This is a weaker check than a runtime one and it is the one that fails at the
// exact line someone adds the leak.
{
  const roleSrc = readFileSync(join(repoRoot, 'shared/types/role.ts'), 'utf8')
  assert.doesNotMatch(roleSrc, /ownerRole/, 'the capability table must not read step ownership')

  const gateSrc = readFileSync(join(repoRoot, 'server/utils/gateRole.ts'), 'utf8')
  assert.doesNotMatch(gateSrc, /ownerRole/, 'the gate guard decides on run.question.role alone')

  // No mutating API route may consult it either. The runner may (it copies the
  // field onto the run record); nothing that returns 403 may.
  const apiRoot = join(repoRoot, 'server/api')
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!entry.endsWith('.ts')) continue
      if (readFileSync(full, 'utf8').includes('ownerRole')) offenders.push(full.slice(repoRoot.length + 1))
    }
  }
  walk(apiRoot)
  assert.deepEqual(offenders, [], `ownership must stay presentational; these routes read it: ${offenders.join(', ')}`)
}

// ---- the ticket-to-PR workflow does not end at the pull request -------------
// Two PRs from one run collected review comments and nothing in the pipeline
// ever read them: the workflow's last step opened the PR and stopped, so the
// comments sat there until a person noticed. A workflow that ships a PR and
// has no step for what comes back is a workflow that treats review as somebody
// else's problem.
//
// The step is gated on purpose. Reviews arrive minutes after the push, so a
// step that ran straight after the ship step would find an empty PR and report
// success - the same hollow-success shape as the ship step that opened no pull
// request. The gate is what makes it useful: a person releases it when the
// comments are actually in.
{
  const csup = workflowTemplates.find(t => t.id === 'oma-csup-to-pr' || t.name.startsWith('CSUP'))
  assert.ok(csup, 'the CSUP template is still here')

  const review = csup.steps.find(s => /review comment/i.test(s.label))
  assert.ok(review, 'the CSUP workflow has a step for the comments a review leaves on its pull request')
  assert.ok(review.approval, 'it is a gate: reviews land after the push, so a person releases it when they are in')
  assert.ok(review.gateRole, 'and the gate names whose decision it is')
  assert.deepEqual(review.next ?? [], [], 'it is the terminal step')

  // The ship step must actually route into it, or it is unreachable.
  const ship = csup.steps.find(s => s.pr)
  assert.ok(ship, 'the ship step is the one that opens the pull request')
  assert.deepEqual(
    ship.next,
    [review.agentTemplateId],
    'the ship step routes into the review-comment step, or nothing ever reaches it',
  )

  // Its agent must be one the template does not already use: `next` resolves by
  // agentTemplateId, so a duplicate would make routing ambiguous.
  const slugs = csup.steps.map(s => s.agentTemplateId)
  assert.equal(
    slugs.filter(s => s === review.agentTemplateId).length,
    1,
    'the review step uses an agent no other step in this template uses',
  )
}

// ---- the steps that matter are judged by an agent that writes no source ----
// The reproduction writes the test the whole run is judged against, and the fix
// is the step that could quietly relax it. Both were monitored by
// `refactor-engineer`, whose own contract is behaviour-preserving refactoring -
// an agent briefed on metrics, not on whether the diff touched the oracle. The
// reproduction had no monitor at all.
{
  const csup = workflowTemplates.find(t => t.id === 'oma-csup-to-pr' || t.name.startsWith('CSUP'))
  const repro = csup.steps.find(s => /reproduce/i.test(s.label))
  const fix = csup.steps.find(s => /implement fix/i.test(s.label))
  assert.ok(repro && fix, 'the reproduction and fix steps are still here')
  assert.equal(repro.monitorSlug, 'qa-reviewer', 'the reproduction is judged by an agent that never writes source')
  assert.equal(fix.monitorSlug, 'qa-reviewer', 'the fix is judged for test edits by an agent that never writes source')
}

// ---- migration review does not wait behind the client change ---------------
// `db-engineer` reviews what the BACKEND fix did to schema and data. It sat
// behind `frontend-engineer` and therefore behind the QA gate, which is one
// whole agent turn of latency bought for nothing: the two steps share no data
// dependency and write different files.
{
  const csup = workflowTemplates.find(t => t.id === 'oma-csup-to-pr' || t.name.startsWith('CSUP'))
  const { buildGraph, initRunState, markCompleted, readyNodes } = await import('../shared/utils/workflowGraph.ts')
  const graph = buildGraph(csup.steps.map(s => ({ id: s.agentTemplateId, next: s.next, maxVisits: s.maxVisits })))

  // First: it must still DEPEND on the fix. Deleting the edge would also make
  // it "ready" - an orphan node is ready from the start - so readiness alone
  // would pass for the wrong reason and prove nothing about the wave.
  const fresh = readyNodes(graph, initRunState(graph))
  assert.ok(
    !fresh.includes('db-engineer'),
    `migration review must depend on the backend fix, not float free; it was ready at run start: ${JSON.stringify(fresh)}`,
  )

  const state = initRunState(graph)
  for (const id of ['pm-planner', 'research-explorer', 'debug-investigator', 'architecture-reviewer', 'backend-engineer']) {
    markCompleted(graph, state, id)
  }
  const ready = readyNodes(graph, state)
  assert.ok(
    ready.includes('db-engineer'),
    `migration review is ready as soon as the backend fix lands, not after the client change and the QA gate; ready was ${JSON.stringify(ready)}`,
  )
  assert.ok(ready.includes('frontend-engineer'), 'and the client change is ready in the same wave, so the two run in parallel lanes')
}

console.log('step ownership: declared as data, carried to the run, and it decides nothing')
