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
const { callAgent, ceSkillsDir } = await import('../server/utils/agentCaller.ts')

// CE_SKILLS_DIR: the compound-engineering plugin's skills, or empty — never a guess.
{
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  assert.equal(await ceSkillsDir(), '', 'no installed_plugins.json means no plugin, and an empty value the ce steps halt on')
  mkdirSync(join(process.env.CLAUDE_DIR, 'plugins'), { recursive: true })
  const installed = join(process.env.CLAUDE_DIR, 'plugins', 'installed_plugins.json')
  writeFileSync(installed, JSON.stringify({ plugins: { 'superpowers@x': [{ installPath: '/p/super' }], 'compound-engineering@compound-engineering-plugin': [{ installPath: '/p/ce/3.21.1' }] } }))
  assert.equal(await ceSkillsDir(), '/p/ce/3.21.1/skills', 'the compound-engineering entry, whichever marketplace it came from')
  writeFileSync(installed, '{ not json')
  assert.equal(await ceSkillsDir(), '', 'a broken registry reads as no plugin')
  rmSync(installed)

  // The copy the image ships (Dockerfile: /app/vendor/compound-engineering) is
  // the fallback, so a container needs no plugin installed in its config
  // directory. It only counts when ce-plan is actually in it — an empty
  // directory is still "not installed", not a path the ce steps would halt in.
  const shipped = mkdtempSync(join(tmpdir(), 'ce-shipped-'))
  assert.equal(await ceSkillsDir(shipped), '', 'a shipped directory without ce-plan is no fallback')
  mkdirSync(join(shipped, 'ce-plan'), { recursive: true })
  writeFileSync(join(shipped, 'ce-plan', 'SKILL.md'), '# ce-plan')
  assert.equal(await ceSkillsDir(shipped), shipped, 'with no plugin installed, the shipped copy is the answer')
  writeFileSync(installed, JSON.stringify({ plugins: { 'compound-engineering@compound-engineering-plugin': [{ installPath: '/p/ce/3.21.1' }] } }))
  assert.equal(await ceSkillsDir(shipped), '/p/ce/3.21.1/skills', 'an installed plugin still wins over the shipped copy')
  rmSync(installed)
  rmSync(shipped, { recursive: true, force: true })
}

// ALEPO_SKILLS_DIR: developer-workflow's skills, from an installed plugin, the
// `alepo` marketplace clone or the copy the repository vendors - each only when
// it really holds review/SKILL.md - or empty. The clone alone is enough, so
// alepo-core's hooks need not be installed for the Alepo Review step to find its
// skill; the vendored copy is what a container has, where the registry names
// the host's installPath and the clone was stripped from the staged config.
{
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { alepoSkillsDir } = await import('../server/utils/agentCaller.ts')
  const marketplace = join(process.env.CLAUDE_DIR, 'plugins', 'marketplaces', 'alepo')
  const clone = join(marketplace, 'developer-workflow', 'skills').replace(/\\/g, '/')
  const shipped = join(process.env.CLAUDE_DIR, 'shipped-dw', 'skills')
  const none = join(process.env.CLAUDE_DIR, 'no-such-vendor')
  const installed = join(process.env.CLAUDE_DIR, 'plugins', 'installed_plugins.json')
  const stale = { plugins: { 'alepo-core@alepo': [{ installPath: '/p/core' }], 'developer-workflow@alepo': [{ installPath: '/p/dw/1.4.0' }] } }

  assert.equal(await alepoSkillsDir(marketplace, none), '', 'nothing installed, cloned or vendored: empty, and the step halts on that')
  mkdirSync(join(marketplace, 'developer-workflow', 'skills', 'review'), { recursive: true })
  assert.equal(await alepoSkillsDir(marketplace, none), '', 'a clone without review/SKILL.md is no answer')
  writeFileSync(join(marketplace, 'developer-workflow', 'skills', 'review', 'SKILL.md'), '# review')
  assert.equal(await alepoSkillsDir(marketplace, none), clone, 'the marketplace clone, without installing anything')

  // An installed plugin wins - when its directory really holds the skill.
  const real = join(process.env.CLAUDE_DIR, 'plugins', 'cache', 'dw', '1.5.0')
  mkdirSync(join(real, 'skills', 'review'), { recursive: true })
  writeFileSync(join(real, 'skills', 'review', 'SKILL.md'), '# review')
  writeFileSync(installed, JSON.stringify({ plugins: { 'developer-workflow@alepo': [{ installPath: real }] } }))
  assert.equal(await alepoSkillsDir(marketplace, none), join(real, 'skills').replace(/\\/g, '/'), 'an installed developer-workflow wins over the clone')

  // A stale installPath (a container's staged registry names the host's) is no
  // answer: it falls through instead of handing every agent a dead path.
  writeFileSync(installed, JSON.stringify(stale))
  assert.equal(await alepoSkillsDir(marketplace, none), clone, 'THE DEAD PATH: a stale installPath beat a valid clone')
  rmSync(join(process.env.CLAUDE_DIR, 'plugins', 'marketplaces'), { recursive: true, force: true })
  mkdirSync(join(shipped, 'review'), { recursive: true })
  writeFileSync(join(shipped, 'review', 'SKILL.md'), '# review')
  assert.equal(await alepoSkillsDir(marketplace, shipped), shipped.replace(/\\/g, '/'), 'THE CONTAINER: stale registry, no clone - the vendored copy is the answer')
  assert.equal(await alepoSkillsDir(marketplace, none), '', 'stale registry, no clone, nothing vendored: empty')

  writeFileSync(installed, '{ not json')
  assert.equal(await alepoSkillsDir(marketplace, shipped), shipped.replace(/\\/g, '/'), 'a broken registry falls through to what is on disk')

  // The default vendored copy is the one this repository ships, pinned.
  const { existsSync, readFileSync } = await import('node:fs')
  const vendored = join(process.cwd(), 'engineering', 'vendor', 'developer-workflow')
  assert.ok(existsSync(join(vendored, 'skills', 'review', 'SKILL.md')), 'the repository vendors review/SKILL.md')
  assert.ok(existsSync(join(vendored, 'skills', 'review', 'references', 'checklist.md')), 'and the checklist it cites')
  assert.match(readFileSync(join(vendored, 'VERSION'), 'utf-8'), /^alepolab\/alepo-claude-workflow [0-9a-f]{40} /, 'pinned to a commit')
  assert.equal(await alepoSkillsDir(marketplace), join(vendored, 'skills').replace(/\\/g, '/'), 'and is the default fallback')
  rmSync(installed)
  rmSync(join(process.env.CLAUDE_DIR, 'plugins'), { recursive: true, force: true })
  rmSync(join(process.env.CLAUDE_DIR, 'shipped-dw'), { recursive: true, force: true })
}

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

  // A subscription's limit, which says neither "API Error" nor 429.
  const { isApiErrorLine } = await import('../server/utils/agentCaller.ts')
  const limit = "You've hit your session limit · resets 6:40pm (Asia/Kolkata)"
  assert.equal(isApiErrorLine({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit' }, limit), true)
  assert.equal(isApiErrorLine({ type: 'assistant' }, limit), true, 'by its words alone too')
  assert.equal(isApiErrorLine({ type: 'assistant' }, 'API Error: 500'), true)
  assert.equal(isApiErrorLine({ type: 'assistant' }, 'The tests pass; the rate limiter is unchanged.'), false, 'ordinary prose is not an error')
}

console.log('    into workflowRunner.ts at module-load time, with no import-order dependency.')
