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

console.log('plugin-manifest: all assertions passed')
