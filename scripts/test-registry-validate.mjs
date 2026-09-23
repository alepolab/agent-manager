/**
 * What the Products page refuses to save, and what it merely warns about.
 *
 * The two severities are the point. An `error` is an entry that would route
 * runs somewhere nothing can act on - a clone that fails, a merge order that
 * cannot be produced, an ATDD verdict nobody can read. A `warning` saves and
 * is shown; every product in the shipped registry emits at least one today, so
 * refusing on warnings would make the registry unsavable from the page that
 * edits it.
 *
 * The last section is the one that matters most: the rules here and the ones
 * CI enforces are the same module, and the shipped registry must pass both.
 * Two implementations would let a save look applied, route runs, and then block
 * the next unrelated pull request.
 *
 *   node scripts/test-registry-validate.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'registry-validate-'))
const { validateProduct, validateProducts, blocking } = await import('../server/utils/registryValidate.ts')

/** A product that passes everything, to vary one field at a time from. */
const ok = () => ({
  suite: 'bss',
  match: { projects: ['SCN'], components: ['Selfcare'] },
  repos: ['alepolab/selfcarenow'],
  branches: { bug: 'develop', feature: 'develop' },
  stack: { compose: 'alepo-dev-team-infra/scn', topology_default: '1node', liquibase: true },
  tests: { unit: 'pnpm test', atdd: 'pytest --xunit out.xml' },
  owners: { protocol: 'selfcare-leads' },
})

const errorsFor = (p, key = 'demo') => blocking(validateProduct(key, p)).map(e => e.message)

// ══ 1. the baseline saves clean ═══════════════════════════════════════════
{
  assert.deepEqual(errorsFor(ok()), [], 'a complete, consistent entry has nothing blocking')
  assert.deepEqual(validateProduct('demo', ok()), [],
    'and nothing to warn about either, so the warning cases below are about the field they change')
}

// ══ 2. refusals, one rule at a time ═══════════════════════════════════════
{
  const cases = [
    ['multi_repo with one repo', p => { p.multi_repo = true }, /fewer than two repos/],
    ['two repos without multi_repo', p => { p.repos = ['a/b', 'c/d'] }, /not marked multi_repo/],
    ['{version} with no version_source', p => { p.branches.bug = 'release/{version}' }, /declares no version_source/],
    ['an atdd command with no xunit', p => { p.tests.atdd = 'make atdd' }, /does not emit xunit/],
    ['a placeholder repo name', p => { p.repos = ['alepolab/<name>'] }, /still a placeholder/],
    ['an empty protocol owner', p => { p.owners.protocol = '   ' }, /no named approver/],
    ['an empty money owner', p => { p.owners.money = '' }, /no named approver/],
    ['a missing required key', p => { delete p.repos }, /missing required key "repos"/],
    ['an unrecognised key', p => { p.rpos = ['a/b'] }, /not a recognised key/],
    ['a repo that is not owner\\/name', p => { p.repos = ['selfcarenow'] }, /does not match/],
    ['an empty match block', p => { p.match = {} }, /at least 1 entr/],
    ['a ui_trace nobody implements', p => { p.tests.ui_trace = 'cypress' }, /is not one of/],
  ]
  for (const [label, mutate, expected] of cases) {
    const p = ok()
    mutate(p)
    const errors = errorsFor(p)
    assert.ok(errors.some(m => expected.test(m)),
      `THE REQUIREMENT: ${label} is refused, naming why. Got: ${JSON.stringify(errors)}`)
  }
}

// ══ 3. warnings save, and say so ══════════════════════════════════════════
{
  const p = ok()
  delete p.stack.liquibase
  delete p.tests.atdd
  const problems = validateProduct('demo', p)
  assert.deepEqual(blocking(problems), [], 'neither of these refuses the save')
  assert.equal(problems.length, 2, 'both are reported')
  assert.ok(problems.every(x => x.severity === 'warning'), 'as warnings')
  assert.ok(problems.some(x => /Liquibase/.test(x.message)), 'the missing rollback tag is one')
  assert.ok(problems.some(x => /only unit tests/.test(x.message)), 'the missing oracle is the other')
}

// ══ 4. THE ONE THAT MATTERS: the shipped registry passes ══════════════════
{
  const doc = parse(readFileSync(join(process.cwd(), 'engineering', 'registry', 'products.yaml'), 'utf8'))
  const problems = validateProducts(doc.products)
  const errors = blocking(problems)
  assert.deepEqual(errors, [],
    'THE REQUIREMENT: every product the team ships validates clean here, exactly as it does under '
    + 'engineering/scripts/validate-registry.mjs in CI. A rule this validator has and that one does not '
    + 'would make the registry unsavable from the page that edits it.')
  assert.ok(problems.length > 0,
    'and the warnings are still reported — silence would mean the rules never ran')
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('registry validate: all assertions passed')
