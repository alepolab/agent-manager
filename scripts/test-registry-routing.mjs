/**
 * A ticket resolves to a product without a plugin installed, and infra work
 * lands on the deployment repo.
 *
 *   node scripts/test-registry-routing.mjs
 *
 * Two defects, one of which had been silent since team mode shipped.
 *
 * registryPath() read products.yaml ONLY from the installed alepo-engineering
 * plugin. A team container installs no plugin, so registryPath returned null,
 * loadRegistry returned null, and resolveProduct returned undefined for EVERY
 * ticket. No repos, no branch policy, no stack profile, no test commands — the
 * agents improvised all of it, and in one run two of them improvised different
 * checkout directories. It was invisible because "no product matched this
 * ticket" and "the registry could not be found" both surfaced as undefined.
 *
 * And nothing claimed the DEVOPS project or any infrastructure vocabulary, so
 * compose and deployment work resolved to nothing even with a registry loaded.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// No plugin: an empty config directory, exactly what a fresh container has.
process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'reg-'))
delete process.env.AGENT_REGISTRY_PATH

const { resolveProduct, loadRegistry } = await import('../server/utils/registry.ts')

const reg = await loadRegistry()
assert.ok(reg, 'the registry must load from the shipped copy when no plugin is installed')
assert.ok(reg.path.includes('engineering/registry'), `expected the shipped copy, got ${reg?.path}`)

const routes = async t => (await resolveProduct(t))?.name

// Infra work lands on the deployment repo.
assert.equal(await routes('DEVOPS-15: add the Eswatini post-migrate compose profile'), 'infra')
assert.equal(await routes('Add a healthcheck to the crm service in docker-compose.crm.yml'), 'infra')
assert.equal(await routes('Dockerfile base image needs pinning before the GHCR push'), 'infra')

// The shared services have no repo of their own: they exist only as compose
// services in the deployment repo, so a ticket against one is a change to it.
assert.equal(await routes('RabbitMQ queue not draining on the shared stack'), 'infra')
assert.equal(await routes('Keycloak realm role missing after re-seed'), 'infra')

const infra = await resolveProduct('DEVOPS-15: compose profile')
assert.deepEqual(infra.repos, ['alepolab/alepo-dev-team-infra'],
  'infra work must target the deployment repo and nothing else')
assert.equal(infra.branches.bug, 'develop', 'a fix enters at develop and is promoted from there')

// The fallback must not steal a ticket that belongs to a product. A PCRF ticket
// mentioning docker still resolves to pcrf: the project-key tier is decided
// before any component word is considered.
assert.equal(await routes('PCRFV-88: policy engine drops a session, seen in the docker logs'), 'pcrf')
assert.equal(await routes('SCN-402: selfcare page blank'), 'selfcarenow')

// And it is a fallback, not a catch-all: a ticket about nothing still matches
// nothing, because guessing a product is how a run stands up the wrong stack.
assert.equal(await routes('Nothing in particular about anything'), undefined)

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('registry routing: resolves with no plugin, infra work lands on the deployment repo')
