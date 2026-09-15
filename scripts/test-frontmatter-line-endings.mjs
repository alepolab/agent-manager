/**
 * Frontmatter survives the line endings it actually arrives with.
 *
 *   node scripts/test-frontmatter-line-endings.mjs
 *
 * The regex was `\n`-only. Every agent file on a Windows checkout is CRLF, so
 * the match failed and callers got EMPTY frontmatter with the `---` block left
 * in the body - silently, because nothing threw. Observed live on 2026-09-15:
 * GET /api/agents/sdlc-finding-triage returned name, model and maxTurns empty
 * and tools null, and that agent ran with the SDK's full default toolset
 * instead of the four read-only tools it declares.
 *
 * The dimension that varies is the LINE ENDING, so that is what the table
 * covers - not one file that happened to break.
 */
import assert from 'node:assert/strict'
import { parseFrontmatter, serializeFrontmatter } from '../server/utils/frontmatter.ts'

const FM = ['name: sdlc-finding-triage', 'model: sonnet', 'tools:', '  - Read', '  - Grep', 'maxTurns: 30']
const BODY = ['# Triage', '', 'Classify each finding.']

const ROWS = [
  { name: 'LF',                    nl: '\n',   trailing: '' },
  { name: 'CRLF',                  nl: '\r\n', trailing: '' },
  { name: 'LF, trailing newline',  nl: '\n',   trailing: '\n' },
  { name: 'CRLF, trailing newline',nl: '\r\n', trailing: '\r\n' },
  { name: 'CRLF body, no blank line after ---', nl: '\r\n', trailing: '', tight: true },
]

for (const row of ROWS) {
  const raw = ['---', ...FM, '---', ...(row.tight ? [] : ['']), ...BODY].join(row.nl) + row.trailing
  const { frontmatter, body } = parseFrontmatter(raw)

  assert.equal(frontmatter.name, 'sdlc-finding-triage', `${row.name}: name parses`)
  assert.equal(frontmatter.model, 'sonnet', `${row.name}: model parses — an ignored model silently runs every agent on the SDK default`)
  assert.equal(frontmatter.maxTurns, 30, `${row.name}: maxTurns parses`)
  assert.deepEqual(frontmatter.tools, ['Read', 'Grep'],
    `${row.name}: tools parse as an ARRAY — resolveTools hands the SDK its full default toolset for anything else`)
  assert.ok(!body.startsWith('---'), `${row.name}: the frontmatter block is not left in the body`)
  assert.match(body, /# Triage/, `${row.name}: the body survives`)
}

// A file with no frontmatter at all is still a body, not an error.
for (const nl of ['\n', '\r\n']) {
  const { frontmatter, body } = parseFrontmatter(['# Just a doc', '', 'No frontmatter here.'].join(nl))
  assert.deepEqual(frontmatter, {}, 'no frontmatter parses to an empty object')
  assert.match(body, /Just a doc/)
}

// And what we write can be read back, whichever way the file arrives.
{
  const raw = serializeFrontmatter({ name: 'x', tools: ['Read'] }, 'Body text.')
  const { frontmatter } = parseFrontmatter(raw)
  assert.equal(frontmatter.name, 'x')
  assert.deepEqual(frontmatter.tools, ['Read'])
  const { frontmatter: fromCrlf } = parseFrontmatter(raw.replace(/\n/g, '\r\n'))
  assert.equal(fromCrlf.name, 'x', 'a file we wrote, checked out with CRLF, still parses')
  assert.deepEqual(fromCrlf.tools, ['Read'])
}

console.log('frontmatter: LF and CRLF both parse — tools, model and maxTurns survive either')
