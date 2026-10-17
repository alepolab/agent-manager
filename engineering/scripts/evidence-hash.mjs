#!/usr/bin/env node
/**
 * The evidence bundle's own digest (v0.2 `manifest_sha256`).
 *
 * `manifest_sha256` is the sha256 of the bundle's canonical JSON — keys sorted
 * at every depth, no whitespace, `undefined` dropped — with the
 * `manifest_sha256` field itself left out. Canonical, so the digest does not
 * depend on the order the assembler happened to write keys in; excluding the
 * field, so it can be stamped onto the bundle it describes. A bundle edited
 * after assembly, by so much as one character of `summary_md`, no longer
 * matches its own digest, which is what lets a reviewer trust that the bundle
 * quoted in a PR body is the one the assembler produced.
 *
 * The same canonical form as server/utils/auditLog.ts's canonicalJson, kept
 * separate because engineering/scripts is dependency-free and must not import
 * from the app.
 *
 *   node scripts/evidence-hash.mjs <bundle.json>            prints the digest
 *   node scripts/evidence-hash.mjs --stamp <bundle.json>    writes manifest_sha256 into the file
 *   node scripts/evidence-hash.mjs --verify <bundle.json>   exit 0 when the stamped digest matches, 1 otherwise
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANIFEST_FIELD = 'manifest_sha256'

/** Canonical JSON: sorted keys at every depth, no whitespace, undefined dropped. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v === undefined ? null : v)).join(',')}]`
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}

/** The digest a bundle should carry: over everything except the digest field. */
export function manifestSha256(bundle) {
  const { [MANIFEST_FIELD]: _omitted, ...rest } = bundle
  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex')
}

/** A copy of the bundle with its digest stamped on. */
export function stampManifest(bundle) {
  return { ...bundle, [MANIFEST_FIELD]: manifestSha256(bundle) }
}

/**
 * Does the bundle match its own digest? `{ ok, expected, actual }` — `actual`
 * is undefined when the bundle carries no digest at all, which is a failure
 * too: an unstamped bundle is not one whose integrity can be shown.
 */
export function verifyManifest(bundle) {
  const expected = manifestSha256(bundle)
  const actual = bundle?.[MANIFEST_FIELD]
  return { ok: typeof actual === 'string' && actual === expected, expected, actual }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const args = process.argv.slice(2)
  const mode = args[0]?.startsWith('--') ? args.shift().slice(2) : 'print'
  const file = args[0]
  if (!file || !['print', 'stamp', 'verify'].includes(mode)) {
    console.error('usage: node scripts/evidence-hash.mjs [--stamp|--verify] <bundle.json>')
    process.exit(2)
  }
  let bundle
  try {
    bundle = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`could not read/parse ${file}: ${e.message}`)
    process.exit(2)
  }
  if (mode === 'print') {
    console.log(manifestSha256(bundle))
  } else if (mode === 'stamp') {
    writeFileSync(resolve(file), `${JSON.stringify(stampManifest(bundle), null, 2)}\n`)
    console.log(`stamped ${MANIFEST_FIELD}=${manifestSha256(bundle)} into ${file}`)
  } else {
    const v = verifyManifest(bundle)
    if (v.ok) {
      console.log(`✓ ${file} matches its ${MANIFEST_FIELD}`)
    } else {
      console.error(`✗ ${file}: ${MANIFEST_FIELD} is ${v.actual ?? 'absent'}, content hashes to ${v.expected}`)
      process.exit(1)
    }
  }
}
