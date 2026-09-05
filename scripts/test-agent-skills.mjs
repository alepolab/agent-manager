/**
 * Every skill an sdlc-* agent declares must actually resolve.
 *
 *   node scripts/test-agent-skills.mjs
 *
 * Why this exists: `intent-template` and `regression-matrix` are built and
 * shipped by the alepo-engineering plugin specifically for this pipeline, and
 * for a long time NO agent declared them. When they finally were declared, they
 * still resolved to nothing — the plugin's files sit in the plugin cache but it
 * is not listed in installed_plugins.json, which is the only place
 * resolveSkill's plugin path looks.
 *
 * That failure is silent by design: buildAgentSystemPrompt catches a per-skill
 * resolution failure and carries on, so that one typo cannot stop an agent
 * running. The cost of that kindness is that a declared-but-unresolvable skill
 * looks exactly like a working one — the agent simply runs without the
 * instructions it was supposed to have, and nothing anywhere says so.
 *
 * This is a DEPLOYMENT check, not a pure unit test: it resolves against the
 * ambient CLAUDE_DIR. On a fresh machine it fails until `node
 * scripts/sync-agents.mjs` has seeded the plugin's skills, and that failure is
 * the point — it is the same state a real agent would run in.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { agentTemplates } from '../app/utils/templates.ts'
import { resolveSkillInvocation } from '../server/utils/resolveSkill.ts'

const sdlc = agentTemplates.filter(t => t.id.startsWith('sdlc-'))
assert.ok(sdlc.length >= 7, `expected the sdlc agents, found ${sdlc.length}`)

const failures = []
let checked = 0

for (const agent of sdlc) {
  for (const skill of agent.frontmatter.skills ?? []) {
    checked++
    const resolved = await resolveSkillInvocation(skill)
    if (!resolved || !String(resolved.body ?? '').trim()) {
      failures.push(`${agent.id} declares "${skill}" — ${resolved ? 'resolved but empty' : 'does not resolve'}`)
    }
  }
}

assert.deepEqual(failures, [],
  `every declared skill must resolve, or the agent silently runs without it:\n  ${failures.join('\n  ')}`)

// The two skills this pipeline ships for itself must be wired to the agents
// whose job they describe. Building a skill and declaring it nowhere is the
// same defect one step earlier.
const declaredBy = (skill) =>
  sdlc.filter(a => (a.frontmatter.skills ?? []).includes(skill)).map(a => a.id)

assert.ok(declaredBy('intent-template').includes('sdlc-ticket-intake'),
  'intent-template describes exactly what sdlc-ticket-intake does; it must declare it')
assert.ok(declaredBy('regression-matrix').includes('sdlc-test-author'),
  'regression-matrix is the table-driven-test skill; sdlc-test-author must declare it')

// Each agent must carry the skill that describes the discipline its step is
// FOR. A skill built and shipped but declared nowhere is the same defect as a
// declared skill that does not resolve, one step earlier - and both are
// invisible at runtime.
const REQUIRED = {
  'sdlc-ticket-intake': 'intent-template',
  'sdlc-test-author': 'test-driven-development',
  'sdlc-verifier': 'verification-before-completion',
  'sdlc-fix-implementer': 'systematic-debugging',
  'sdlc-evidence-and-pr': 'finishing-a-development-branch',
  'sdlc-step-monitor': 'requesting-code-review',
}
for (const [agentId, skill] of Object.entries(REQUIRED)) {
  const agent = sdlc.find(a => a.id === agentId)
  assert.ok(agent, `${agentId} must exist`)
  assert.ok((agent.frontmatter.skills ?? []).includes(skill),
    `${agentId} performs the discipline "${skill}" describes; it must declare it`)
}

// ponytail is the minimal-solution skill. It belongs on the step that WRITES
// the change, because "the smallest change the stated problem needs" is this
// pipeline's standing rule and the one an implementer is most tempted to
// exceed - and on the provisioner, which twice burned its whole turn budget
// manufacturing work on a ticket that needed none.
for (const agentId of ['sdlc-fix-implementer', 'sdlc-stack-provisioner']) {
  const agent = sdlc.find(a => a.id === agentId)
  assert.ok((agent.frontmatter.skills ?? []).includes('ponytail'),
    `${agentId} must declare ponytail: doing the least that actually works is the point of this step`)
}

// The vendored skills must be IN the repo, not merely resolvable on this
// machine. That is the whole claim of engineering/skills/VENDORED.md -
// installing this product installs its skills, with no marketplace step to
// forget. Resolution alone would pass on a box that happens to have them.
const vendored = ['ponytail', 'ponytail-review', 'intent-template', 'regression-matrix']
for (const name of vendored) {
  const path = join(import.meta.dirname, '..', 'engineering', 'skills', name, 'SKILL.md')
  assert.ok(existsSync(path), `${name} must ship in engineering/skills/ so a fresh install gets it`)
}

console.log(
  `agent skills: ${checked} declared skills across ${sdlc.length} agents all resolve; `
  + `${vendored.length} shipped in-repo`)
