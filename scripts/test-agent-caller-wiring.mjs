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

// CE_SKILLS_DIR and ceSkillsDir() are gone. They resolved the
// compound-engineering skills for Runbook C's Plan/Implement/Review/Push steps;
// that runbook and the sdlc-* agents that ran it were removed with this app's
// estate, so nothing reads those skills and the resolver had no callers left.

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

// ── 4. subtype:'success' with is_error:true must throw, not return output ──
// SDKResultSuccess (sdk.d.ts) carries `is_error`, and a live probe against a
// bad model id returned exactly `{ subtype: 'success', is_error: true }` -
// a result whose `.result` text is an error description, not agent output.
// is_error:true cannot be provoked on demand from a live call, so this drives
// interpretResultMessage(), the seam callAgent()'s loop calls per message,
// with a synthetic message of that exact shape.
const { interpretResultMessage } = await import('../server/utils/agentCaller.ts')
assert.throws(
  () => interpretResultMessage({
    subtype: 'success', is_error: true, result: 'looks like output but is not',
    errors: ['model not found'],
  }),
  /is_error/,
  'subtype: success with is_error: true must throw, not be treated as a successful turn',
)
assert.throws(
  () => interpretResultMessage({ subtype: 'error_during_execution', errors: ['boom'] }),
  /error_during_execution/,
  'a genuine SDKResultError still throws, naming its subtype',
)
const ok = interpretResultMessage({ subtype: 'success', is_error: false, result: 'real output', usage: undefined })
assert.equal(ok.output, 'real output', 'subtype: success with is_error: false still returns the real output')

console.log('OK: the real agent caller (server/utils/agentCaller.ts#callAgent) is wired')
// ── an API failure keeps its reason ──────────────────────────────────────────
// The SDK surfaces an API error as assistant text and then ends the call with
// `subtype: 'success', is_error: true` and an EMPTY errors array. A real run
// died on "API Error: Request rejected (429) ... Quota resets in 3145s" and the
// run record said "no further detail" — indistinguishable from a crash, and it
// sent the reader to the logs to learn they only had to wait.
{
  const { interpretResultMessage } = await import('../server/utils/agentCaller.ts')
  const result = { subtype: 'success', is_error: true, errors: [] }
  const apiError = 'API Error: Request rejected (429) · all 2 accounts are at their quota or rate limit. Quota resets in 3145s.'

  let threw
  try { interpretResultMessage(result, undefined, apiError) } catch (e) { threw = e }
  assert.ok(threw, 'an is_error result must throw')
  assert.match(threw.message, /429/, `the reason must reach the run record: ${threw.message}`)
  assert.match(threw.message, /Quota resets/, 'including when it will work again')
  assert.doesNotMatch(threw.message, /no further detail/)

  // Without one, the honest fallback stands.
  let bare
  try { interpretResultMessage(result, undefined, undefined) } catch (e) { bare = e }
  assert.match(bare.message, /no further detail/, 'nothing is invented when the stream carried no reason')

  // A real error list still wins: it is the SDK's own account of the failure.
  let listed
  try { interpretResultMessage({ subtype: 'error_during_execution', is_error: true, errors: ['tool crashed'] }, undefined, apiError) } catch (e) { listed = e }
  assert.match(listed.message, /tool crashed/)
  assert.doesNotMatch(listed.message, /429/)
}

console.log('    into workflowRunner.ts at module-load time, with no import-order dependency.')
