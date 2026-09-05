/**
 * No server handler may call this app's own HTTP API.
 *
 *   node scripts/test-no-server-loopback.mjs
 *
 * The bug this pins: server/api/workflows/[slug]/runs.post.ts fetched the
 * workflow from `/api/workflows/${slug}`. A server-to-self $fetch carries no
 * cookies, so server/middleware/auth.ts answered 401 "Sign in required" to the
 * server itself and every run start in team mode died on an unhandled
 * FetchError.
 *
 * Standalone mode could never catch it: AUTH_DISABLED makes the middleware a
 * no-op, so the loopback succeeds there. The first time auth is real is the
 * first time this breaks — which is how it reached a deployed team instance.
 *
 * Four more were hiding in the projects routes, and those were worse: both
 * wrapped the loopback in try/catch with a `name.replace(/-/g, '/')` fallback,
 * so the 401 produced no error at all — just a file tree and a git panel
 * pointed at the wrong directory.
 *
 * Anything a handler needs from another route, it should read through the
 * shared util that route uses. This test fails the build if a new one appears.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', 'server')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

const files = walk(ROOT)
assert.ok(files.length > 20, `expected to scan the server tree, found ${files.length} files`)

// Comments describe the defect on purpose — several of the fixed sites say so.
// Only executable lines count.
const stripped = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter(l => !l.trim().startsWith('//'))
  .join('\n')

const offenders = []
for (const file of files) {
  const src = stripped(readFileSync(file, 'utf8'))
  // $fetch('/api/...'), $fetch(`/api/...`), and the typed forms in between.
  const re = /\$fetch\s*(?:<[^>]*>)?\s*\(\s*[`'"]\/api\//g
  let m
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length
    offenders.push(`${file.replace(ROOT, 'server')}:${line}`)
  }
}

assert.deepEqual(
  offenders, [],
  'server handlers must not call this app\'s own HTTP API — the auth middleware '
  + 'rejects a cookie-less server-to-self request with 401. Read through the '
  + 'shared util instead (see server/utils/projects.ts, server/utils/workflows.ts). '
  + 'Offending sites: ' + offenders.join(', '),
)

console.log(`no-server-loopback: ${files.length} server files scanned, no loopback $fetch`)
