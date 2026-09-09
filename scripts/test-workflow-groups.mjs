/**
 * Self-check for the concurrency group registry.
 *
 * The property everything else rests on is that a broken registry degrades to
 * "everything uses the default cap" rather than throwing: this file is read on
 * the path that STARTS runs, so an unreadable one must not mean nothing can
 * start. The second property is that an unknown group id falls back to the
 * default cap rather than to unlimited — a typo in a group name must not
 * quietly remove the cap it was meant to apply.
 *
 *   node scripts/test-workflow-groups.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'wf-groups-'))
delete process.env.AGENT_MAX_CONCURRENT_PIPELINES

const groups = await import('../server/utils/workflowGroups.ts')
const { DEFAULT_GROUP_ID, WORKFLOW_GROUPS_FILE_NAME } = await import('../shared/types/workflowGroup.ts')

const file = join(process.env.CLAUDE_DIR, WORKFLOW_GROUPS_FILE_NAME)

// ══ 1. a registry that does not exist yet ═════════════════════════════════
{
  assert.deepEqual(await groups.listGroups(), [], 'no file means no groups configured')
  assert.equal(await groups.capFor(DEFAULT_GROUP_ID), 2,
    'the default group falls back to the built-in cap of 2')
  assert.equal(await groups.capFor(undefined), 2, 'an unnamed group is the default group')
  assert.equal(await groups.capFor('   '), 2, 'whitespace is not a group name')
}

// ══ 2. round-trip ═════════════════════════════════════════════════════════
{
  const saved = await groups.replaceGroups([
    { id: 'sdlc', name: 'SDLC pipelines', maxConcurrent: 2 },
    { id: 'scans', name: 'Nightly scans', maxConcurrent: 1 },
  ])
  assert.equal(saved.length, 2)
  assert.deepEqual(await groups.listGroups(), saved, 'what was saved is what reads back')
  assert.equal(await groups.capFor('sdlc'), 2)
  assert.equal(await groups.capFor('scans'), 1)

  // Whole-array replace is the write model: the editor saves the table, not a row.
  await groups.replaceGroups([{ id: 'scans', name: 'Nightly scans', maxConcurrent: 3 }])
  assert.deepEqual((await groups.listGroups()).map(g => g.id), ['scans'],
    'replacing the array removes what is no longer in it')
  assert.equal(await groups.capFor('scans'), 3, 'the new cap took effect')
}

// ══ 3. THE FALLBACK: an id nothing names is capped, not unlimited ══════════
{
  // A workflow naming a group that has since been removed from the registry
  // is the same case as a typo, and both must keep a cap. Unlimited here would
  // mean deleting a group silently uncaps every workflow that was in it.
  assert.equal(await groups.capFor('sdlc'), 2,
    'a group id the registry no longer holds falls back to the default cap')
  assert.equal(await groups.capFor('never-existed'), 2, 'so does one that never existed')
}

// ══ 4. refused rows ═══════════════════════════════════════════════════════
{
  const before = await groups.listGroups()

  for (const [bad, why] of [
    [{ id: 'x', name: 'X', maxConcurrent: 0 }, 'zero is an invisible "this group never runs again"'],
    [{ id: 'x', name: 'X', maxConcurrent: -1 }, 'a negative cap is not a cap'],
    [{ id: 'x', name: 'X', maxConcurrent: 1.5 }, 'half a slot does not exist'],
    [{ id: 'x', name: 'X' }, 'a group without a cap has nothing to enforce'],
    [{ id: 'x', name: '  ', maxConcurrent: 1 }, 'a group needs a name to be pickable'],
    [{ id: '  ', name: 'X', maxConcurrent: 1 }, 'a group needs an id to be referenced'],
  ]) {
    await assert.rejects(() => groups.replaceGroups([bad]), why)
  }

  await assert.rejects(
    () => groups.replaceGroups([
      { id: 'dup', name: 'One', maxConcurrent: 1 },
      { id: 'dup', name: 'Two', maxConcurrent: 5 },
    ]),
    'two rows with one id would make the cap depend on which one was found first',
  )

  assert.deepEqual(await groups.listGroups(), before,
    'THE REQUIREMENT: a table with one bad row is refused intact, never half-written')
}

// ══ 5. renaming does not orphan ═══════════════════════════════════════════
{
  await groups.replaceGroups([{ id: 'sdlc', name: 'SDLC pipelines', maxConcurrent: 2 }])
  await groups.replaceGroups([{ id: 'sdlc', name: 'Delivery pipelines', maxConcurrent: 2 }])
  // Membership is by id, which is why the workflows naming 'sdlc' still resolve.
  assert.equal(await groups.capFor('sdlc'), 2, 'a renamed group keeps its members')
  assert.equal((await groups.listGroups())[0].name, 'Delivery pipelines')
}

// ══ 6. a corrupt registry must not stop runs starting ═════════════════════
{
  writeFileSync(file, '{ this is not json', 'utf-8')
  assert.deepEqual(await groups.listGroups(), [], 'unreadable JSON degrades to no groups')
  assert.equal(await groups.capFor('sdlc'), 2, 'and every workflow falls back to the default cap')

  writeFileSync(file, '{"sdlc":2}', 'utf-8')
  assert.deepEqual(await groups.listGroups(), [], 'valid JSON of the wrong shape is also no groups')
}

// ══ 7. the env var is the escape hatch for the default cap ════════════════
{
  await groups.replaceGroups([{ id: 'sdlc', name: 'SDLC', maxConcurrent: 2 }])
  process.env.AGENT_MAX_CONCURRENT_PIPELINES = '5'
  assert.equal(await groups.capFor(DEFAULT_GROUP_ID), 5, 'the env var sets the default group')
  assert.equal(await groups.capFor('sdlc'), 2, 'but never overrides a group that states its own')

  for (const bad of ['0', '-3', 'many', '']) {
    process.env.AGENT_MAX_CONCURRENT_PIPELINES = bad
    assert.equal(groups.defaultMaxConcurrent(), 2, `"${bad}" is not a cap; the built-in default stands`)
  }
  delete process.env.AGENT_MAX_CONCURRENT_PIPELINES
}

// ══ 8. the file on disk is readable by a person ════════════════════════════
{
  await groups.replaceGroups([{ id: 'sdlc', name: '  SDLC pipelines  ', maxConcurrent: 2 }])
  const raw = JSON.parse(readFileSync(file, 'utf-8'))
  assert.deepEqual(raw, [{ id: 'sdlc', name: 'SDLC pipelines', maxConcurrent: 2 }],
    'stored as a plain indented array, with names and ids trimmed')
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('workflowGroups: all assertions passed')
