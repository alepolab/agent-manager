// A name that came from a request body never escapes the directory it is
// supposed to name a file in. resolveClaudePath is a bare join, so an id of
// `../../x` used to turn a state file into an arbitrary read, overwrite and
// unlink; every such path goes through resolveClaudeFile instead.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'claude-path-'))
process.env.CLAUDE_DIR = root

const { resolveClaudeFile, resolveClaudePath, safeSegment } = await import('../server/utils/claudeDir.ts')

const DIR = 'schedule-state'
const base = resolve(resolveClaudePath(DIR))
const inside = (p) => p.startsWith(base + sep)

// An ordinary id is untouched: the guard must not rename the files that already exist.
assert.equal(resolveClaudeFile(DIR, 'nightly-scan'), join(base, 'nightly-scan.json'))
assert.equal(resolveClaudeFile(DIR, 'a1'), join(base, 'a1.json'))

// The traversal that motivated this. Each of these used to resolve outside `base`.
for (const evil of [
  '../../x',
  '../../../../etc/passwd',
  '..',
  '../',
  './../x',
  '..\\..\\x',
  'a/../../b',
  'a\\..\\..\\b',
  '/etc/passwd',
  'C:\\Windows\\system32\\config',
  '.hidden',
  '...',
  'x/y',
  'x\\y',
]) {
  const path = resolveClaudeFile(DIR, evil)
  assert.ok(inside(path), `"${evil}" resolved to ${path}, which is outside ${base}`)
  // Contained is the property, not cosmetic: dots surviving INSIDE the file
  // name (`__.._x.json`) are just an odd name, not a way out.
  assert.equal(path.split(sep).length, base.split(sep).length + 1, `"${evil}" named more than one path segment`)
}

// A URL-encoded traversal is not decoded anywhere on this path, so it is just
// an odd name - but it must still stay inside.
assert.ok(inside(resolveClaudeFile(DIR, '%2e%2e/%2e%2e/x')))

// The segment rule itself: separators and dots go, the rest survives, and an
// id that reduces to nothing still names something.
assert.equal(safeSegment('nightly-scan'), 'nightly-scan')
assert.equal(safeSegment('a.b_c-1'), 'a.b_c-1')
assert.equal(safeSegment('..'), '_')
assert.equal(safeSegment('/'), '_')
assert.equal(safeSegment(''), 'entry')
assert.equal(safeSegment('x'.repeat(200)).length, 80, 'a name is capped, so it cannot blow a path length limit')

// Distinct ids stay distinct for the ids callers actually have - the regex on
// the POST routes is what keeps it that way, this is the reminder of why.
assert.notEqual(resolveClaudeFile(DIR, 'nightly'), resolveClaudeFile(DIR, 'weekly'))

// The same guard, for the other directories that build a path from an id.
for (const dir of ['watch-state', 'watch-tickets', 'workflows']) {
  const b = resolve(resolveClaudePath(dir))
  assert.ok(resolveClaudeFile(dir, '../../x').startsWith(b + sep), `${dir} is not contained`)
}

console.log('claude path containment: all checks passed')
