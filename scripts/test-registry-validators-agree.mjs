/**
 * The app's validator and the CI script must reach the same verdict.
 *
 * They are two implementations on purpose: `engineering/scripts/validate-registry.mjs`
 * ships inside the alepo-engineering plugin, where the app's `shared/` does not
 * exist, and it parses YAML with its own restricted reader rather than pulling
 * a package into the trusted root of the pipeline. That is a reasonable
 * boundary, but it means nothing structural stops the two drifting.
 *
 * Drift is not a tidiness problem. A save the Products page accepts and CI
 * later refuses is a registry change that looks applied, routes real runs, and
 * then blocks the next unrelated pull request with a failure in a file nobody
 * on that PR touched. The opposite direction is worse: an entry CI accepts and
 * the page refuses cannot be edited from the UI at all.
 *
 * So every rule is exercised through BOTH, over the same fixture.
 *
 *   node scripts/test-registry-validators-agree.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = process.cwd()
const TMP = mkdtempSync(join(tmpdir(), 'validators-agree-'))
process.env.CLAUDE_DIR = join(TMP, 'claude')
mkdirSync(process.env.CLAUDE_DIR, { recursive: true })

const { validateProduct, blocking } = await import('../server/utils/registryValidate.ts')

// A fixture root shaped like engineering/: registry/ plus registry/schemas/.
const fixture = join(TMP, 'fixture')
mkdirSync(join(fixture, 'registry', 'schemas'), { recursive: true })
for (const f of ['products.schema.json', 'watches.schema.json']) {
  copyFileSync(join(repoRoot, 'engineering', 'registry', 'schemas', f), join(fixture, 'registry', 'schemas', f))
}
// One watch that reaches the product below, so the cross-file rules are satisfied
// and the only thing under test is the product entry itself.
writeFileSync(join(fixture, 'registry', 'watches.yaml'), [
  'watches:',
  '  - id: demo-watch',
  '    jql: project = SCN AND status = Open',
  '    work_types: [bug]',
  '    reporter_group: selfcare-leads',
  '    mode: shadow',
  '',
].join('\n'))

/** The registry the CI script parses; its reader takes this subset only. */
function writeProducts(p) {
  const lines = [
    'products:',
    '  demo:',
    `    suite: ${p.suite}`,
    '    match:',
    `      projects: [${p.match.projects.join(', ')}]`,
    ...(p.match.components ? [`      components: [${p.match.components.join(', ')}]`] : []),
    `    repos: [${p.repos.join(', ')}]`,
    ...(p.multi_repo === true ? ['    multi_repo: true'] : []),
    '    branches:',
    `      bug: ${p.branches.bug}`,
    `      feature: ${p.branches.feature}`,
    '    stack:',
    `      compose: ${p.stack.compose}`,
    `      topology_default: ${p.stack.topology_default}`,
    ...(p.stack.liquibase === true ? ['      liquibase: true'] : []),
    '    tests:',
    `      unit: ${p.tests.unit}`,
    ...(p.tests.atdd ? [`      atdd: ${p.tests.atdd}`] : []),
    '    owners:',
    ...Object.entries(p.owners).map(([k, v]) => `      ${k}: ${v === '' ? "''" : v}`),
    '',
  ]
  writeFileSync(join(fixture, 'registry', 'products.yaml'), lines.join('\n'))
}

/** True when the CI script refuses this registry. */
function scriptRefuses() {
  const r = spawnSync(process.execPath,
    [join(repoRoot, 'engineering', 'scripts', 'validate-registry.mjs'), '--root', fixture],
    { encoding: 'utf8' })
  return r.status !== 0
}

const ok = () => ({
  suite: 'bss',
  match: { projects: ['SCN'], components: ['Selfcare'] },
  repos: ['alepolab/selfcarenow'],
  branches: { bug: 'develop', feature: 'develop' },
  stack: { compose: 'alepo-dev-team-infra/scn', topology_default: '1node', liquibase: true },
  tests: { unit: 'pnpm test', atdd: 'pytest --xunit out.xml' },
  owners: { protocol: 'selfcare-leads' },
})

// ══ 1. both accept a clean entry ═══════════════════════════════════════════
{
  const p = ok()
  writeProducts(p)
  assert.equal(scriptRefuses(), false, 'the CI script accepts a clean entry')
  assert.deepEqual(blocking(validateProduct('demo', p)), [], 'and so does the app')
}

// ══ 2. both refuse each broken entry, and for the same rule ════════════════
{
  const cases = [
    ['multi_repo with one repo', (p) => { p.multi_repo = true }],
    ['two repos without multi_repo', (p) => { p.repos = ['alepolab/a', 'alepolab/b'] }],
    ['an atdd command with no xunit', (p) => { p.tests.atdd = 'make atdd' }],
    ['an empty protocol owner', (p) => { p.owners.protocol = '' }],
    ['a placeholder repo name', (p) => { p.repos = ['alepolab/<name>'] }],
    ['a repo that is not owner/name', (p) => { p.repos = ['selfcarenow'] }],
  ]
  for (const [label, mutate] of cases) {
    const p = ok()
    mutate(p)
    writeProducts(p)
    const appRefuses = blocking(validateProduct('demo', p)).length > 0
    assert.equal(appRefuses, true, `THE REQUIREMENT: the app refuses ${label}`)
    assert.equal(scriptRefuses(), true,
      `THE REQUIREMENT: CI refuses ${label} too — a rule only one of them has is drift`)
  }
}

// ══ 3. a warning is a warning on both sides ════════════════════════════════
{
  // No Liquibase tag and no ATDD suite: every shipped product has at least one
  // of these today, so if either implementation hardened one into a refusal the
  // registry would become unsavable from the page that edits it.
  const p = ok()
  delete p.stack.liquibase
  delete p.tests.atdd
  writeProducts(p)
  assert.equal(scriptRefuses(), false, 'CI passes an entry carrying only notes')
  const problems = validateProduct('demo', p)
  assert.deepEqual(blocking(problems), [], 'and the app saves it')
  assert.ok(problems.length >= 2, 'while still reporting both as warnings')
}

rmSync(TMP, { recursive: true, force: true })
console.log('registry validators agree: all assertions passed')
