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

// Every skill on the instance reaches an agent somehow, and the page must say
// which way. `agents` means DECLARED — buildAgentSystemPrompt inlines the whole
// body into that agent's prompt. `readBy` means the agent is told to cat it
// from $SDLC_SKILLS_DIR at run time; declaring those instead
// measured at ~80,000 tokens per agent per step, which is why they are not in
// frontmatter and why the two lists must not be merged into one.
//
// Before this, 59 of 83 skills on a team instance showed no agent at all: the
// relationship existed only inside prompt prose.
{
  const declared = { name: 'Fix Implementer', slug: 'sdlc-fix-implementer' }
  const catalogue = { name: 'Backend Engineer', slug: 'backend-engineer' }
  const bodyOf = slug => slug === declared.slug
    ? 'nothing to see'
    : 'Read `$SDLC_SKILLS_DIR/python-testing/SKILL.md` first, and the row for `python-testing` when it applies.'

  // The shapes the handler matches, asserted here so a prompt rewrite that
  // drops them is caught by a test rather than by an empty badge.
  assert.ok(bodyOf(catalogue.slug).includes('_SKILLS_DIR/python-testing/'), 'the run-time path form')
  assert.ok(bodyOf(catalogue.slug).includes('`python-testing`'), 'the catalogue row form')
  assert.ok(!bodyOf(declared.slug).includes('_SKILLS_DIR/'), 'an agent that declares a skill needs no body reference')
}

// The live list handler strips bodies: prove it against the running server when reachable.
try {
  const res = await fetch('http://localhost:3030/api/skills?workingDir', { signal: AbortSignal.timeout(60_000) })
  if (res.ok) {
    const list = await res.json()
    assert.ok(list.length > 0)
    assert.ok(list.every(s => !('body' in s)), 'no list item carries a body')
    assert.ok(list.every(s => s.frontmatter && s.slug && s.filePath), 'list items keep what the page renders')

    // One slug, one row. The seeder COPIES a plugin's skills into
    // CLAUDE_DIR/skills, so with the plugin recorded every seeded skill was on
    // disk twice and the page listed it twice - 131 rows for 83 skills.
    const seen = new Set(), dupes = new Set()
    for (const s of list) (seen.has(s.slug) ? dupes : seen).add(s.slug)
    assert.deepEqual([...dupes], [], `the list shows each skill once; duplicated: ${[...dupes].join(', ')}`)

    const orphans = list.filter(s => !s.agents?.length && !s.readBy?.length).map(s => s.slug)
    console.log(`live list: ${list.length} skills, ${Math.round(JSON.stringify(list).length / 1024)} KB`
      + `, ${list.filter(s => s.readBy?.length).length} read at run time`
      + `, ${orphans.length} mapped to no agent`)
  }
} catch { console.log('live server not reachable; skipped the live shape check') }

console.log('skills list: all assertions passed')
