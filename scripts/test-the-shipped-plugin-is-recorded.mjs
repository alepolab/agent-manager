/**
 * The Plugins page reads ONE file — CLAUDE_DIR/plugins/installed_plugins.json.
 * A team container installs no plugin through the marketplace (no `claude`
 * binary in the image), so that file never existed and the page was
 * permanently empty while the plugin's agents, skills, commands and hooks were
 * demonstrably seeded onto the instance from engineering/.
 *
 * What this guards, in order of how quietly each would fail:
 *  - the record is written at seed time, so the page lists the plugin;
 *  - it is NOT overwritten when a real install already owns it;
 *  - the scope is 'shipped', because promoteToTeam reads that field to decide
 *    whether merging a promotion PR can change this box — flip it to 'user'
 *    and a promotion reports success while nothing changes here;
 *  - settings.json marks it enabled, since the page defaults that to false and
 *    would list an armed plugin as switched off.
 *
 *   node scripts/test-the-shipped-plugin-is-recorded.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const shipped = join(process.cwd(), 'engineering')
const manifest = join(shipped, '.claude-plugin', 'plugin.json')
assert.ok(existsSync(manifest), 'engineering/.claude-plugin/plugin.json must exist — the Dockerfile COPYs it into the image')

const ID = 'alepo-engineering@alepo-engineering'
const readRecord = dir => JSON.parse(readFileSync(join(dir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins[ID][0]

// A fresh instance: nothing installed, nothing recorded.
{
  process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'plugin-record-'))
  const T = await import('../server/utils/teamSync.ts')

  assert.equal(await T.pluginInstall(), null, 'nothing is recorded before the first seed')
  await T.teamSync('test')

  const entry = readRecord(process.env.CLAUDE_DIR)
  assert.equal(entry.installPath, shipped, 'the record points at the copy shipped in the image')
  assert.equal(entry.scope, 'shipped', "scope 'shipped' is what keeps promote's redeploy note")
  assert.equal(entry.version, JSON.parse(readFileSync(manifest, 'utf8')).version)

  const settings = JSON.parse(readFileSync(join(process.env.CLAUDE_DIR, 'settings.json'), 'utf8'))
  assert.equal(settings.enabledPlugins[ID], true, 'listed as enabled, not switched off')

  // The page's own read path: install record -> manifest -> skills/.
  assert.ok(existsSync(join(entry.installPath, '.claude-plugin', 'plugin.json')), 'the detail route finds the manifest')
  // engineering/ no longer ships skills — the estate comes from the
  // oh-my-agent SSOT in .agents/ — so the plugin is recorded and listed, but
  // carries no skills of its own. The record, scope and manifest still matter.
  console.log('  ok   a fresh instance records the shipped plugin, enabled')

  // The compound-engineering plugin, in the image at vendor/, is the one an
  // operator actually went looking for and could not find. It is recorded only
  // where it is present: a checkout that has not run the Dockerfile's fetch
  // has no vendor/ directory, and inventing an install for it would be the
  // same fiction this test exists to prevent.
  const ce = JSON.parse(readFileSync(join(process.env.CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf8'))
    .plugins['compound-engineering@compound-engineering']?.[0]
  if (existsSync(join(process.cwd(), 'vendor', 'compound-engineering'))) {
    assert.ok(ce, 'the compound-engineering plugin is recorded when the image carries it')
    assert.equal(ce.scope, 'shipped')
    assert.match(ce.version, /^\d+\.\d+\.\d+$/, 'version comes from upstream VERSION, first token only')
    // ceSkillsDir reads this same record and joins 'skills' onto it.
    assert.ok(existsSync(join(ce.installPath, 'skills', 'ce-plan', 'SKILL.md')),
      'the recorded path is the one ceSkillsDir resolves CE_SKILLS_DIR from')
    console.log('  ok   compound-engineering recorded too, where ceSkillsDir looks')
  } else {
    assert.equal(ce, undefined, 'nothing is recorded for a plugin this checkout does not carry')
    console.log('  ok   no vendor/compound-engineering here; correctly not recorded')
  }
}

// A real install already there: left alone, both times.
{
  process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'plugin-record-'))
  mkdirSync(join(process.env.CLAUDE_DIR, 'plugins'), { recursive: true })
  const mine = { plugins: { [ID]: [{ scope: 'user', installPath: '/somewhere/else', version: '9.9.9' }] } }
  writeFileSync(join(process.env.CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify(mine))
  writeFileSync(join(process.env.CLAUDE_DIR, 'settings.json'), JSON.stringify({ statusLine: 'keep me' }))

  const { teamSync } = await import(`../server/utils/teamSync.ts?owned=${Date.now()}`)
  await teamSync('test')

  const entry = readRecord(process.env.CLAUDE_DIR)
  assert.equal(entry.installPath, '/somewhere/else', 'an operator-owned install record is never overwritten')
  assert.equal(entry.version, '9.9.9')
  const settings = JSON.parse(readFileSync(join(process.env.CLAUDE_DIR, 'settings.json'), 'utf8'))
  assert.equal(settings.statusLine, 'keep me', 'settings.json is left alone when the record already exists')
  console.log('  ok   a real install is left alone')
}

console.log('the shipped plugin is recorded: PASS')
