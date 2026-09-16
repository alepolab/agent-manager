/**
 * The packaged oh-my-agent workflow and its gate definitions agree.
 *
 * The package is two files that reference each other by convention, and nothing
 * at runtime checks that convention: `runbook-a.md` dispatches gates by name,
 * `runbook-a/resources/phase-gates.md` defines them. Both halves look complete
 * in isolation, which is what makes the drift invisible to review.
 *
 * A gate defined but never dispatched is dead policy — it reads as oversight to
 * anyone auditing the package while firing on nothing. A gate dispatched but
 * never defined is worse: the run reaches a checkpoint with no criteria, no
 * owner and no failure action, and what happens there is whatever the agent
 * decides.
 *
 * This caught exactly that on the package's first draft. VERIFY_GATE was fully
 * specified — owner QA, "never the same actor that answered IMPL_GATE", six
 * criteria, a failure action — and no step in the workflow ever reached it.
 *
 * Also asserts every gate names an owner, because the package's two-question
 * split (who is asked, versus whether anyone is asked at all) collapses the
 * moment a gate is ownerless — and the whole reason verification sits in
 * someone else's hands is that the implementer must not accept their own.
 *
 *   node scripts/test-runbook-a-package.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const WORKFLOW = '.agents/workflows/runbook-a.md'
const GATES = '.agents/workflows/runbook-a/resources/phase-gates.md'

const workflow = readFileSync(WORKFLOW, 'utf8')
const gates = readFileSync(GATES, 'utf8')

const uniq = a => [...new Set(a)].sort()
const dispatched = uniq([...workflow.matchAll(/→ ([A-Z_]+GATE)/g)].map(m => m[1]))
const defined = uniq([...gates.matchAll(/^## ([A-Z_]+GATE)$/gm)].map(m => m[1]))

// Guard against the regexes silently matching nothing: a test that finds no
// gates at all would otherwise "pass" by comparing two empty lists.
assert.ok(defined.length >= 4, `expected the gate definitions to be found, got ${defined.length}`)
assert.ok(dispatched.length >= 4, `expected the workflow to dispatch gates, got ${dispatched.length}`)

assert.deepEqual(dispatched, defined,
  'every gate the workflow dispatches must be defined, and every gate defined must be '
  + `dispatched by a step.\n  dispatched: ${dispatched.join(', ')}\n  defined:    ${defined.join(', ')}`)

// A gate without an owner is answerable by whoever is nearest, which is how an
// implementer comes to accept their own verification. A gate without a failure
// action is a question with no consequence attached.
for (const gate of defined) {
  const section = gates.split(`## ${gate}`)[1].split('\n## ')[0]
  assert.match(section, /\*\*Owner\*\*:\s*\S+/, `${gate} must name an owner`)
  assert.match(section, /### Failure Action/, `${gate} must say what happens when it fails`)
}

// The workflow routes oversight on the blast radius intake records. A tier
// named in the workflow's table but nowhere in the gates routes nothing.
for (const tier of ['auto', 'stop', 'justify']) {
  assert.ok(gates.includes(`\`${tier}\``), `the gates must route the ${tier} oversight tier`)
}

// The runbook's own deliverable claim. If the package stops saying the bundle
// is the deliverable, it has become a workflow that merely produces a diff.
assert.match(workflow, /evidence bundle, not the diff/i,
  'the workflow must still state that the bundle, not the diff, is the deliverable')

/**
 * Every file the workflow tells an agent to READ is named from the repository
 * root.
 *
 * oh-my-agent projects a workflow by COPYING it to each runtime's own tree
 * (`.claude/skills/<name>/SKILL.md`) and leaves the sibling `resources/`
 * directory behind — verified against a real install, and against their own
 * `ultrawork`, whose SSOT carries two files and projects one. So a bare
 * relative path like `runbook-a/resources/phase-gates.md` resolves to nothing
 * from the runtime an agent actually runs in, and the agent reaches its first
 * gate with no criteria, no owner and no failure action.
 *
 * Nothing errors when this breaks. The file is simply not there, and the gate
 * silently becomes whatever the agent decides — which is the exact failure the
 * gates exist to prevent.
 */
for (const [file, text] of [[WORKFLOW, workflow], [GATES, gates]]) {
  const reads = [...text.matchAll(/`([^`\n]*(?:resources\/|_shared\/)[^`\n]*\.md)`/g)].map(m => m[1])
  for (const ref of reads) {
    assert.ok(ref.startsWith('.agents/'),
      `${file} tells an agent to read \`${ref}\`, which is not rooted at .agents/. `
      + 'A workflow is copied without its resources/ directory, so a relative path '
      + 'resolves to nothing in the runtime. Name it from the repository root.')
  }
}

console.log(`runbook-a package: ${defined.length} gates, each dispatched, owned and with a failure action`)
