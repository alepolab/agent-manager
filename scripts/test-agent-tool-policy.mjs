/**
 * Self-check for server/utils/agentToolPolicy.ts - how an agent's frontmatter
 * decides the SDK's `tools` option (the option that actually restricts what a
 * `query()` call can do - `allowedTools` only pre-approves a permission prompt
 * and is a no-op under this app's `permissionMode: 'bypassPermissions'`).
 * No test framework in this repo: plain asserts.
 *
 *   node scripts/test-agent-tool-policy.mjs
 */
import assert from 'node:assert/strict'
import {
  resolveTools,
  resolveMaxTurns,
  resolveModel,
  DEFAULT_MAX_TURNS,
} from '../server/utils/agentToolPolicy.ts'
import { MODEL_ALIAS, DEFAULT_MODEL_ALIAS } from '../server/utils/models.ts'

// ── 1. No frontmatter at all keeps today's effective behaviour ────────────
// Today's effective behaviour (bug and all) is the SDK's full default toolset,
// because `allowedTools` never restricted anything. Once callers switch to the
// `tools` option, "no `tools` declared" must map to `undefined` - NOT some
// smaller default list - or every existing agent/template regresses.
assert.equal(resolveTools(undefined), undefined)
assert.equal(resolveMaxTurns(undefined), DEFAULT_MAX_TURNS)

// ── 2. An agent that declares nothing keeps today's behaviour ─────────────
assert.equal(resolveTools({}), undefined)
assert.equal(resolveMaxTurns({}), DEFAULT_MAX_TURNS)
assert.equal(DEFAULT_MAX_TURNS, 10)

// ── 3. A declared toolset is used verbatim, Bash included ─────────────────
assert.deepEqual(
  resolveTools({ tools: ['Bash', 'Read', 'Glob'] }),
  ['Bash', 'Read', 'Glob'],
)

// ── 4. An empty tools array is a declaration, not an absence ──────────────
// A step that should touch nothing must be able to say so - see the caller-side
// empirical check below for proof this is not a no-op in the installed SDK.
assert.deepEqual(resolveTools({ tools: [] }), [])

// ── 5. A declared turn budget wins; nonsense values fall back ─────────────
assert.equal(resolveMaxTurns({ maxTurns: 40 }), 40)
assert.equal(resolveMaxTurns({ maxTurns: 0 }), DEFAULT_MAX_TURNS)
assert.equal(resolveMaxTurns({ maxTurns: -5 }), DEFAULT_MAX_TURNS)
assert.equal(resolveMaxTurns({ maxTurns: 2.5 }), DEFAULT_MAX_TURNS)

// ── 5b. resolveModel: a declared model is honoured, not silently ignored ──
// This is the fix for the defect fix round 3 caught: frontmatter.model was
// parsed and then never used anywhere, so every agent silently ran on the
// SDK's own default regardless of what it declared. resolveModel is the
// pure mapping callAgent.ts now actually wires into query()'s options.
assert.deepEqual(resolveModel({ model: 'opus' }), { alias: 'opus', id: MODEL_ALIAS.opus },
  'a declared model resolves to its alias AND full SDK id')
assert.deepEqual(resolveModel({ model: 'haiku' }), { alias: 'haiku', id: MODEL_ALIAS.haiku })
assert.deepEqual(resolveModel(undefined), { alias: DEFAULT_MODEL_ALIAS, id: MODEL_ALIAS[DEFAULT_MODEL_ALIAS] },
  'no frontmatter at all falls back to this repo\'s own documented default, not the SDK default')
assert.deepEqual(resolveModel({}), { alias: DEFAULT_MODEL_ALIAS, id: MODEL_ALIAS[DEFAULT_MODEL_ALIAS] },
  'frontmatter present but no model field falls back the same way')

console.log('agentToolPolicy: pure resolveTools()/resolveMaxTurns()/resolveModel() assertions passed')

// ── 6. The caller must pass this as `tools`, not `allowedTools` ───────────
// Static guard against regressing the exact bug this module exists to fix:
// server/api/chat.post.ts must feed resolveTools()'s output into the SDK's
// `tools` option (which genuinely restricts), never `allowedTools` (which,
// combined with this app's `permissionMode: 'bypassPermissions', is a no-op -
// verified empirically below).
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../server/api/chat.post.ts', import.meta.url), 'utf-8')
  assert.ok(
    /\btools:\s*toolsOption\b|\btools:\s*resolveTools\(/.test(src),
    'chat.post.ts must pass resolveTools()\'s output as the `tools` option',
  )
  assert.ok(
    !/\ballowedTools:\s*resolveTools\(/.test(src) && !/\ballowedTools:\s*resolveAllowedTools\(/.test(src),
    'chat.post.ts must not pass the per-agent toolset as `allowedTools` - it does not restrict anything',
  )
}

// ── 7. Empirical proof against the installed SDK ───────────────────────────
// Confirms, with a real `query()` call, that:
//   (a) `allowedTools` + `permissionMode: 'bypassPermissions'` does NOT stop Bash
//   (b) `tools: [...]` DOES restrict the registered toolset
//   (c) `tools: []` genuinely yields zero tools (not a silent no-op / full-default
//       fallback) - so no `disallowedTools` workaround is needed for the "declares
//       tools: [] -> no tools" requirement.
// Skipped by default (hits the real Claude Code CLI/API and costs tokens) - run
// explicitly with RUN_SDK_EMPIRICAL_CHECK=1.
if (process.env.RUN_SDK_EMPIRICAL_CHECK === '1') {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')

  async function run(options) {
    let sawToolUse = false
    let initTools
    for await (const message of query({
      prompt: 'Use the Bash tool to run `echo HELLO` right now. Do not ask, just do it.',
      options: {
        cwd: process.cwd(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 2,
        ...options,
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') initTools = message.tools
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'tool_use' && block.name === 'Bash') sawToolUse = true
        }
      }
    }
    return { sawToolUse, initTools }
  }

  const a = await run({ allowedTools: ['Read', 'Grep', 'Glob'] })
  assert.ok(a.initTools.includes('Bash'), 'allowedTools must not remove Bash from the registered toolset (documents the bug)')

  const b = await run({ tools: ['Read', 'Grep', 'Glob'] })
  assert.ok(!b.initTools.includes('Bash'), 'tools option must remove Bash when not listed')
  assert.equal(b.sawToolUse, false, 'model must not be able to call Bash when tools excludes it')

  const c = await run({ tools: [] })
  assert.deepEqual(c.initTools, [], 'tools: [] must register zero tools')
  assert.equal(c.sawToolUse, false, 'model must not be able to call Bash when tools is empty')

  console.log('agentToolPolicy: empirical SDK behaviour assertions passed')
} else {
  console.log('agentToolPolicy: skipping empirical SDK check (set RUN_SDK_EMPIRICAL_CHECK=1 to run it)')
}
