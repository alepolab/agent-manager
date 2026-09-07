/**
 * Self-check for the team sync: drift detection and apply against a temp
 * config directory with a fake plugin install.
 *
 *   node scripts/test-team-sync.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
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
writeFileSync(join(cache, 'registry', 'watches.yaml'), 'watches:\n  - id: csup-bugs\n    jql: project = CSUP AND status = Done\n    daily_dispatch_cap: 10\n    mode: shadow\n')
writeFileSync(join(cache, 'commands', 'triage.md'), '# triage\n')
writeFileSync(join(process.env.CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'alepo-engineering@alepo-engineering': [{ installPath: cache, version: '0.1.0' }] } }))

const T = await import('../server/utils/teamSync.ts')
const D = await import('../server/utils/claudeDir.ts')

let s = await T.teamStatus()
assert.equal(s.pluginVersion, '0.1.0')
assert.ok(s.agents.length >= 8 && s.agents.every(a => a.state === 'missing'), 'a fresh directory misses every team agent')
assert.deepEqual(s.skills, [{ name: 'intent-template', state: 'missing' }])
assert.equal(s.workflow.state, 'missing'); assert.ok(s.workflow.steps >= 8)
assert.equal(s.registry.ok, true); assert.equal(s.registry.products, 1)
assert.ok(s.drifted > 8)

s = await T.teamSync()
assert.equal(s.drifted, 0, 'apply leaves nothing drifted')
assert.ok(existsSync(join(process.env.CLAUDE_DIR, 'agents', 'sdlc-ticket-intake.md')))
assert.ok(existsSync(join(process.env.CLAUDE_DIR, 'skills', 'intent-template', 'SKILL.md')))
assert.ok(existsSync(join(process.env.CLAUDE_DIR, 'commands', 'triage.md')), 'plugin commands are seeded too')
{
  const watches = JSON.parse(readFileSync(join(process.env.CLAUDE_DIR, 'watches.json'), 'utf8'))
  const w = (Array.isArray(watches) ? watches : watches.watches).find(x => x.id === 'csup-bugs')
  assert.ok(w, 'a registry watch is seeded')
  assert.equal(w.enabled, false, 'seeded disabled')

  // And a re-seed must never turn one back on. A watch dispatches unattended
  // runs that open pull requests and — with JIRA_POST_ENABLED=1 — comment on
  // real tickets, so "off" has to survive every later apply. Seeding refreshes
  // the query and the cap of an existing watch; the enabled flag is the
  // operator's, not the registry's.
  {
    const path = join(process.env.CLAUDE_DIR, 'watches.json')
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    const list = Array.isArray(doc) ? doc : doc.watches
    const target = list.find(x => x.id === 'csup-bugs')
    target.enabled = true
    writeFileSync(path, JSON.stringify(Array.isArray(doc) ? list : doc, null, 2))

    await T.teamSync()
    const after = JSON.parse(readFileSync(path, 'utf8'))
    const afterList = Array.isArray(after) ? after : after.watches
    assert.equal(afterList.find(x => x.id === 'csup-bugs').enabled, true,
      'a re-seed must not disable a watch the operator enabled')

    target.enabled = false
    writeFileSync(path, JSON.stringify(Array.isArray(doc) ? list : doc, null, 2))
    await T.teamSync()
    const off = JSON.parse(readFileSync(path, 'utf8'))
    const offList = Array.isArray(off) ? off : off.watches
    assert.equal(offList.find(x => x.id === 'csup-bugs').enabled, false,
      'and must not re-enable one the operator disabled')
  }
  assert.equal(w.dailyDispatchCap, 10)
  assert.equal(w.query, 'project = CSUP AND status = Done')
  assert.equal(typeof s.instance.auth, 'string', 'instance facts are reported')
  assert.ok(s.registry.items.every(i => typeof i.key === 'string'), 'registry products are listed')
}
const wf = JSON.parse(readFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'runbook-a-ticket-to-evidence-backed-pr.json'), 'utf8'))
const ids = wf.steps.map(x => x.id)

writeFileSync(join(process.env.CLAUDE_DIR, 'agents', 'sdlc-verifier.md'), 'edited locally')
s = await T.teamStatus()
assert.deepEqual(s.agents.filter(a => a.state !== 'ok').map(a => a.id), ['sdlc-verifier'], 'a local edit reads as drift')
assert.equal(s.workflow.state, 'ok', 'an unchanged workflow with kept ids is in sync')
s = await T.teamSync()
assert.equal(s.drifted, 0)
const wf2 = JSON.parse(readFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'runbook-a-ticket-to-evidence-backed-pr.json'), 'utf8'))
assert.deepEqual(wf2.steps.map(x => x.id), ids, 'step ids survive a re-apply')

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

// ── No plugin: watches must still seed ────────────────────────────────────
//
// This read was plugin-only, so a team container seeded ZERO watches every time
// while engineering/registry/watches.yaml sat unread in the image. "0 watches"
// is a legitimate count for a deployment that has registered none, which is
// exactly why it never looked wrong — the seventh capability in this codebase to
// fall back to nothing without the plugin.
//
// The assertion is on the seeded RESULT with no plugin installed, not on the
// file existing in the repo.
{
  const bare2 = mkdtempSync(join(tmpdir(), 'team-watch-'))
  D.setClaudeDir(bare2)

  const shipped = readFileSync(join(import.meta.dirname, '..', 'engineering', 'registry', 'watches.yaml'), 'utf8')
  const declared = [...shipped.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map(m => m[1])
  assert.ok(declared.length, 'engineering/registry/watches.yaml must declare watches for this to mean anything')

  const st = await T.teamStatus()
  assert.equal(st.pluginVersion, null, 'no plugin is installed in this scenario')
  assert.deepEqual(st.watches.map(w => w.id).sort(), [...declared].sort(),
    'with no plugin installed, watches come from the shipped registry')

  await T.teamSync()
  const seeded = JSON.parse(readFileSync(join(bare2, 'watches.json'), 'utf8'))
  const list = Array.isArray(seeded) ? seeded : seeded.watches
  assert.deepEqual(list.map(w => w.id).sort(), [...declared].sort(), 'and are written to watches.json')

  // Every one seeded OFF. A watch dispatches unattended runs that open pull
  // requests and comment on real tickets; arming one is an operator's decision.
  for (const w of list) assert.equal(w.enabled, false, `${w.id} must seed disabled`)

  rmSync(bare2, { recursive: true, force: true })
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('teamSync: all assertions passed')
