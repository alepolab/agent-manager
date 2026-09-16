/**
 * Every skill an agent declares must actually resolve.
 *
 * The resolution half is a DEPLOYMENT check: it resolves against the ambient
 * CLAUDE_DIR, which is exactly the state a real agent runs in. That is why it
 * is worth having — `buildAgentSystemPrompt` swallows a per-skill resolution
 * failure by design (one typo must not stop an agent), so a declared skill that
 * does not resolve looks identical to a working one and the agent silently runs
 * without the instructions it was supposed to have.
 *
 * A bare CI runner has no seeded config, so that half is skipped there with a
 * notice rather than leaving the branch permanently red. A config that HAS
 * skills but is missing one is a real failure and still fails.
 *
 * This instance ships the oh-my-agent estate only: agents in .agents/agents,
 * skills in .agents/skills. The previous version of this file asserted the
 * sdlc-* agents and the vendored engineering/skills tree, both removed.
 *
 *   node scripts/test-agent-skills.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSkillInvocation } from '../server/utils/resolveSkill.ts'

const root = join(import.meta.dirname, '..')
const agentsDir = join(root, '.agents', 'agents')
const skillsSsot = join(root, '.agents', 'skills')

/** Declared skills, from frontmatter — the only place an agent states them. */
const declaredSkills = (body) => {
  const m = /^skills:\s*\n((?:[ \t]*-[ \t]+\S+[ \t]*\n)+)/m.exec(body)
  return m ? [...m[1].matchAll(/^[ \t]*-[ \t]+(\S+)[ \t]*$/gm)].map(x => x[1]) : []
}

assert.ok(existsSync(agentsDir), '.agents/agents must exist — it is the agent source of truth')
const agents = readdirSync(agentsDir).filter(f => f.endsWith('.md')).map(f => ({
  id: f.replace(/\.md$/, ''),
  skills: declaredSkills(readFileSync(join(agentsDir, f), 'utf8')),
}))
assert.ok(agents.length >= 10, `expected the oh-my-agent agents, found ${agents.length}`)

// Every declared skill must exist in the SSOT. This runs on every machine:
// a declaration pointing at a skill the repo does not ship is broken
// everywhere, not just where nothing is deployed.
const shipped = new Set(readdirSync(skillsSsot).filter(n => existsSync(join(skillsSsot, n, 'SKILL.md'))))
const undeclarable = agents.flatMap(a => a.skills.filter(s => !shipped.has(s)).map(s => `${a.id} declares "${s}", absent from .agents/skills`))
assert.deepEqual(undeclarable, [], `every declared skill must ship:\n  ${undeclarable.join('\n  ')}`)

// An agent that declares nothing gets no skill instructions at all. That is a
// legitimate state for some, so this asserts the estate as a whole is wired,
// not each agent individually.
assert.ok(agents.some(a => a.skills.length), 'no agent declares any skill — the estate is not wired')

// ── Deployment half ───────────────────────────────────────────────────────
const skillsDir = join(process.env.CLAUDE_DIR || join(process.env.HOME || '', '.claude'), 'skills')
const deployed = existsSync(skillsDir) && readdirSync(skillsDir).length > 0
let checked = 0
if (deployed) {
  const failures = []
  for (const agent of agents) {
    for (const skill of agent.skills) {
      checked++
      const resolved = await resolveSkillInvocation(skill)
      if (!resolved || !String(resolved.body ?? '').trim()) {
        failures.push(`${agent.id} declares "${skill}" — ${resolved ? 'resolved but empty' : 'does not resolve'}`)
      }
    }
  }
  assert.deepEqual(failures, [],
    `every declared skill must resolve, or the agent silently runs without it:\n  ${failures.join('\n  ')}`)
} else {
  console.log(`SKIP resolution check — no seeded config at ${skillsDir} (expected on CI).`)
}

// ── Shipped commands must be well-formed ──────────────────────────────────
// engineering/ still ships commands; only its skills tree was removed.
const commandsDir = join(root, 'engineering', 'commands')
const commandFiles = existsSync(commandsDir) ? readdirSync(commandsDir).filter(f => f.endsWith('.md')) : []
assert.ok(commandFiles.length, 'engineering/commands/ must ship at least one command')
for (const file of commandFiles) {
  const raw = readFileSync(join(commandsDir, file), 'utf8')
  assert.ok(raw.startsWith('---\n'), `${file} must open with YAML frontmatter`)
  const end = raw.indexOf('\n---', 4)
  assert.ok(end > 0, `${file} frontmatter must be closed`)
  const fm = raw.slice(4, end)
  const declared = /^name:\s*(\S+)/m.exec(fm)?.[1]
  if (declared !== undefined) {
    assert.equal(declared, file.replace(/\.md$/, ''),
      `${file} declares a name that disagrees with its filename; the filename wins, so drop it or match it`)
  }
  assert.ok(/^description:\s*\S/m.test(fm),
    `${file} needs a description: it is the only thing shown when picking a command`)
}

// sync-agents.mjs is what installs them. A command added to the repo but not
// seeded is invisible, which is exactly the state three of them were in.
const syncSource = readFileSync(join(import.meta.dirname, 'sync-agents.mjs'), 'utf8')
assert.ok(syncSource.includes('seedCommands()'),
  'sync-agents.mjs must call seedCommands(), or shipped commands never reach CLAUDE_DIR')

console.log(
  `agent skills: ${deployed ? `${checked} declared skills across ${agents.length} agents all resolve` : 'resolution SKIPPED (no deployment)'}; `
  + `${shipped.size} shipped in .agents/skills; ${commandFiles.length} commands well-formed`)
