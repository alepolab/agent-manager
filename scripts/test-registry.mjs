/**
 * Self-check for the registry loader and product resolution. The loader reads
 * products.yaml from the installed alepo-engineering plugin, so this fakes an
 * install under a temp CLAUDE_DIR.
 *
 *   node scripts/test-registry.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'registry-'))
const cache = join(process.env.CLAUDE_DIR, 'plugins', 'cache', 'alepo-engineering', 'alepo-engineering', '9.9.9')
mkdirSync(join(cache, 'registry'), { recursive: true })
mkdirSync(join(cache, 'recipes'), { recursive: true })
writeFileSync(join(process.env.CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({
  plugins: { 'alepo-engineering@alepo-engineering': [{ installPath: cache, version: '9.9.9' }] },
}))
writeFileSync(join(cache, 'registry', 'products.yaml'), `
products:
  selfcarenow:
    suite: bss
    match:
      projects: [SCN]
      labels: [NEW_WEB_SELFCARE]
    repos: [alepolab/selfcarenow]
    branches: { bug: main, feature: main }
    stack: { compose: selfcarenow/docker-compose.yml, topology_default: 1node }
    tests: { unit: 'pnpm test' }
    owners: { protocol: selfcare-leads }
  pcrf:
    multi_repo: true
    match:
      components: [PCRF]
      projects: [PCRFV]
    repos: [alepolab/pcrf_cpp14]
    branches: { bug: development, feature: development }
    stack: { compose: alepo-dev-team-infra/pcrf, topology_default: 2node }
    tests: { unit: make test }
    owners: { protocol: pcrf-leads }
`)
writeFileSync(join(cache, 'recipes', 'selfcarenow.md'), '# selfcarenow recipe\n')

const R = await import('../server/utils/registry.ts')
const A = await import('../server/utils/runArtifacts.ts')

const byKey = await R.resolveProduct('SCN-402')
assert.equal(byKey?.name, 'selfcarenow', 'a ticket key resolves by project prefix')
assert.equal(byKey?.recipe, join(cache, 'recipes', 'selfcarenow.md'), 'a recipe file next to the registry is found')
const byLabel = await R.resolveProduct('Some pasted ticket text with label NEW_WEB_SELFCARE in it')
assert.equal(byLabel?.name, 'selfcarenow', 'a label in pasted text resolves')
const byComponent = await R.resolveProduct('PCRF session drops after rekey')
assert.equal(byComponent?.name, 'pcrf', 'a component word resolves')
assert.equal(byComponent?.recipe, undefined, 'no recipe file, no recipe path')
assert.equal(byComponent?.multiRepo, true, 'multi_repo flag is carried')
assert.equal(byKey?.multiRepo, undefined, 'absent flag stays absent')
assert.match(A.artifactHeader('/tmp/x', byComponent), /Multi-repo: yes/, 'header states the multi-repo rule')
assert.doesNotMatch(A.artifactHeader('/tmp/x', byKey), /Multi-repo/, 'single-repo products get no multi-repo line')
assert.match(A.artifactHeader('/tmp/x', byKey), /Checkouts: ~\/alepo-workspace/, 'header states the checkout convention')
assert.equal(await R.resolveProduct('nothing here'), undefined, 'no match is undefined, never a guess')

const header = A.artifactHeader('/tmp/x', byKey)
assert.match(header, /## Product \(from the registry\)/, 'header carries a product block')
assert.match(header, /alepolab\/selfcarenow/, 'header names the repo')
assert.match(header, /suite: bss/, 'header names the suite')
assert.match(header, /bug: main/, 'header names the branch policy')
assert.match(header, /Recipe: .*selfcarenow\.md/, 'header points at the recipe')
assert.doesNotMatch(A.artifactHeader('/tmp/x'), /## Product/, 'no product, no block')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('registry: all assertions passed')
