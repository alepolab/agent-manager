#!/usr/bin/env node
/**
 * Proves the plugin actually installs to something, not just that the JSON
 * parses.
 *
 * The failure mode this guards against: a manifest field renamed, or a file
 * moved, and the plugin installs cleanly while doing nothing. Every relative
 * path either manifest points at is checked against the real filesystem, not
 * assumed from the field merely being present.
 *
 *   node scripts/test-plugin-manifest.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(root, '.claude-plugin')

function readJson(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`cannot read ${path}: ${e.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e.message}`)
  }
}

// ── 1. Both manifests parse as JSON ────────────────────────────────────────
const plugin = readJson(join(pluginDir, 'plugin.json'))
const marketplace = readJson(join(pluginDir, 'marketplace.json'))
console.log('both manifests parse as JSON')

// ── 2. plugin.json identifies itself correctly ─────────────────────────────
assert.equal(plugin.name, 'alepo-engineering', 'plugin.json name must be alepo-engineering')
assert.equal(typeof plugin.version, 'string', 'plugin.json must declare a version')
assert.ok(plugin.version.length > 0, 'plugin.json version must not be empty')
console.log(`plugin.json: name=${plugin.name} version=${plugin.version}`)

// ── 3. The marketplace lists it ────────────────────────────────────────────
assert.ok(Array.isArray(marketplace.plugins), 'marketplace.json must have a plugins array')
const entry = marketplace.plugins.find(p => p.name === 'alepo-engineering')
assert.ok(entry, 'marketplace.json must list a plugin named alepo-engineering')
console.log('marketplace.json lists alepo-engineering')

/**
 * Path-shaped fields the plugin manifest schema recognises (per real installed
 * plugins under ~/.claude/plugins: mattpocock-skills declares an explicit
 * "skills" array; others rely on directory convention and declare none). Each
 * may be a single relative path or an array of them, resolved against the
 * plugin root — the directory containing .claude-plugin/.
 */
const PATH_FIELDS = ['commands', 'agents', 'skills', 'hooks', 'mcpServers']

function collectPaths(manifest) {
  const paths = []
  for (const field of PATH_FIELDS) {
    const value = manifest[field]
    if (value == null) continue
    if (typeof value === 'string') {
      paths.push({ field, value })
    } else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string') paths.push({ field, value: v })
    }
    // Object values (e.g. an inline mcpServers map) name no filesystem path
    // themselves — nothing to check there.
  }
  return paths
}

// ── 4. Every relative path plugin.json references exists on disk ──────────
for (const { field, value } of collectPaths(plugin)) {
  if (!value.startsWith('./') && !value.startsWith('../')) continue // not a path
  const resolved = join(root, value)
  assert.ok(existsSync(resolved),
    `plugin.json "${field}" references "${value}", which does not exist at ${resolved}`)
}
console.log('every filesystem path plugin.json references exists')

// ── 5. The marketplace entry's source resolves to a real, matching plugin ──
const { source } = entry
assert.ok(source, 'marketplace entry must declare a source')
if (typeof source === 'string') {
  const resolved = join(root, source)
  assert.ok(existsSync(resolved) && statSync(resolved).isDirectory(),
    `marketplace source "${source}" must resolve to a directory, checked ${resolved}`)
  const nestedPluginPath = join(resolved, '.claude-plugin', 'plugin.json')
  assert.ok(existsSync(nestedPluginPath),
    `marketplace source "${source}" must contain .claude-plugin/plugin.json, checked ${nestedPluginPath}`)
  const nestedPlugin = readJson(nestedPluginPath)
  assert.equal(nestedPlugin.name, entry.name,
    `plugin.json at the marketplace source names "${nestedPlugin.name}", marketplace entry says "${entry.name}"`)
} else {
  // A remote source (git, git-subdir, ...) — nothing local to check.
  assert.equal(typeof source, 'object', 'a non-string source must be an object (git/git-subdir/...)')
}
console.log('marketplace source resolves to a matching, on-disk plugin.json')

// ── 6. hooks/hooks.json registers the plan gate and the test lock ─────────
//
// This is Task 2's registration step. hooks.json is auto-discovered by
// Claude Code from the plugin's hooks/ directory by convention — no
// installed plugin under ~/.claude/plugins declares a "hooks" field in
// plugin.json for this — so plugin.json is deliberately not asserted on
// here; hooks.json itself is the contract.
const hooksConfigPath = join(root, 'hooks', 'hooks.json')
const hooksConfig = readJson(hooksConfigPath)
console.log('hooks/hooks.json parses as JSON')

assert.ok(hooksConfig.hooks && typeof hooksConfig.hooks === 'object',
  'hooks/hooks.json must have a top-level "hooks" object')
const preToolUse = hooksConfig.hooks.PreToolUse
assert.ok(Array.isArray(preToolUse) && preToolUse.length > 0,
  'hooks/hooks.json must register at least one PreToolUse entry')

/** Every command hooks.json points at must exist under hooks/. */
function commandsIn(entry) {
  return (entry.hooks ?? [])
    .filter(h => h.type === 'command')
    .map(h => h.command)
}

for (const entry of preToolUse) {
  for (const command of commandsIn(entry)) {
    const m = command.match(/hooks\/([\w.-]+\.mjs)/)
    assert.ok(m, `PreToolUse command "${command}" must reference a hooks/*.mjs file`)
    const hookFile = join(root, 'hooks', m[1])
    assert.ok(existsSync(hookFile),
      `PreToolUse command references hooks/${m[1]}, which does not exist at ${hookFile}`)
  }
}
console.log('every hooks.json PreToolUse command references a hook file that exists')

// Find the plan-gate and test-lock registrations specifically.
const planGateEntry = preToolUse.find(e =>
  commandsIn(e).some(c => c.includes('plan-gate.mjs')))
const testLockEntry = preToolUse.find(e =>
  commandsIn(e).some(c => c.includes('test-lock.mjs')))

assert.ok(planGateEntry, 'hooks.json must register plan-gate.mjs on PreToolUse')
assert.ok(testLockEntry, 'hooks.json must register test-lock.mjs on PreToolUse')

// ── 7. THE assertion this task exists for ──────────────────────────────────
//
// test-lock.mjs exists specifically because an agent with Bash does not need
// Edit to rewrite a test (`sed -i`, `> file`, `tee`, `cp`, `git checkout --`
// all work — see the hook's own doc comment). Registering it for `Edit|Write`
// only silently reinstates exactly the bypass the hook was written to close:
// a config that looks like it enables the control while disabling it. This
// must stay a test, not a comment, because it is the one most likely to be
// silently dropped by a future edit.
const testLockMatcher = testLockEntry.matcher ?? ''
const testLockTools = testLockMatcher.split('|').map(t => t.trim())
assert.ok(testLockTools.includes('Bash'),
  `test-lock.mjs PreToolUse matcher is "${testLockMatcher}" and must include "Bash" — ` +
  `an Edit|Write-only matcher reopens the sed -i / tee / git-checkout bypass the hook exists to close`)
assert.ok(testLockTools.includes('Edit') && testLockTools.includes('Write'),
  `test-lock.mjs PreToolUse matcher is "${testLockMatcher}" and must also include "Edit" and "Write"`)
console.log('test-lock.mjs matcher includes Bash (plus Edit|Write): ' + testLockMatcher)

// The plan gate is Edit|Write only by design (plan action B2) — writing a
// plan or arbitrary shell output is not the thing it guards against.
const planGateTools = (planGateEntry.matcher ?? '').split('|').map(t => t.trim())
assert.ok(planGateTools.includes('Edit') && planGateTools.includes('Write'),
  `plan-gate.mjs PreToolUse matcher is "${planGateEntry.matcher}" and must include "Edit" and "Write"`)
console.log('plan-gate.mjs matcher includes Edit and Write: ' + planGateEntry.matcher)

console.log('plugin-manifest: all assertions passed')
