#!/usr/bin/env node
/**
 * "Which environment am I in, and what is true here?" (V3)
 *
 * A pipeline step (or an agent) calls this instead of guessing: instead of
 * assuming apt exists, or that a container is reachable on the host's own IP,
 * it asks. Two ways to answer:
 *
 *   node scripts/resolve-environment.mjs                    # auto-detect this machine
 *   node scripts/resolve-environment.mjs --env lab-ffmhost1 # name it explicitly (required for
 *                                                            # any environment with no `detect`
 *                                                            # block — a remote host can never
 *                                                            # be auto-detected from here)
 *   node scripts/resolve-environment.mjs --fact ssh_unit     # print one fact, or fail loudly
 *   node scripts/resolve-environment.mjs --json              # machine-readable, for a script step
 *
 * The rule this script exists to enforce: a fact that cannot be determined
 * is ABSENT and LOUD, never defaulted from another environment or guessed.
 * Asking for a fact the resolved environment doesn't declare is exit 1 with
 * a specific message — never silently falls back to some other value. This
 * is the same posture the evidence bundle takes on a missing artifact
 * (engineering/docs/evidence-bundle.md: "a missing artifact means the field
 * is left out, not defaulted").
 *
 * No dependencies: registry/lib/yaml.mjs is the same hand-written reader
 * validate-environments.mjs uses.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseYaml } from '../registry/lib/yaml.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { env: null, fact: null, json: false, osReleasePath: '/etc/os-release', wsl: null, procVersionPath: '/proc/version' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env') args.env = argv[++i]
    else if (a === '--fact') args.fact = argv[++i]
    else if (a === '--json') args.json = true
    // Test/CI overrides: let a case inject the detection inputs instead of
    // reading the real machine, so auto-detect is provable without a real
    // Ubuntu/OracleLinux/WSL host to run on.
    else if (a === '--os-release') args.osReleasePath = argv[++i]
    else if (a === '--proc-version') args.procVersionPath = argv[++i]
    else if (a === '--wsl') args.wsl = argv[++i] === 'true'
    else if (a === '--registry') args.registryPath = argv[++i]
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

function loadRegistry(registryPath) {
  const path = registryPath ?? join(root, 'registry/environments.yaml')
  const doc = parseYaml(readFileSync(path, 'utf8'))
  return doc.environments ?? {}
}

/** Read ID= out of an /etc/os-release-shaped file. Absent file -> null, loud upstream. */
function readOsReleaseId(path) {
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  const m = text.match(/^ID=(.*)$/m)
  if (!m) return null
  return m[1].trim().replace(/^"|"$/g, '')
}

/** WSL indicator: explicit override wins; otherwise the two real signals. */
function detectWsl(args) {
  if (args.wsl !== null) return args.wsl
  if (process.env.WSL_DISTRO_NAME) return true
  if (existsSync(args.procVersionPath)) {
    try {
      const text = readFileSync(args.procVersionPath, 'utf8')
      if (/microsoft|wsl/i.test(text)) return true
    } catch { /* fall through to false */ }
  }
  return false
}

function autoDetect(environments, args) {
  const osReleaseId = readOsReleaseId(args.osReleasePath)
  const wsl = detectWsl(args)

  if (osReleaseId === null) {
    return { error: `cannot auto-detect: ${args.osReleasePath} was not found or has no ID= line. ` +
      `Pass --env explicitly instead of guessing.` }
  }

  const matches = Object.entries(environments).filter(([, env]) =>
    env.detect && env.detect.os_release_id === osReleaseId && env.detect.wsl === wsl)

  if (matches.length === 0) {
    return { error: `no registered environment matches os_release_id="${osReleaseId}" wsl=${wsl}. ` +
      `Known detectable environments: ${Object.entries(environments).filter(([, e]) => e.detect).map(([id]) => id).join(', ') || '(none)'}. ` +
      `Pass --env explicitly, or add an entry to registry/environments.yaml — do not default to one.` }
  }
  if (matches.length > 1) {
    // The validator should already reject duplicate detect fingerprints; this
    // is a defensive last line, not the primary control.
    return { error: `ambiguous: os_release_id="${osReleaseId}" wsl=${wsl} matches more than one environment ` +
      `(${matches.map(([id]) => id).join(', ')}). Fix registry/environments.yaml.` }
  }
  return { id: matches[0][0], env: matches[0][1] }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('Usage: resolve-environment.mjs [--env <id>] [--fact <name>] [--json] [--os-release <path>] [--wsl <true|false>]')
    process.exit(0)
  }

  let environments
  try {
    environments = loadRegistry(args.registryPath)
  } catch (e) {
    console.error(`Could not load registry/environments.yaml: ${e.message}`)
    process.exit(1)
  }

  let resolved
  if (args.env) {
    if (!Object.hasOwn(environments, args.env)) {
      console.error(`environment "${args.env}" is not registered. Known: ${Object.keys(environments).join(', ')}.`)
      process.exit(1)
    }
    resolved = { id: args.env, env: environments[args.env] }
  } else {
    const r = autoDetect(environments, args)
    if (r.error) {
      console.error(r.error)
      process.exit(1)
    }
    resolved = r
  }

  const { id, env } = resolved

  if (args.fact) {
    if (!Object.hasOwn(env.facts ?? {}, args.fact)) {
      console.error(`unknown: "${args.fact}" is not stated for ${id}. ` +
        `Stated facts for ${id}: ${Object.keys(env.facts ?? {}).join(', ') || '(none)'}. ` +
        `Absent means not determined for this environment — it is not another environment's value.`)
      process.exit(1)
    }
    const value = env.facts[args.fact]
    if (args.json) console.log(JSON.stringify({ environment: id, fact: args.fact, value }))
    else console.log(String(value))
    process.exit(0)
  }

  if (args.json) {
    console.log(JSON.stringify({ environment: id, kind: env.kind, description: env.description ?? null, facts: env.facts ?? {} }, null, 2))
  } else {
    console.log(`environment: ${id}`)
    console.log(`kind: ${env.kind}`)
    if (env.description) console.log(`description: ${env.description}`)
    console.log('facts:')
    for (const [k, v] of Object.entries(env.facts ?? {})) console.log(`  ${k}: ${v}`)
  }
  process.exit(0)
}

main()
