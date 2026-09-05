/**
 * Self-check for the team sync: drift detection and apply against a temp
 * config directory with a fake plugin install.
 *
 *   node scripts/test-team-sync.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'team-'))
const cache = join(process.env.CLAUDE_DIR, 'plugins', 'cache', 'alepo-engineering', 'alepo-engineering', '0.1.0')
mkdirSync(join(cache, 'skills', 'intent-template'), { recursive: true })
mkdirSync(join(cache, 'registry'), { recursive: true })
writeFileSync(join(cache, 'skills', 'intent-template', 'SKILL.md'), '---\nname: intent-template\ndescription: d\n---\nbody\n')
writeFileSync(join(cache, 'registry', 'products.yaml'), 'products:\n  x:\n    match: { projects: [X] }\n    repos: [o/r]\n    branches: { bug: main, feature: main }\n    stack: { compose: a, topology_default: 1node }\n    tests: { unit: t }\n    owners: { docs: d }\n')
writeFileSync(join(process.env.CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'alepo-engineering@alepo-engineering': [{ installPath: cache, version: '0.1.0' }] } }))

const T = await import('../server/utils/teamSync.ts')

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

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('teamSync: all assertions passed')
