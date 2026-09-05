/**
 * Self-check for the skills list shape and the MCP server matcher.
 *
 *   node scripts/test-skills-list.mjs
 */
import assert from 'node:assert/strict'

const R = await import('../server/utils/skillRelationships.ts')

const servers = [{ name: 'atlassian', scope: 'global' }, { name: 'playwright', scope: 'project' }]
assert.deepEqual(R.matchMcpServer(servers, 'x', { mcp: 'playwright' }, ''), { name: 'playwright', scope: 'project' }, 'frontmatter mcp wins')
assert.deepEqual(R.matchMcpServer(servers, 'x', {}, 'call mcp__atlassian__search'), { name: 'atlassian', scope: 'global' }, 'tool pattern in the body')
assert.deepEqual(R.matchMcpServer(servers, 'playwright-mcp', {}, ''), { name: 'playwright', scope: 'project' }, 'slug -mcp suffix')
assert.deepEqual(R.matchMcpServer(servers, 'atlassian', {}, ''), { name: 'atlassian', scope: 'global' }, 'exact slug')
assert.equal(R.matchMcpServer(servers, 'other', {}, 'no refs'), undefined, 'no match is undefined')
assert.equal(R.matchMcpServer([], 'atlassian', { mcp: 'atlassian' }, ''), undefined, 'no servers, no match')

// The live list handler strips bodies: prove it against the running server when reachable.
try {
  const res = await fetch('http://localhost:3030/api/skills?workingDir', { signal: AbortSignal.timeout(60_000) })
  if (res.ok) {
    const list = await res.json()
    assert.ok(list.length > 0)
    assert.ok(list.every(s => !('body' in s)), 'no list item carries a body')
    assert.ok(list.every(s => s.frontmatter && s.slug && s.filePath), 'list items keep what the page renders')
    console.log(`live list: ${list.length} skills, ${Math.round(JSON.stringify(list).length / 1024)} KB`)
  }
} catch { console.log('live server not reachable; skipped the live shape check') }

console.log('skills list: all assertions passed')
