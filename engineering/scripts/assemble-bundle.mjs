#!/usr/bin/env node
/**
 * Evidence bundle assembler.
 *
 * Reads a "run directory" — a directory a CI job populated with the raw
 * artifacts from one agent-authored fix — and assembles it into a bundle
 * matching schemas/evidence-bundle.v0.1.schema.json. It never invents a
 * field: when an artifact is missing, the field it would have supplied is
 * left out of the bundle entirely, and Task 1's validator (validate-bundle.mjs)
 * is the thing that turns that absence into a rejection. A bundle that
 * "validates" only because a missing file was papered over with a plausible
 * value would defeat the entire point of the bundle.
 *
 * ── The run-directory contract ─────────────────────────────────────────────
 *
 * This is the contract between whatever CI job populates the directory and
 * this assembler. It is deliberately explicit — an undocumented contract
 * between a CI job and an assembler is a silent breakage waiting to happen.
 *
 * Required files:
 *
 *   meta.json
 *     Everything no other artifact can prove on its own: identity claims,
 *     labels, and declared test metadata. Shape:
 *       {
 *         "ticket": "SA-1203", "watch": "sa-bugs", "work_type": "bug",
 *         "class": "parsing" | null, "product": "ocs_cpp14",
 *         "blast_radius": "ui_parsing", "identity": "agent-sdlc-01",
 *         "model": "claude-sonnet-4-5", "plugin_version": "0.1.0",
 *         // watch: the id of the watch (registry/watches.yaml) that
 *         // dispatched this run. A run started directly, not by a watcher,
 *         // MUST set this to the reserved literal "direct-invocation" —
 *         // never null, never omitted. The schema keeps `watch` required
 *         // and typed as a non-nullable string on purpose: allowing null
 *         // would make "nothing triggered this" indistinguishable from "the
 *         // field was left out". Whatever populates meta.json must resolve
 *         // one of these two shapes; there is no third, honest option.
 *         //
 *         // plugin_version: must be the exact "version" field read from the
 *         // installed plugin's .claude-plugin/plugin.json (full semver,
 *         // e.g. "0.1.0" — the schema enforces the MAJOR.MINOR.PATCH
 *         // pattern). If that file cannot be located or parsed, the run
 *         // must halt rather than write a placeholder ("unknown", "n/a",
 *         // "TBD", ""): a placeholder that validates is worse than a bundle
 *         // that fails to assemble, because it looks like verified evidence.
 *         "stack": { "profile": "...", "topology": "...", "liquibase_tag": null },
 *         "oracle":       { "kind": "parameterised_test", "path": "tests/x.py", "runs": 3, "rows": 4 },
 *         "oracle_after": { "kind": "parameterised_test", "path": "tests/x.py", "runs": 3, "rows": 4 },
 *         "regression":   { "suite": "full" },
 *         "fix": {
 *           "repos": [ { "repo": "org/name", "commits": ["abcdef1"], "pr": "https://..." } ],
 *           "files_changed": 3, "lines_changed": 42,
 *           "test_dirs_unlocked": false, "unlock_reason": null
 *           // merge_order: array of repo names, required only when repos
 *           // has more than one entry (schema types it as array, not
 *           // nullable — for a single-repo fix, omit the key entirely).
 *         },
 *         "adversarial": null,
 *         "cost": { "input_tokens": 0, "output_tokens": 0, "attempts": 1, "wall_clock_min": 0 }
 *       }
 *     Note what meta.json does NOT supply: any test verdict, any hash. Those
 *     are computed from the other artifacts below, on purpose — a self-report
 *     of "it passed" is not evidence that it passed.
 *
 *   context-packet.json
 *     The context packet the agent actually worked from. Hashed (sha256,
 *     `sha256:<hex>`) into `context_packet_hash` — the provenance link from
 *     the bundle back to the exact context, not a self-reported string.
 *
 *   intent.md, plan.md
 *     The agent's stated intent and implementation plan. Each is hashed
 *     (first 12 hex chars of its sha256, matching the `minLength: 7` a git
 *     short sha would satisfy) into `intent_sha` / `plan_sha`. This is a
 *     content hash of the artifact actually produced, not a lookup into git
 *     history the assembler has no access to from a bare run directory.
 *
 *   summary.md
 *     The one-screen human summary, authored content (like intent.md /
 *     plan.md), read verbatim into `summary_md`. It is NOT generated here —
 *     that is scripts/bundle-summary.mjs's job (Task 3) for the posted check
 *     body. This assembler only carries forward what the run directory
 *     already contains, so assembly does not depend on that script.
 *
 *   oracle-before.xml, oracle-after.xml, regression.xml
 *     xunit (JUnit-style `<testsuite tests="" failures="" errors="" skipped="">`,
 *     optionally wrapped in `<testsuites>`) output. Hand-parsed with a
 *     regex — no XML library, no dependency — summing attributes across
 *     every `<testsuite>` element found. Failures + errors > 0 => FAIL,
 *     else PASS. (This assembler does not derive FLAKY: it consumes one
 *     representative xunit file per phase, not the N individual runs
 *     backing `oracle.runs` — a CI job that observes disagreement across
 *     its determinism runs should not hand this assembler a "done" run at
 *     all.) `oracle.kind` / `path` / `runs` / `rows` come from meta.json
 *     (declared test metadata); `verdict` comes only from parsing the xunit
 *     file, and is entirely ABSENT — not defaulted — if the file is missing.
 *     Same for `regression.passed` / `regression.failed`; `regression.suite`
 *     comes from meta.json.
 *
 * Optional files:
 *
 *   spec.md
 *     Present only when the watch declares `requires: [spec]`. Hashed the
 *     same way as intent.md/plan.md into `spec_sha` when present; `spec_sha`
 *     is `null` when absent (the schema allows null — this is honest
 *     "not required here", not a fabricated value).
 *
 *   trace.zip
 *     Playwright trace. If present, its filename is recorded in `trace`
 *     (relative to the run directory, not embedded); `trace` is `null` when
 *     absent — again a legitimate schema value, not a stand-in for missing
 *     evidence.
 *
 * Usage:
 *   node scripts/assemble-bundle.mjs --run-dir <dir> --out <bundle.json>
 *
 * Exit 0 if the assembled bundle validates, exit 1 (with problems printed)
 * otherwise. The bundle is written to --out either way, so an invalid
 * bundle can still be inspected — writing it is not the same as fabricating
 * it; every field it contains was actually backed by an artifact.
 *
 * Exports: assembleBundle(runDir): Promise<{ bundle, problems }>
 *
 * No dependencies: same reasoning as validate-bundle.mjs and
 * validate-registry.mjs — this is the trusted root of the pipeline.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateBundle } from './validate-bundle.mjs'

// ── Small file helpers — every one of these is the "did the evidence exist"
// boundary. Nothing downstream may substitute a default for a missing read. ─

function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readTextIfExists(path) {
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8')
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// context_packet_hash: full sha256, schema-mandated `sha256:<64 hex>` shape.
function contextPacketHash(text) {
  return `sha256:${sha256Hex(text)}`
}

// intent_sha / plan_sha / spec_sha: a short content hash, long enough to
// satisfy the schema's `minLength: 7` and to read like a git short sha,
// but explicitly a hash of the artifact's own content — see header comment.
function shortSha(text) {
  return sha256Hex(text).slice(0, 12)
}

/**
 * Hand-parsed xunit summary. Sums `tests` / `failures` / `errors` / `skipped`
 * across every `<testsuite>` element in the file (the `(?!s)` keeps a
 * `<testsuites>` wrapper tag itself out of the sum). Returns null if the
 * text contains no `<testsuite>` element at all — a file that exists but is
 * not xunit is treated the same as a file that does not exist.
 */
function parseXunit(xmlText) {
  const tags = xmlText.match(/<testsuite(?!s)\b[^>]*>/g)
  if (!tags || tags.length === 0) return null
  const numAttr = (tag, name) => {
    const m = tag.match(new RegExp(`\\b${name}="([0-9]+)"`))
    return m ? parseInt(m[1], 10) : 0
  }
  let tests = 0, failures = 0, errors = 0, skipped = 0
  for (const tag of tags) {
    tests += numAttr(tag, 'tests')
    failures += numAttr(tag, 'failures')
    errors += numAttr(tag, 'errors')
    skipped += numAttr(tag, 'skipped')
  }
  return { tests, failures, errors, skipped, passed: tests - failures - errors - skipped, failed: failures + errors }
}

// Set `obj[key]` only when `value` is not undefined. This is the mechanism
// that keeps absent evidence absent instead of turning into `undefined`
// silently vanishing (same effect via JSON.stringify) or, worse, some
// caller later adding a `?? someDefault`.
function setIfDefined(obj, key, value) {
  if (value !== undefined) obj[key] = value
}

/**
 * Build one `oracle_run` object (schema $defs/oracle_run) from meta.json's
 * declared metadata plus a parsed xunit result. `kind` / `path` / `runs` /
 * `rows` come from `metaOracle` (declared, not computed); `verdict` and
 * `xunit` come only from the parsed file and are omitted — not defaulted —
 * when the file is missing or unparsable. `metaOracle` itself may be
 * undefined (meta.json didn't declare this phase at all), in which case the
 * whole oracle_run is undefined and the caller omits the key entirely.
 */
function buildOracleRun(metaOracle, xunitText, xunitFilename) {
  if (metaOracle === undefined) return undefined
  const run = {}
  setIfDefined(run, 'kind', metaOracle.kind)
  setIfDefined(run, 'path', metaOracle.path)
  setIfDefined(run, 'runs', metaOracle.runs)
  setIfDefined(run, 'rows', metaOracle.rows ?? null)
  const parsed = xunitText === undefined ? null : parseXunit(xunitText)
  if (parsed) {
    run.verdict = parsed.failed > 0 ? 'FAIL' : 'PASS'
    run.xunit = xunitFilename
  }
  return run
}

/**
 * Assemble a bundle from a run directory. Never throws on missing evidence —
 * that is what `problems` (from Task 1's validateBundle) is for. Returns
 * `{ bundle, problems }`; `problems` empty means the bundle is valid
 * evidence.
 */
export async function assembleBundle(runDir) {
  const p = (name) => join(runDir, name)

  const meta = readJsonIfExists(p('meta.json')) ?? {}

  const contextPacketText = readTextIfExists(p('context-packet.json'))
  const intentText = readTextIfExists(p('intent.md'))
  const planText = readTextIfExists(p('plan.md'))
  const specText = readTextIfExists(p('spec.md'))
  const summaryText = readTextIfExists(p('summary.md'))

  const oracleBeforeText = readTextIfExists(p('oracle-before.xml'))
  const oracleAfterText = readTextIfExists(p('oracle-after.xml'))
  const regressionText = readTextIfExists(p('regression.xml'))

  const hasTrace = existsSync(p('trace.zip'))

  const bundle = {}

  setIfDefined(bundle, 'ticket', meta.ticket)
  setIfDefined(bundle, 'watch', meta.watch)
  setIfDefined(bundle, 'work_type', meta.work_type)
  setIfDefined(bundle, 'class', 'class' in meta ? meta.class : undefined)
  setIfDefined(bundle, 'product', meta.product)
  setIfDefined(bundle, 'blast_radius', meta.blast_radius)
  setIfDefined(bundle, 'identity', meta.identity)

  setIfDefined(bundle, 'context_packet_hash', contextPacketText === undefined ? undefined : contextPacketHash(contextPacketText))
  setIfDefined(bundle, 'intent_sha', intentText === undefined ? undefined : shortSha(intentText))
  setIfDefined(bundle, 'spec_sha', specText === undefined ? null : shortSha(specText))
  setIfDefined(bundle, 'plan_sha', planText === undefined ? undefined : shortSha(planText))

  setIfDefined(bundle, 'model', meta.model)
  setIfDefined(bundle, 'plugin_version', meta.plugin_version)
  setIfDefined(bundle, 'stack', meta.stack)

  setIfDefined(bundle, 'oracle', buildOracleRun(meta.oracle, oracleBeforeText, 'oracle-before.xml'))

  setIfDefined(bundle, 'fix', meta.fix)

  setIfDefined(bundle, 'oracle_after', buildOracleRun(meta.oracle_after, oracleAfterText, 'oracle-after.xml'))

  if (meta.regression !== undefined) {
    const regression = {}
    setIfDefined(regression, 'suite', meta.regression.suite)
    const parsed = regressionText === undefined ? null : parseXunit(regressionText)
    if (parsed) {
      regression.passed = parsed.passed
      regression.failed = parsed.failed
      regression.xunit = 'regression.xml'
    }
    bundle.regression = regression
  }

  bundle.trace = hasTrace ? 'trace.zip' : null
  bundle.adversarial = 'adversarial' in meta ? meta.adversarial : null

  setIfDefined(bundle, 'cost', meta.cost)
  setIfDefined(bundle, 'summary_md', summaryText)

  const problems = validateBundle(bundle)
  return { bundle, problems }
}

// ── CLI ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { runDir: undefined, out: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run-dir') args.runDir = argv[++i]
    else if (argv[i] === '--out') args.out = argv[++i]
  }
  return args
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const { runDir, out } = parseArgs(process.argv.slice(2))
  if (!runDir || !out) {
    console.error('usage: node scripts/assemble-bundle.mjs --run-dir <dir> --out <bundle.json>')
    process.exit(1)
  }
  const { bundle, problems } = await assembleBundle(resolve(runDir))
  writeFileSync(resolve(out), JSON.stringify(bundle, null, 2) + '\n')
  if (problems.length) {
    console.error(`\n✗ assembled bundle is missing evidence — ${problems.length} problem(s):\n`)
    for (const prob of problems) console.error(`  ✗ ${prob}`)
    console.error(`\nWritten to ${out} for inspection. Missing evidence fails the PR.\n`)
    process.exit(1)
  }
  console.log(`\n✓ assembled a valid evidence bundle — ${bundle.ticket ?? '(no ticket)'} → ${out}\n`)
  process.exit(0)
}
