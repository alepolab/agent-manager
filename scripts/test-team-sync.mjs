/**
 * Self-check for the team sync: drift detection and apply against a temp
 * config directory with a fake plugin install.
 *
 *   node scripts/test-team-sync.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'team-'))
const cache = join(process.env.CLAUDE_DIR, 'plugins', 'cache', 'alepo-engineering', 'alepo-engineering', '0.1.0')
mkdirSync(join(cache, 'skills', 'intent-template'), { recursive: true })
mkdirSync(join(cache, 'registry'), { recursive: true })
writeFileSync(join(cache, 'skills', 'intent-template', 'SKILL.md'), '---\nname: intent-template\ndescription: d\n---\nbody\n')
writeFileSync(join(cache, 'registry', 'products.yaml'), 'products:\n  x:\n    match: { projects: [X] }\n    repos: [o/r]\n    branches: { bug: main, feature: main }\n    stack: { compose: a, topology_default: 1node }\n    tests: { unit: t }\n    owners: { docs: d }\n')
mkdirSync(join(cache, 'commands'), { recursive: true })
mkdirSync(join(cache, 'registry'), { recursive: true })
writeFileSync(join(cache, 'registry', 'watches.yaml'), 'watches:\n  - id: csup-bugs\n    jql: project = CSUP AND status = Done\n    daily_dispatch_cap: 10\n    mode: shadow\n  - id: ce-features\n    jql: project = CSUP AND labels = ce\n    workflow: runbook-c-ce-ticket-to-pr\n    mode: shadow\n')
writeFileSync(join(cache, 'commands', 'triage.md'), '# triage\n')
writeFileSync(join(process.env.CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'alepo-engineering@alepo-engineering': [{ installPath: cache, version: '0.1.0' }] } }))

const T = await import('../server/utils/teamSync.ts')
const D = await import('../server/utils/claudeDir.ts')

let s = await T.teamStatus()
assert.equal(s.pluginVersion, '0.1.0')
assert.ok(s.agents.length >= 8 && s.agents.every(a => a.state === 'missing'), 'a fresh directory misses every team agent')
// Skills are the oh-my-agent SSOT: .agents/skills plus each .agents/workflows
// entry projected as a skill (oma's own `link` contract). The plugin fixture
// skill above is deliberately NOT among them — the plugin is no longer a skill
// source, only the record that proves plugin detection still works.
assert.ok(s.skills.length >= 50 && s.skills.every(k => k.state === 'missing'),
  `a fresh directory misses every team skill; got ${s.skills.length}`)
assert.ok(s.skills.some(k => k.name === 'oma-qa'), 'the oh-my-agent skills are the team skills')
assert.ok(s.skills.some(k => k.name === 'ultrawork'), 'and its workflows are projected as skills')
// Two workflows now (app/utils/workflowTemplates.ts), whose steps name the
// seeded oh-my-agent agents directly — runbookSteps builds an identity map, so
// agentTemplateId IS the agent slug. Asserted by slug rather than by position:
// the order of the template array is not a contract.
assert.equal(s.workflows.length, 2, 'the instance ships its workflows over the oh-my-agent agents')
const bySlug = Object.fromEntries(s.workflows.map(w => [w.slug, w]))
assert.deepEqual(Object.keys(bySlug).sort(), ['oma-csup-to-pr', 'oma-plan-build-review'])
// Two parallel waves joined twice: research + reproduce -> plan -> review ->
// backend + frontend -> verify -> refine -> docs.
assert.equal(bySlug['oma-plan-build-review'].steps, 9, 'the parallel work graph keeps all nine steps')
// A support ticket to a pull request, gated by three different roles, and then a
// tenth step for what the review leaves on that pull request: the workflow used
// to end at the PR, so review comments on two real PRs sat unanswered until a
// person noticed. The count is pinned because a step silently vanishing from a
// seeded graph is the failure this file exists to catch - it moves only when the
// template deliberately changes.
assert.equal(bySlug['oma-csup-to-pr'].steps, 10, 'the CSUP graph keeps all ten steps')
assert.equal(s.registry.ok, true); assert.equal(s.registry.products, 1)
assert.ok(s.drifted > 8)

s = await T.teamSync()
assert.equal(s.drifted, 0, 'apply leaves nothing drifted')
assert.ok(existsSync(join(process.env.CLAUDE_DIR, 'agents', 'qa-reviewer.md')))
assert.ok(existsSync(join(process.env.CLAUDE_DIR, 'skills', 'oma-qa', 'SKILL.md')))
assert.ok(existsSync(join(process.env.CLAUDE_DIR, 'commands', 'triage.md')), 'plugin commands are seeded too')
{
  // Watches are not seeded here. A watch exists only to dispatch a runbook, and
  // this instance seeds no *.json workflows for one to dispatch into, so the
  // enabled-flag and cap contracts that stood in this block have nothing to act
  // on. engineering/registry/watches.yaml still ships; nothing reads it.
  assert.deepEqual(s.watches, [], 'watches are not seeded without workflows to dispatch')
  assert.equal(typeof s.instance.auth, 'string', 'instance facts are reported')
  assert.ok(s.registry.items.every(i => typeof i.key === 'string'), 'registry products are listed')
}
// The step-id-stability assertions that stood here read the seeded runbook
// JSON. None is seeded now, so the agent drift contract is what remains.
writeFileSync(join(process.env.CLAUDE_DIR, 'agents', 'pm-planner.md'), 'edited locally')
s = await T.teamStatus()
assert.deepEqual(s.agents.filter(a => a.state !== 'ok').map(a => a.id), ['pm-planner'], 'a local edit reads as drift')
s = await T.teamSync()
assert.equal(s.drifted, 0)

// ── No plugin installed: the container's normal case ──────────────────────
//
// A team container installs no plugins. Skills already fall back to the copy
// shipped in engineering/skills; commands did not, so a container seeded zero
// of them and /baseline, /reproduce, /triage and /tasks-picker-infra reached
// nobody. Nothing said so: the boot line prints "0 commands" and 0 is a
// legitimate count when the repo genuinely ships none.
//
// This asserts the seeded RESULT, not that the files exist in the repo. The
// existing check in test-agent-skills.mjs asserts the latter, and it passed
// throughout the whole time commands were unreachable.
const bare = mkdtempSync(join(tmpdir(), 'team-bare-'))
D.setClaudeDir(bare)

const shipped = readdirSync(join(import.meta.dirname, '..', 'engineering', 'commands'))
  .filter(f => f.endsWith('.md'))
assert.ok(shipped.length, 'engineering/commands must ship commands for this to mean anything')

s = await T.teamStatus()
assert.equal(s.pluginVersion, null, 'no plugin is installed in this scenario')
assert.deepEqual(
  s.commands.map(c => c.name).sort(),
  shipped.map(f => f.replace(/\.md$/, '')).sort(),
  'with no plugin installed, commands come from the shipped copy',
)

s = await T.teamSync()
for (const file of shipped) {
  assert.ok(
    existsSync(join(bare, 'commands', file)),
    `${file} must be seeded from engineering/commands when no plugin is installed`,
  )
}
assert.equal(s.drifted, 0, 'apply leaves nothing drifted in the bare case')

rmSync(bare, { recursive: true, force: true })

// Watches are not seeded at all now (see above), so the no-plugin fallback
// this block guarded has nothing to fall back to.


// ── Diffs, per-item apply, layout, broken JSON, audit, lock ───────────────
//
// "drifted" was a word: no diff, no way to apply one item, and a runbook file
// that did not parse threw inside status and took the whole page down. A node
// moved on the workflow canvas saved a `position` the comparison read as drift,
// so Apply undid the layout. Back on the first temp dir with the fake plugin.
{
  D.setClaudeDir(process.env.CLAUDE_DIR)
  await T.teamSync()
  // The broken-JSON and canvas-layout regressions that stood here all read the
  // seeded runbook JSON, which this instance does not produce. The per-item
  // apply, audit trail and single-apply lock below are unaffected.
  let s

  writeFileSync(join(process.env.CLAUDE_DIR, 'agents', 'pm-planner.md'), 'edited locally')
  writeFileSync(join(process.env.CLAUDE_DIR, 'agents', 'backend-engineer.md'), 'also edited')
  s = await T.teamStatus()
  const v = s.agents.find(a => a.id === 'pm-planner')
  assert.equal(v.state, 'drifted'); assert.ok(v.diff.includes('edited locally'), 'a drifted agent carries its diff')
  assert.equal(s.agents.find(a => a.id === 'qa-reviewer').diff, undefined, 'an ok item carries none')
  s = await T.teamSync('sandeep', ['agent:pm-planner'])
  assert.equal(s.agents.find(a => a.id === 'pm-planner').state, 'ok', 'only the named item is applied')
  assert.equal(s.agents.find(a => a.id === 'backend-engineer').state, 'drifted', 'the other stays as it was')
  assert.equal(s.drifted, 1)
  assert.deepEqual([s.lastApplied.by, s.lastApplied.items], ['sandeep', 1], 'who applied what is recorded')
  s = await T.teamSync()
  assert.equal(s.drifted, 0)


  const results = await Promise.allSettled([T.teamSync(), T.teamSync()])
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected'], 'one apply at a time')
  assert.equal(results.find(r => r.status === 'rejected').reason.statusCode, 409)

  assert.equal(typeof s.enforcement.ok, 'boolean', 'enforcement is reported, armed or not')
  assert.ok(Array.isArray(s.enforcement.checks))
  assert.ok(Array.isArray(s.unresolvedSkills) && !s.unresolvedSkills.includes('oma-qa'), 'a seeded skill is not unresolved')
  assert.equal(s.sources.skills, 'other', 'skills come from the .agents SSOT, not the plugin or engineering/')
  assert.equal(typeof s.instance.workspaceRoot, 'string')
}
rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
// A config directory whose skill is a SYMLINK into another tree — the normal
// shape when skills are shared between tools. Seeding used to die here with
// EEXIST and abandon everything after it: no workflow, no watches.
{
  const skill = join(process.env.CLAUDE_DIR, 'skills', 'oma-qa')
  const elsewhere = join(process.env.CLAUDE_DIR, 'elsewhere', 'oma-qa')
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(join(elsewhere, 'SKILL.md'), 'stale\n')
  rmSync(skill, { recursive: true, force: true })
  mkdirSync(join(process.env.CLAUDE_DIR, 'skills'), { recursive: true })
  symlinkSync(elsewhere, skill)

  const after = await T.teamSync()
  assert.equal(after.drifted, 0, 'a symlinked skill is replaced, not fatal')
  assert.ok(!lstatSync(skill).isSymbolicLink(), 'the link is replaced by the real skill')
  assert.ok(!readFileSync(join(skill, 'SKILL.md'), 'utf8').includes('stale'), 'seeded from the SSOT, not the link target')
}

console.log('teamSync: all assertions passed')
