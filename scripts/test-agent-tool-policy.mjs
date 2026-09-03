/**
 * Self-check for server/utils/agentToolPolicy.ts - how an agent's frontmatter
 * decides its toolset and turn budget. No test framework in this repo: plain asserts.
 *
 *   node scripts/test-agent-tool-policy.mjs
 */
import assert from 'node:assert/strict'
import {
  resolveAllowedTools,
  resolveMaxTurns,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_MAX_TURNS,
} from '../server/utils/agentToolPolicy.ts'

// ── 1. No frontmatter at all falls back to today's behaviour ──────────────
assert.deepEqual(resolveAllowedTools(undefined), [...DEFAULT_ALLOWED_TOOLS])
assert.equal(resolveMaxTurns(undefined), DEFAULT_MAX_TURNS)

// ── 2. An agent that declares nothing keeps today's behaviour ─────────────
assert.deepEqual(resolveAllowedTools({}), [...DEFAULT_ALLOWED_TOOLS])
assert.equal(resolveMaxTurns({}), DEFAULT_MAX_TURNS)
assert.deepEqual(DEFAULT_ALLOWED_TOOLS, ['Read', 'Write', 'Edit', 'Glob', 'Grep'])
assert.equal(DEFAULT_MAX_TURNS, 10)

// ── 3. A declared toolset is used verbatim, Bash included ─────────────────
assert.deepEqual(
  resolveAllowedTools({ tools: ['Bash', 'Read', 'Glob'] }),
  ['Bash', 'Read', 'Glob'],
)

// ── 4. An empty tools array is a declaration, not an absence ──────────────
// A step that should touch nothing must be able to say so.
assert.deepEqual(resolveAllowedTools({ tools: [] }), [])

// ── 5. A declared turn budget wins; nonsense values fall back ─────────────
assert.equal(resolveMaxTurns({ maxTurns: 40 }), 40)
assert.equal(resolveMaxTurns({ maxTurns: 0 }), DEFAULT_MAX_TURNS)
assert.equal(resolveMaxTurns({ maxTurns: -5 }), DEFAULT_MAX_TURNS)
assert.equal(resolveMaxTurns({ maxTurns: 2.5 }), DEFAULT_MAX_TURNS)

console.log('agentToolPolicy: all assertions passed')
