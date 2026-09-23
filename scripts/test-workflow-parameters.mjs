/**
 * Self-check for a workflow's declared inputs.
 *
 * The property everything else rests on is that resolveParameters keeps ONLY
 * what the workflow declared: that is what makes handing a parent run's whole
 * parameter map to a child workflow safe, and it is what keeps a step header
 * from stating facts nothing in that workflow asked for.
 *
 *   node scripts/test-workflow-parameters.mjs
 */
import assert from 'node:assert/strict'

const {
  resolveParameters, isValidParameterName, RESERVED_PARAM_PROJECT_DIR,
} = await import('../shared/utils/workflowParameters.ts')

// ══ nothing declared, nothing resolved ════════════════════════════════════
{
  assert.deepEqual(resolveParameters(undefined, undefined), { values: {}, missing: [] })
  assert.deepEqual(resolveParameters([], { repo: '/x' }), { values: {}, missing: [] },
    'a workflow that declares nothing carries nothing, whatever the caller sent')
}

// ══ THE PROPERTY: undeclared keys are dropped ═════════════════════════════
{
  const { values, missing } = resolveParameters(
    [{ name: 'jira_project' }],
    { jira_project: 'DEVOPS', severity: 'high', projectDir: '/repos/ase' },
  )
  assert.deepEqual(values, { jira_project: 'DEVOPS' },
    'only the declared name survives - severity and projectDir were never declared here')
  assert.deepEqual(missing, [])
}

// ══ defaults ══════════════════════════════════════════════════════════════
{
  const { values } = resolveParameters([{ name: 'severity', default: 'medium' }], {})
  assert.deepEqual(values, { severity: 'medium' }, 'an unsupplied parameter takes its default')

  const supplied = resolveParameters([{ name: 'severity', default: 'medium' }], { severity: 'high' })
  assert.deepEqual(supplied.values, { severity: 'high' }, 'a supplied value beats the default')

  // The modal prefills each field with its default, so a cleared field must
  // not defeat the declaration that says what the value should be.
  const cleared = resolveParameters([{ name: 'severity', default: 'medium' }], { severity: '   ' })
  assert.deepEqual(cleared.values, { severity: 'medium' },
    'a blank supplied value falls back to the default rather than overriding it with nothing')
}

// ══ required, and what counts as absent ═══════════════════════════════════
{
  const bare = resolveParameters([{ name: 'repo', required: true }], {})
  assert.deepEqual(bare.values, {})
  assert.deepEqual(bare.missing, ['repo'], 'a required parameter with nothing behind it is named')

  const blank = resolveParameters([{ name: 'repo', required: true }], { repo: '  \t ' })
  assert.deepEqual(blank.missing, ['repo'],
    'whitespace is not a value: `repo: ` in a step header teaches an agent nothing')

  const met = resolveParameters([{ name: 'repo', required: true, default: '/repos/ase' }], {})
  assert.deepEqual(met, { values: { repo: '/repos/ase' }, missing: [] },
    'a default satisfies required - the operator does not have to retype it')

  const many = resolveParameters(
    [{ name: 'a', required: true }, { name: 'b' }, { name: 'c', required: true }],
    { b: 'given' },
  )
  assert.deepEqual(many.missing, ['a', 'c'], 'every missing name is reported, not just the first')
  assert.deepEqual(many.values, { b: 'given' })
}

// ══ trimming, and a declaration with no usable name ═══════════════════════
{
  const { values } = resolveParameters([{ name: 'repo' }], { repo: '  /repos/ase \n' })
  assert.deepEqual(values, { repo: '/repos/ase' }, 'values are trimmed before an agent is told them')

  const junk = resolveParameters([{ name: '  ' }, { name: 'ok', default: 'v' }], {})
  assert.deepEqual(junk, { values: { ok: 'v' }, missing: [] },
    'a nameless declaration is skipped rather than resolved to an empty key')
}

// ══ the reserved name is an ordinary parameter HERE ════════════════════════
{
  // resolveParameters does not bind anything - it resolves. The binding lives
  // in the start route and the schedule starter, which read this value out.
  // Keeping it a plain value here is what lets the schedule starter strip it.
  assert.equal(RESERVED_PARAM_PROJECT_DIR, 'projectDir')
  const { values } = resolveParameters(
    [{ name: RESERVED_PARAM_PROJECT_DIR, required: true }],
    { projectDir: '/repos/ase' },
  )
  assert.deepEqual(values, { projectDir: '/repos/ase' })
}

// ══ names ═════════════════════════════════════════════════════════════════
{
  for (const ok of ['repo', 'jira_project', 'projectDir', 'a1']) {
    assert.ok(isValidParameterName(ok), `${ok} is a usable name`)
  }
  for (const bad of ['', '1repo', 'Repo', 'repo-path', 'repo path', 'repo.path', '_repo']) {
    assert.ok(!isValidParameterName(bad), `${bad} is not a usable name`)
  }
}

console.log('workflowParameters: all assertions passed')
