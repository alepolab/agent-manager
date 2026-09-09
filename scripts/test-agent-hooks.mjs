/**
 * The guardrails a pipeline agent runs under are registered by the runner, not
 * inherited from whoever's machine this is.
 *
 * Inheritance was how they used to arrive, and it brought the developer's whole
 * interactive session with them — persona, output style, every discovered skill
 * and CLAUDE.md — measured at ~17,000 tokens on every turn of every step, and it
 * silently re-added tools an agent had narrowed away. Cutting the inheritance
 * means these hooks have to be registered explicitly, and a hook that cannot be
 * registered has to STOP the run: an agent editing a product repository without
 * the plan gate, the test lock and the secrets guard is worse than no run.
 *
 *   node scripts/test-agent-hooks.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'agent-hooks-'))
process.env.CLAUDE_DIR = join(root, 'claude')
mkdirSync(process.env.CLAUDE_DIR, { recursive: true })

// A fake plugin: the same hooks.json shape the real one ships, with scripts we control.
const plugin = join(root, 'plugin')
const hooks = join(plugin, 'hooks')
mkdirSync(hooks, { recursive: true })
const script = (name, body) => { writeFileSync(join(hooks, name), body); chmodSync(join(hooks, name), 0o755) }
script('denier.mjs', 'process.stderr.write("Blocked: the oracle is locked."); process.exit(2)\n')
script('allower.mjs', 'process.exit(0)\n')
script('crasher.mjs', 'throw new Error("hook is broken")\n')
script('arm.mjs', 'process.exit(0)\n')
const hooksJson = (spec) => writeFileSync(join(hooks, 'hooks.json'), JSON.stringify({ hooks: spec }, null, 2))
hooksJson({
  PreToolUse: [
    { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/denier.mjs"' }] },
    { matcher: 'Read|Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/allower.mjs"' }] },
  ],
  PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/arm.mjs"' }] }],
})
writeFileSync(join(process.env.CLAUDE_DIR, 'plugins'), '') // placeholder replaced below
import { rmSync } from 'node:fs'
rmSync(join(process.env.CLAUDE_DIR, 'plugins'))
mkdirSync(join(process.env.CLAUDE_DIR, 'plugins'), { recursive: true })
writeFileSync(join(process.env.CLAUDE_DIR, 'plugins', 'installed_plugins.json'),
  JSON.stringify({ plugins: { 'alepo-engineering@alepo-engineering': [{ installPath: plugin, version: '0.1.0' }] } }))

const { pipelineHooks, hooksDir } = await import('../server/utils/agentHooks.ts')

// ── 1. the plugin's hooks are found and every declared script registered ──
assert.equal(hooksDir(), hooks, 'the installed plugin wins over the shipped copy')
const reg = await pipelineHooks()
assert.deepEqual(reg.registered.sort(), ['PostToolUse:arm.mjs', 'PreToolUse:allower.mjs', 'PreToolUse:denier.mjs'],
  `every declared hook is registered: ${reg.registered.join(', ')}`)
assert.deepEqual(Object.keys(reg.hooks).sort(), ['PostToolUse', 'PreToolUse'])
assert.deepEqual(reg.hooks.PreToolUse.map(m => m.matcher), ['Edit|Write', 'Read|Bash'], 'the plugin owns the matchers, not this file')

// ── 2. a denying hook denies the call, with the script's own reason ──
const call = (fn, tool, input) => fn({ tool_name: tool, tool_input: input, cwd: root }, undefined, { signal: new AbortController().signal })
const denied = await call(reg.hooks.PreToolUse[0].hooks[0], 'Write', { file_path: '/x/test_foo.py' })
assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(denied))
assert.match(denied.hookSpecificOutput.permissionDecisionReason, /oracle is locked/, 'the reason is the script\'s own stderr, verbatim')

// ── 3. an allowing hook allows, and a BROKEN hook allows rather than wedging the run ──
assert.deepEqual(await call(reg.hooks.PreToolUse[1].hooks[0], 'Read', { file_path: '/x/a.txt' }), {}, 'exit 0 allows')
script('crasher-registered.mjs', 'throw new Error("hook is broken")\n')
hooksJson({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/crasher-registered.mjs"' }] }] })
const broken = await pipelineHooks()
assert.deepEqual(await call(broken.hooks.PreToolUse[0].hooks[0], 'Bash', { command: 'ls' }), {},
  'a hook that crashes allows the call: the scripts own doctrine is that a broken guard must not wedge the estate')

// ── 4. a hook that cannot be registered STOPS the run ──
hooksJson({ PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/gone.mjs"' }] }] })
await assert.rejects(pipelineHooks(), /does not exist.*must not run without it/s,
  'a declared script that is missing is fatal, never a warning to run past')
hooksJson({ SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/allower.mjs"' }] }] })
await assert.rejects(pipelineHooks(), /registered no PreToolUse or PostToolUse hook/,
  'hooks.json carrying nothing the pipeline enforces is fatal too')

// ── 5. no plugin and no shipped copy: fatal, and the message says how to fix it ──
writeFileSync(join(process.env.CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {} }))
const cwd = process.cwd()
process.chdir(root) // no engineering/hooks here
try {
  await assert.rejects(pipelineHooks(), /Install the plugin, or restore engineering\/hooks/,
    'with the guardrails nowhere on the instance, a pipeline agent must not start')
} finally { process.chdir(cwd) }

// ── 6. the real plugin on THIS instance registers the three guards the pipeline documents ──
delete process.env.CLAUDE_DIR
const real = await import('../server/utils/agentHooks.ts?real=1').then(m => m.pipelineHooks()).catch(e => e)
if (real instanceof Error) {
  console.log(`  note: the real guardrails are not installed here (${real.message.slice(0, 60)}...) — checked the shipped copy only`)
} else {
  for (const guard of ['plan-gate.mjs', 'test-lock.mjs', 'secrets-guard.mjs', 'test-lock-arm.mjs']) {
    assert.ok(real.registered.some(r => r.endsWith(guard)), `${guard} is registered on this instance: ${real.registered.join(', ')}`)
  }
}

rmSync(root, { recursive: true, force: true })
console.log('agent hooks: guardrails are registered explicitly, deny works, and a missing one stops the run')
