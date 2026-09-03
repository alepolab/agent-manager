#!/usr/bin/env node
/**
 * Content authoring check: skills, commands and templates.
 *
 * A skill or command with broken frontmatter, or a `name` that disagrees
 * with its own directory, resolves inconsistently depending on the lookup
 * path — Claude Code's directory-convention loader finds it under its
 * folder name, but anything that reads `name` out of the frontmatter finds
 * a different string. That must fail here, not surface later as "the skill
 * that sometimes doesn't trigger."
 *
 * The triage command carries a second, sharper property: it is documented
 * as read-only, and the only thing that actually enforces that is its own
 * `allowed-tools` line. This file asserts that line excludes `Write` and
 * `Edit` explicitly, for the same reason test-plugin-manifest.mjs asserts
 * the test-lock matcher includes `Bash` — it is the detail most likely to
 * be silently dropped by a future edit.
 *
 * No dependencies: frontmatter here is a flat `key: value` block (no nested
 * maps, no folded scalars) by construction, so a full YAML parser buys
 * nothing — a value outside that shape is a content bug, not something to
 * parse around.
 *
 *   node scripts/test-skills.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Parse a Markdown file's leading `---`-delimited frontmatter into a flat
 * object of string values. Returns null if the file has no frontmatter
 * block at all — a missing block and an empty one are different failures,
 * and callers need to tell them apart.
 */
function readFrontmatter(path) {
  const text = readFileSync(path, 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const fm = {}
  for (const rawLine of m[1].split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/)
    assert.ok(kv, `${path}: frontmatter line is not "key: value": "${line}"`)
    let [, key, value] = kv
    value = value.trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    fm[key] = value
  }
  return fm
}

// ═══ Skills ══════════════════════════════════════════════════════════════

const skillsDir = join(root, 'skills')
assert.ok(existsSync(skillsDir), 'skills/ must exist')

const skillDirs = readdirSync(skillsDir).filter(name =>
  statSync(join(skillsDir, name)).isDirectory())
assert.ok(skillDirs.length > 0, 'skills/ must contain at least one skill directory')

for (const dirName of skillDirs) {
  const skillPath = join(skillsDir, dirName, 'SKILL.md')
  assert.ok(existsSync(skillPath), `skills/${dirName}/ must contain SKILL.md`)

  const fm = readFrontmatter(skillPath)
  assert.ok(fm, `skills/${dirName}/SKILL.md must start with a --- frontmatter block`)
  assert.ok(fm.name, `skills/${dirName}/SKILL.md frontmatter must declare "name"`)
  assert.ok(fm.description, `skills/${dirName}/SKILL.md frontmatter must declare "description"`)

  // THE assertion this task exists for: a skill whose name disagrees with
  // its directory resolves inconsistently depending on the lookup path.
  assert.equal(fm.name, dirName,
    `skills/${dirName}/SKILL.md frontmatter name is "${fm.name}", which does not match its ` +
    `directory "${dirName}" — Claude Code's directory loader and anything reading the ` +
    `frontmatter "name" field directly would resolve this skill under two different strings`)
}
console.log(`skills: ${skillDirs.length} directories, each has a SKILL.md whose name matches its directory`)

// Both content skills this task set out to write must actually be present —
// not just "whatever is in skills/ is internally consistent."
for (const slug of ['regression-matrix', 'intent-template']) {
  assert.ok(skillDirs.includes(slug), `skills/${slug}/ must exist`)
}
console.log('skills: regression-matrix and intent-template are both present')

// ═══ Commands ════════════════════════════════════════════════════════════

const commandsDir = join(root, 'commands')
assert.ok(existsSync(commandsDir), 'commands/ must exist')

const commandFiles = readdirSync(commandsDir).filter(f => f.endsWith('.md'))
for (const slug of ['triage', 'reproduce', 'baseline']) {
  assert.ok(commandFiles.includes(`${slug}.md`), `commands/${slug}.md must exist`)
}

const commandFrontmatter = {}
for (const file of commandFiles) {
  const path = join(commandsDir, file)
  const fm = readFrontmatter(path)
  assert.ok(fm, `commands/${file} must start with a --- frontmatter block`)
  assert.ok(fm.description, `commands/${file} frontmatter must declare "description"`)
  commandFrontmatter[file] = fm
}
console.log(`commands: ${commandFiles.length} files, each has parseable frontmatter with a description`)

// ── THE assertion Task 4 exists for ─────────────────────────────────────
//
// The triage identity is comment-only by design: it classifies and reports,
// it never mutates a file. A workflow that CAN write contradicts that
// identity even if it never actually does — the guarantee a caller relies
// on is "this cannot write," not "this happens not to." allowed-tools is
// the only thing that makes that guarantee real, so it is asserted here
// directly against the tool list, not against prose in the command body.
const triageAllowedTools = commandFrontmatter['triage.md']['allowed-tools']
assert.ok(triageAllowedTools, 'commands/triage.md frontmatter must declare "allowed-tools"')

const triageTools = triageAllowedTools
  .split(',')
  .map(t => t.trim())
  .map(t => t.replace(/\(.*$/, '')) // strip a Bash(...)-style scope suffix, keep the base tool name
  .filter(Boolean)

assert.ok(!triageTools.includes('Write'),
  `commands/triage.md allowed-tools is "${triageAllowedTools}" and includes "Write" — ` +
  `triage is documented as read-only, and a workflow that can write contradicts the identity ` +
  `model the whole pipeline rests on`)
assert.ok(!triageTools.includes('Edit'),
  `commands/triage.md allowed-tools is "${triageAllowedTools}" and includes "Edit" — ` +
  `triage is documented as read-only, and a workflow that can write contradicts the identity ` +
  `model the whole pipeline rests on`)
console.log(`commands/triage.md: allowed-tools ("${triageAllowedTools}") excludes Write and Edit`)

// ═══ Templates ═══════════════════════════════════════════════════════════

const templatesDir = join(root, 'templates')
assert.ok(existsSync(templatesDir), 'templates/ must exist')

for (const file of ['REVIEW.md', 'CLAUDE.md']) {
  const path = join(templatesDir, file)
  assert.ok(existsSync(path), `templates/${file} must exist`)
  const text = readFileSync(path, 'utf8')
  assert.ok(text.trim().length > 0, `templates/${file} must not be empty`)
}
console.log('templates: REVIEW.md and CLAUDE.md both exist and are non-empty')

console.log('skills: all assertions passed')
