/**
 * Regression check for the "no agent caller configured" defect.
 *
 * server/utils/workflowRunner.ts used to default its module-scope
 * `agentCaller` to a throwing stub, and relied on server/utils/agentCaller.ts
 * being imported *purely for its side effect* (`import '../../../utils/agentCaller'`,
 * no bound names) somewhere on the request path, which called
 * `setAgentCaller(callAgent)` to overwrite the stub. That import was silently
 * dropped by Nitro's dev bundler (confirmed by grepping the built
 * `.nuxt/dev/index.mjs`: agentCaller.ts's code was entirely absent), so the
 * stub is what every real run hit, instantly, in production.
 *
 * scripts/test-workflow-runner.mjs cannot catch this class of bug: it calls
 * `runner.setAgentCaller(stub)` directly and never imports the real
 * server/utils/agentCaller.ts at all, so a broken wiring path is invisible
 * to it. This script imports workflowRunner.ts exactly the way the real API
 * routes do (an extensionless relative import, no side-effect import of
 * agentCaller.ts) and asserts the module-scope caller is already the real
 * one BEFORE any test calls setAgentCaller() to override it.
 *
 * This does not make a live SDK call: it only checks object identity of the
 * exported function references.
 *
 *   node scripts/test-agent-caller-wiring.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'agent-caller-wiring-'))

// Import exactly as server/api/workflows/[slug]/runs.post.ts does: relative,
// no extension, no separate side-effect import of agentCaller.ts.
const runner = await import('../server/utils/workflowRunner.ts')
const { callAgent } = await import('../server/utils/agentCaller.ts')

// ── 1. Importing workflowRunner.ts alone wires the real caller ────────────
// No setAgentCaller() call has happened yet in this process. If the wiring
// regresses to an import-order-dependent side effect that isn't triggered by
// this import path, this fails exactly the way the real bug did.
assert.equal(
  runner.isRealAgentCallerActive(), true,
  'workflowRunner.ts must import and use the real agent caller directly at ' +
  'module scope, not depend on some other module being imported first for ' +
  'its side effect',
)

// ── 2. The wired caller is REFERENTIALLY the function agentCaller.ts exports ──
// Guards against a bundler/module-resolution split (e.g. an extensionless vs.
// `.ts`-suffixed import of the same file resolving to two distinct module
// instances) producing a caller that merely looks right but is a different
// function object - which is exactly the shape "two module instances" bugs
// take.
assert.equal(
  runner.getAgentCaller(), callAgent,
  'the caller executeNode() will invoke must be the exact function ' +
  'server/utils/agentCaller.ts exports, not a look-alike from a second ' +
  'module instance',
)

// ── 3. setAgentCaller still lets tests substitute a stub ───────────────────
runner.setAgentCaller(async () => 'stub')
assert.equal(runner.isRealAgentCallerActive(), false, 'overriding the caller must flip the flag')

console.log('OK: the real agent caller (server/utils/agentCaller.ts#callAgent) is wired')
console.log('    into workflowRunner.ts at module-load time, with no import-order dependency.')
