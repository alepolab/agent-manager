#!/usr/bin/env node
/**
 * A run finished green, opened PR #202, and buried this in the evidence step's
 * output: "Schema validation by the assembler was not possible because the
 * assembler is absent from this installation."
 *
 * It was not absent. `engineering/scripts/assemble-bundle.mjs` ships in the
 * image at /app/engineering/scripts. The instructions named it by a path
 * relative to the app, and the agent runs in the product checkout, where
 * `engineering/` does not exist — so the command failed to resolve and the
 * agent read that as "this install has no assembler" and carried on.
 *
 * Two things have to hold, and both are load-bearing:
 *   1. the path handed to the agent is absolute, and reaches it on EVERY code
 *      path, including the one with no credentials configured
 *   2. a command that cannot be found is treated as a failure, not a licence
 *      to skip validation and open the PR anyway
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')
let failures = 0
const check = (name, ok, why) => {
  if (ok) return console.log(`  ok   ${name}`)
  failures++
  console.error(`  FAIL ${name}\n       ${why}`)
}

const caller = read('server/utils/agentCaller.ts')
const templates = read('app/utils/templates.ts')

check('agentCaller exports an absolute scripts dir',
  /export function sdlcScriptsDir\(\)/.test(caller)
  && /join\(process\.cwd\(\), 'engineering', 'scripts'\)/.test(caller),
  'sdlcScriptsDir() must resolve against process.cwd(), so it is absolute in the container (/app) and in a dev checkout alike')

check('SDLC_SCRIPTS_DIR is handed to the agent',
  /SDLC_SCRIPTS_DIR: sdlcScriptsDir\(\)/.test(caller),
  'the agent cannot use a variable the query() env never sets')

// The regression that motivated making it unconditional: env used to be spread
// only when AGENT_GH_TOKEN or a user profile existed. A no-credential install
// would then run agents with no SDLC_SCRIPTS_DIR at all — the same silent gap
// in a different configuration.
const envBlock = caller.slice(caller.indexOf('for await (const message of query('))
check('the env is passed unconditionally',
  /\n      env: \{/.test(envBlock)
  && !/\? \{ env: \{/.test(envBlock),
  'env must not be conditionally spread; SDLC_SCRIPTS_DIR has to reach the agent even with no token and no user profile')

check('the evidence template uses the absolute path',
  templates.includes('node "$SDLC_SCRIPTS_DIR/assemble-bundle.mjs"'),
  'the template must not name the assembler by a path relative to the app')

check('no relative engineering/ path survives in the templates',
  !/node engineering\/scripts\//.test(templates),
  'a relative engineering/ path in an agent prompt resolves against the product checkout, where it does not exist')

check('a missing assembler is a finding, not a skip',
  /same failure as a non-zero exit/.test(templates)
  && /absent from the installation|missing from the installation/.test(templates),
  'the template covered a non-zero exit but not "command not found"; the agent took the lenient reading and opened the PR with an unvalidated bundle')

// The assembler must actually be where sdlcScriptsDir() says it is, or the
// whole fix is a nicer-looking version of the same failure.
check('the assembler is at the path we advertise',
  (() => { try { readFileSync(join(root, 'engineering', 'scripts', 'assemble-bundle.mjs')); return true } catch { return false } })(),
  'engineering/scripts/assemble-bundle.mjs must exist at the repo root for sdlcScriptsDir() to be true')

console.log(failures === 0 ? '\nassembler reachability: all checks passed' : `\nassembler reachability: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
