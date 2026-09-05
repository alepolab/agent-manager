#!/usr/bin/env node
/**
 * Environment-profile registry check (V3).
 *
 * Validates registry/environments.yaml against its schema, then applies the
 * cross-entry rules a JSON schema cannot express. A broken entry must fail
 * here — loudly, in CI or by hand — rather than resolve-environment.mjs
 * silently guessing or defaulting a fact for a real pipeline step later.
 *
 *   node scripts/validate-environments.mjs
 *
 * Exit 0 = every environment entry is well-formed and unambiguous to detect.
 * Exit 1 = at least one is not.
 *
 * No dependencies: registry/lib/yaml.mjs is the same hand-written,
 * dependency-free reader validate-registry.mjs uses for products.yaml — a
 * sibling copy, not a shared import from that file, per this task's own
 * instruction to add a sibling validator rather than touch the existing one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseYaml, validateSchema } from '../registry/lib/yaml.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const problems = []

let doc
try {
  doc = parseYaml(read('registry/environments.yaml'))
} catch (e) {
  console.error(`\n✗ environments check failed — ${e.message}\n`)
  process.exit(1)
}

const schema = JSON.parse(read('registry/schemas/environments.schema.json'))
validateSchema(doc, schema, 'environments.yaml', problems)

const environments = doc.environments ?? {}

// ── Semantic rules a schema cannot express ────────────────────────────────

// A lab/remote host can never be auto-detected from the local machine's own
// /etc/os-release or WSL state — declaring `detect` on one would make
// resolve-environment.mjs silently guess a remote host from local facts,
// exactly the "confident nonsense" this registry exists to prevent.
for (const [id, env] of Object.entries(environments)) {
  if (env.kind !== 'workstation' && env.detect) {
    problems.push(`environments.${id}: kind "${env.kind}" must not declare "detect" — ` +
      `a remote/lab host cannot be inferred from this machine's own os-release or WSL state`)
  }
}

// Two environments with the identical detect fingerprint would make
// auto-detection ambiguous — resolve-environment.mjs would have to guess
// which one applies, which is exactly the failure mode this file exists to
// rule out.
const seenDetect = new Map()
for (const [id, env] of Object.entries(environments)) {
  if (!env.detect) continue
  const key = `${env.detect.os_release_id}::${env.detect.wsl}`
  if (seenDetect.has(key)) {
    problems.push(`environments.${id}: detect fingerprint (os_release_id=${env.detect.os_release_id}, wsl=${env.detect.wsl}) ` +
      `is identical to environments.${seenDetect.get(key)} — auto-detection could not tell them apart`)
  } else {
    seenDetect.set(key, id)
  }
}

// A workstation kind should be detectable somehow, or it can only ever be
// reached via --env — legitimate, but worth a note so it isn't an oversight.
for (const [id, env] of Object.entries(environments)) {
  if (env.kind === 'workstation' && !env.detect) {
    console.log(`  note  environments.${id}: no detect block — only reachable via --env, never auto-detected`)
  }
}

// ── Report ────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`\n✗ environments check failed — ${problems.length} problem(s):\n`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error('\nA broken environment entry is not resolvable. Fix the entry, not resolve-environment.mjs.\n')
  process.exit(1)
}
console.log(`\n✓ environments check passed — ${Object.keys(environments).length} environment(s)\n`)
