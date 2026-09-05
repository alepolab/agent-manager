/**
 * Self-check for the leveled, namespaced logger (server/utils/log.ts).
 *
 * Covers exactly what the task that introduced this file asked for:
 *   - the default level suppresses debug output
 *   - enabling debug produces it
 *   - namespace filtering (DEBUG=...) works
 *   - a secret-shaped value passed to the logger is never emitted verbatim,
 *     proven against the REAL call site (jiraCredentials.ts's
 *     resolveJiraCredentials), not just the redaction helper in isolation —
 *     so it fails if someone later logs a token there.
 *
 *   node scripts/test-log.mjs
 */
import assert from 'node:assert/strict'

const log = await import('../server/utils/log.ts')

/** Captures everything written to console.log/warn/error during `fn()` and
 *  restores the originals afterward, even if `fn` throws. */
async function captureConsole(fn) {
  const calls = { log: [], warn: [], error: [] }
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args) => calls.log.push(args.join(' '))
  console.warn = (...args) => calls.warn.push(args.join(' '))
  console.error = (...args) => calls.error.push(args.join(' '))
  try {
    await fn()
  } finally {
    Object.assign(console, orig)
  }
  return calls
}

function resetEnv() {
  delete process.env.LOG_LEVEL
  delete process.env.DEBUG
}

// ── 1. Default level suppresses debug (and info) output ───────────────────
{
  resetEnv()
  const runner = log.createLogger('runner')
  const calls = await captureConsole(() => {
    runner.debug('debug message must not appear by default')
    runner.info('info message must not appear by default either')
  })
  assert.equal(calls.log.length, 0,
    'debug/info output must be fully suppressed at the default LOG_LEVEL — ' +
    `got: ${JSON.stringify(calls.log)}`)
}

// ── warn/error still show at the default level (matches today's one console.error) ──
{
  resetEnv()
  const runner = log.createLogger('runner')
  const calls = await captureConsole(() => {
    runner.warn('a warning')
    runner.error('an error')
  })
  assert.equal(calls.warn.length, 1, 'warn must still print at the default level')
  assert.equal(calls.error.length, 1, 'error must still print at the default level')
}

// ── 2. Enabling debug produces it ──────────────────────────────────────────
{
  resetEnv()
  process.env.LOG_LEVEL = 'debug'
  const runner = log.createLogger('runner')
  const calls = await captureConsole(() => {
    runner.debug('now this should appear')
  })
  assert.equal(calls.log.length, 1, 'LOG_LEVEL=debug must let a debug() call through')
  assert.match(calls.log[0], /now this should appear/)
  assert.match(calls.log[0], /\[runner]/, 'the namespace must be visible in the rendered line')
}

// ── 3. Namespace filtering (DEBUG=...) ─────────────────────────────────────
{
  resetEnv()
  process.env.LOG_LEVEL = 'debug'
  process.env.DEBUG = 'runner'
  const runner = log.createLogger('runner')
  const agent = log.createLogger('agent')
  const calls = await captureConsole(() => {
    runner.debug('runner debug — namespace matches DEBUG')
    agent.debug('agent debug — namespace does NOT match DEBUG')
  })
  assert.equal(calls.log.length, 1, 'only the namespace listed in DEBUG should emit')
  assert.match(calls.log[0], /runner debug/)

  process.env.DEBUG = 'agent'
  const calls2 = await captureConsole(() => {
    runner.debug('runner debug again')
    agent.debug('agent debug again')
  })
  assert.equal(calls2.log.length, 1, 'flipping DEBUG must flip which namespace emits')
  assert.match(calls2.log[0], /agent debug again/)

  process.env.DEBUG = '*'
  const calls3 = await captureConsole(() => {
    runner.debug('runner debug, star')
    agent.debug('agent debug, star')
  })
  assert.equal(calls3.log.length, 2, "DEBUG='*' must enable every namespace")
}

// ── 4a. The logger itself redacts secret-shaped meta keys (defense-in-depth) ──
{
  resetEnv()
  process.env.LOG_LEVEL = 'debug'
  process.env.DEBUG = '*'
  const jira = log.createLogger('jira')
  const RAW_SECRET = 'sk-super-secret-token-value-should-never-appear'
  const calls = await captureConsole(() => {
    jira.debug('a call site that (wrongly) passed a raw secret', { apiToken: RAW_SECRET, ok: 'fine' })
  })
  const rendered = calls.log.join('\n')
  assert.ok(!rendered.includes(RAW_SECRET),
    'a secret-shaped meta key must never render its raw value')
  assert.match(rendered, /redacted/, 'a redacted secret should say so, not just vanish')
  assert.match(rendered, /ok=fine/, 'non-secret-shaped fields still render normally')
}

// ── 4b. The REAL call site (jiraCredentials.ts) never emits the raw token/email ──
// This is the one that actually fails if someone later logs a token: it does
// not call log.debug directly with a secret key name (that's test 4a) — it
// drives the production code path and inspects what came out.
{
  resetEnv()
  process.env.LOG_LEVEL = 'debug'
  process.env.DEBUG = '*'
  const RAW_TOKEN = 'jira-api-token-abc123-should-not-leak'
  const RAW_EMAIL = 'ashwani.singh@alepo.com'
  process.env.JIRA_BASE_URL = 'https://alepo.atlassian.net'
  process.env.JIRA_EMAIL = RAW_EMAIL
  process.env.JIRA_API_TOKEN = RAW_TOKEN

  const jiraCreds = await import('../server/utils/jiraCredentials.ts')
  const calls = await captureConsole(() => {
    const creds = jiraCreds.resolveJiraCredentials()
    assert.equal(creds.apiToken, RAW_TOKEN, 'the resolved credential itself must still be the real token')
  })
  const rendered = [...calls.log, ...calls.warn, ...calls.error].join('\n')
  assert.ok(!rendered.includes(RAW_TOKEN), 'the raw JIRA_API_TOKEN value must never appear in log output')
  assert.ok(!rendered.includes(RAW_EMAIL), 'the raw JIRA_EMAIL value must never appear in log output')

  delete process.env.JIRA_BASE_URL
  delete process.env.JIRA_EMAIL
  delete process.env.JIRA_API_TOKEN
}

resetEnv()
console.log('OK: default level quiet, debug/namespace filtering works, secrets never rendered.')
