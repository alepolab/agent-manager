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

console.log(`agent skills: ${checked} declared skills across ${sdlc.length} agents all resolve`)
