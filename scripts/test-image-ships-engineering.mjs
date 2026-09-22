/**
 * The image ships every part of `engineering/` the app resolves at runtime.
 *
 *   node scripts/test-image-ships-engineering.mjs
 *
 * Why this exists: the Dockerfile has now been fixed four times for the same
 * shape of bug — a script or table shipped without the thing it reads. The
 * scripts went in after a run reported "assemble-bundle.mjs is not installed
 * anywhere in this Agent Manager installation"; the registry, skills and
 * commands each went in after their own version of it. Then a real run reached
 * the evidence step and halted on
 *
 *   assemble-bundle.mjs cannot run — its dependency
 *   schemas/evidence-bundle.v0.1.schema.json is missing from this installation
 *
 * with the pull request already open. The same audit found `recipes/` absent
 * too, and that one never announces itself: registry.ts resolves a recipe with
 * existsSync, so a container without them reports "no recipe" for all 22
 * products and the provisioner runs on less than it was told to read.
 *
 * A COPY line is easy to forget precisely because nothing fails at build time.
 * This lists what the running app reaches for, and why, so the next addition
 * has to be a deliberate decision rather than an omission.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf-8')

/** Each entry: the directory, and what breaks in a container without it. */
const SHIPPED = [
  ['commands', 'same fallback one level down; without it a container seeds zero commands'],
  ['registry', 'resolveProduct returns undefined for every ticket: no repos, no branch policy, no stack profile'],
  ['scripts', 'the evidence step is instructed to run engineering/scripts/assemble-bundle.mjs'],
  ['schemas', 'assemble-bundle.mjs validates against schemas/evidence-bundle.v0.1.schema.json and halts without it'],
  ['recipes', 'registry.ts resolves <registry>/../../recipes/<key>.md; absent, every product silently has no recipe'],
  ['hooks', 'agentHooks.ts falls back to /app/engineering/hooks, and in a container that is the ONLY path that resolves: the staged installed_plugins.json records the host\'s installPath. Absent, preflight fails every run on "the guardrail hooks are on neither"'],
  ['.claude-plugin', 'teamSync reads the manifest for shippedVersion AND records this directory as the installed plugin, which is what puts it on the Plugins page; absent, the page is empty on an instance whose plugin is demonstrably installed'],
]

for (const [dir, why] of SHIPPED) {
  assert.ok(existsSync(join(root, 'engineering', dir)),
    `engineering/${dir} exists in the repo`)
  assert.ok(dockerfile.includes(`engineering/${dir} ./engineering/${dir}`),
    `the Dockerfile ships engineering/${dir} — without it, ${why}`)
}

// The specific file the evidence step named when it halted. Named on its own
// because the directory existing is not the same as the schema being in it.
const schemas = readdirSync(join(root, 'engineering', 'schemas'))
assert.ok(schemas.some(f => f.startsWith('evidence-bundle.') && f.endsWith('.schema.json')),
  `engineering/schemas holds the evidence-bundle schema; found: ${schemas.join(', ') || '(empty)'}`)

// The compound-engineering fetch was removed with Runbook C: nothing reads
// those skills now, so the Dockerfile no longer pins or fetches them.


// Anything new under engineering/ is a deliberate choice, not an oversight: a
// directory the app reads must be added above, one it does not must be named
// here. Both halves are cheap; a silent third option is what this file exists
// to prevent.
const NOT_SHIPPED = new Set([
  'docs',       // written for people reading the repo, not for the running app
  'templates',  // authoring aids for the plugin itself
  // Definitions for six review personas the full-lifecycle workflow names:
  // business-analyst, ui-architect, security-reviewer, persona-reviewer,
  // visual-qa and cto-reviewer.
  //
  // NOT SHIPPED because nothing reads it yet, and saying so here is the point.
  // Agents are seeded by teamSync from the oh-my-agent estate under
  // `.agents/agents/` — `agentTemplates` in app/utils/templates.ts is empty on
  // purpose — so a definition sitting here does not become a runnable agent.
  // These live here because engineering/agents is the destination
  // server/utils/promote.ts already targets when an agent is promoted to the
  // team, which makes it the sanctioned home for a team-official agent and
  // keeps this change out of the `.agents/` SSOT.
  //
  // To activate: promote them into the oh-my-agent estate. Until then the
  // steps naming them resolve to slugs with no agent behind them.
  'agents',
])
const known = new Set([...SHIPPED.map(([d]) => d), ...NOT_SHIPPED])
const unaccounted = readdirSync(join(root, 'engineering'), { withFileTypes: true })
  .filter(e => e.isDirectory() && !known.has(e.name))
  .map(e => e.name)
assert.deepEqual(unaccounted, [],
  `engineering/ grew a directory this test does not classify: ${unaccounted.join(', ')}. `
  + 'Add it to SHIPPED with a COPY line if the running app reads it, or to NOT_SHIPPED with the reason.')

console.log(`image ships engineering: ${SHIPPED.length} directories the app reads, ${NOT_SHIPPED.size} deliberately left out`)
