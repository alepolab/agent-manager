#!/usr/bin/env node
/**
 * "Is the plan gate actually armed here?" — not "is the plugin listed
 * somewhere?"
 *
 * The premise this script exists to close: alepo-engineering was installed
 * on this very machine at some point (its cache still holds
 * ~/.claude/plugins/cache/alepo-engineering/alepo-engineering/0.1.0/, with an
 * .orphaned_at marker) and is, right now, absent from
 * ~/.claude/plugins/installed_plugins.json and from every enabledPlugins map
 * in every settings file on this machine. A person who ran `claude plugin
 * list` a month ago and saw it there would have no way to notice it quietly
 * stopped being true. This script answers the actual question instead:
 * resolve every settings source Claude Code would really merge for hooks,
 * resolve every plugin hook source that's genuinely enabled, and then —
 * because a registration that merely LOOKS right is exactly the failure mode
 * the test lock's own postmortem describes (README.md: "the test lock was
 * registered and enforced nothing for weeks because its arming marker was
 * never written outside its own tests") — actually EXECUTE the resolved
 * commands against synthetic tool calls and assert the deny/arm really
 * happens.
 *
 *   node scripts/verify-enforcement.mjs [--repo <path>] [--json]
 *
 * Exit 0: both controls proven armed (and disableAllHooks is not silently
 * defeating them from any source). Exit 1: at least one is not, with the
 * specific reason — no plan-gate.mjs registration found anywhere, a
 * registration found but the file it points at doesn't exist, a matcher
 * missing Bash, disableAllHooks set true in some source, etc.
 *
 * This complements, and does not replace, Claude Code's own /status and
 * `claude doctor` (code.claude.com/docs/en/managed-settings#verify-enforcement)
 * — those report which SOURCE Claude Code selected; neither reports whether
 * a specific hook registration actually fires. `claude doctor` was run
 * against this machine while building this script and confirmed it has
 * nothing to say about per-hook arming (see engineering/docs/managed-settings.md).
 *
 * Test/CI overrides (--home, --managed) exist ONLY so this script's own test
 * suite can inject fixtures without touching the real machine's ~/.claude —
 * every default reads the real filesystem.
 */
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir, homedir, platform } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const engineeringRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { repo: null, home: homedir(), managed: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repo') args.repo = argv[++i]
    else if (a === '--home') args.home = argv[++i]
    else if (a === '--managed') args.managed = argv[++i]
    else if (a === '--json') args.json = true
  }
  if (!args.managed) {
    args.managed = platform() === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : platform() === 'win32' ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
      : '/etc/claude-code/managed-settings.json'
  }
  if (!args.repo) args.repo = findRepoRoot(process.cwd())
  return args
}

function findRepoRoot(start) {
  let dir = start
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

function readJsonSafe(path) {
  if (!path || !existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function gatherSettingsSources({ repo, home, managed }) {
  return {
    managed: { label: `managed-settings.json (${managed})`, data: readJsonSafe(managed) },
    projectLocal: { label: '<repo>/.claude/settings.local.json', data: readJsonSafe(join(repo, '.claude/settings.local.json')) },
    sharedProject: { label: '<repo>/.claude/settings.json', data: readJsonSafe(join(repo, '.claude/settings.json')) },
    user: { label: '~/.claude/settings.json', data: readJsonSafe(join(home, '.claude/settings.json')) },
  }
}

// Scalar precedence, highest first — matches code.claude.com/docs/en/settings
// ("In order, highest precedence first: managed, command line, project
// local, shared project, user"). Command line (--settings) isn't
// introspectable from outside a running session and is out of scope here.
const SCALAR_ORDER = ['managed', 'projectLocal', 'sharedProject', 'user']

function resolveScalar(sources, key) {
  for (const name of SCALAR_ORDER) {
    const s = sources[name]
    if (s.data && Object.prototype.hasOwnProperty.call(s.data, key)) return { value: s.data[key], source: s.label }
  }
  return { value: undefined, source: null }
}

function resolveEnabledPlugin(sources, pluginKey) {
  for (const name of SCALAR_ORDER) {
    const s = sources[name]
    const map = s.data?.enabledPlugins
    if (map && Object.prototype.hasOwnProperty.call(map, pluginKey)) return { value: !!map[pluginKey], source: s.label }
  }
  return { value: undefined, source: null }
}

/** Find an installed alepo-engineering plugin record, if any, preferring one scoped to this repo. */
function findInstalledPlugin(home, repo) {
  const installed = readJsonSafe(join(home, '.claude/plugins/installed_plugins.json'))
  const entries = Object.entries(installed?.plugins ?? {}).find(([key]) => key.startsWith('alepo-engineering@'))
  if (!entries) return null
  const [pluginKey, records] = entries
  if (!Array.isArray(records) || records.length === 0) return null
  const preferred = records.find(r => r.projectPath === repo) ?? records.find(r => r.scope === 'user') ?? records[0]
  return { pluginKey, installPath: preferred.installPath, scope: preferred.scope }
}

/** All (matcher, command, source-label) triples for one hook event, from
 * every settings source plus an active plugin, with placeholders resolved. */
function collectHookEntries({ sources, repo, plugin }, event) {
  const out = []
  for (const s of Object.values(sources)) {
    for (const group of s.data?.hooks?.[event] ?? []) {
      for (const h of group.hooks ?? []) {
        if (h.type !== 'command') continue
        out.push({ matcher: group.matcher ?? '', command: h.command.replaceAll('${CLAUDE_PROJECT_DIR}', repo), source: s.label })
      }
    }
  }
  if (plugin?.hooksConfig) {
    for (const group of plugin.hooksConfig.hooks?.[event] ?? []) {
      for (const h of group.hooks ?? []) {
        if (h.type !== 'command') continue
        out.push({ matcher: group.matcher ?? '', command: h.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin.installPath), source: `plugin ${plugin.pluginKey}` })
      }
    }
  }
  return out
}

function extractPath(command, filename) {
  const re = new RegExp(`["']?([^"'\\s]*${filename.replace('.', '\\.')})["']?`)
  const m = command.match(re)
  return m ? m[1] : null
}

function matcherTokens(matcher) {
  return (matcher ?? '').split('|').map(t => t.trim()).filter(Boolean)
}

/** Locate a registration whose command references `filename` and whose
 * matcher includes every token in `requiredTokens`. Reports the specific
 * reason it's missing rather than just returning null. */
function findRegistration(entries, filename, requiredTokens) {
  const candidates = entries.filter(e => e.command.includes(filename))
  if (candidates.length === 0) {
    return { ok: false, reason: `no registration anywhere references ${filename}` }
  }
  for (const c of candidates) {
    const tokens = matcherTokens(c.matcher)
    const missing = requiredTokens.filter(t => !tokens.includes(t))
    if (missing.length) continue
    const path = extractPath(c.command, filename)
    if (!path || !existsSync(path)) {
      return { ok: false, reason: `${filename} is registered (matcher "${c.matcher}", from ${c.source}) but its resolved path does not exist on disk: ${path ?? '(could not extract a path)'}` }
    }
    return { ok: true, entry: c, path }
  }
  const worst = candidates[0]
  return { ok: false, reason: `${filename} is registered (from ${worst.source}) but its matcher "${worst.matcher}" is missing: ${requiredTokens.filter(t => !matcherTokens(worst.matcher).includes(t)).join(', ')}` }
}

// execSync (shell) is deliberate here, not execFile: `command` is the
// literal registered hook string from a local settings/plugin file this
// machine's owner already trusts enough to run as Claude Code hooks on
// every Edit/Write/Bash call — it is not attacker- or network-supplied
// input, and this is the same pattern test-hooks-registration.mjs uses to
// prove a registration's exact quoting, not just a hand-built equivalent.
function runCommand(command, cwd, payload) {
  try {
    execSync(command, { input: JSON.stringify(payload), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd, shell: true })
    return { code: 0, message: '' }
  } catch (e) {
    return { code: e.status ?? 1, message: `${e.stderr ?? ''}` }
  }
}

function scratchWorkspace(setup = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-enforcement-'))
  mkdirSync(join(dir, '.agent'), { recursive: true })
  setup(dir)
  return dir
}

function proveplanGateDenies(registration) {
  const dir = scratchWorkspace()
  try {
    const r = runCommand(registration.entry.command, dir, { cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'src/x.ts') } })
    if (r.code !== 2) return { proven: false, reason: `resolved plan-gate command did not deny an Edit/Write with no plan present (exit ${r.code})` }
    return { proven: true }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function proveTestLockDenies(registration) {
  const dir = scratchWorkspace(d => {
    writeFileSync(join(d, '.agent/source-edited'), '1')
    mkdirSync(join(d, 'tests'), { recursive: true })
    writeFileSync(join(d, 'tests/x.test.js'), "test('x', () => {})\n")
  })
  try {
    const r = runCommand(registration.entry.command, dir, { cwd: dir, tool_name: 'Bash', tool_input: { command: `sed -i 's/x/y/' tests/x.test.js` } })
    if (r.code !== 2) return { proven: false, reason: `resolved test-lock command did not deny a sed -i bypass once armed (exit ${r.code})` }
    return { proven: true }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function proveArmHookArms(registration) {
  const dir = scratchWorkspace(d => {
    mkdirSync(join(d, 'src'), { recursive: true })
    writeFileSync(join(d, 'src/x.ts'), 'export const x = 1\n')
  })
  try {
    const r = runCommand(registration.entry.command, dir, { cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/x.ts') } })
    if (r.code !== 0) return { proven: false, reason: `resolved arm command exited nonzero (${r.code}) instead of just arming` }
    if (!existsSync(join(dir, '.agent/source-edited'))) return { proven: false, reason: 'resolved arm command ran but did not create .agent/source-edited' }
    return { proven: true }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const sources = gatherSettingsSources(args)
  const plugin = findInstalledPlugin(args.home, args.repo)
  if (plugin) {
    const enabled = resolveEnabledPlugin(sources, plugin.pluginKey)
    plugin.enabled = enabled.value === true
    plugin.enabledSource = enabled.source
    if (plugin.enabled) plugin.hooksConfig = readJsonSafe(join(plugin.installPath, 'hooks', 'hooks.json'))
  }

  const ctx = { sources, repo: args.repo, plugin: plugin?.enabled ? plugin : null }
  const preToolUse = collectHookEntries(ctx, 'PreToolUse')
  const postToolUse = collectHookEntries(ctx, 'PostToolUse')

  const findings = []
  const result = { repo: args.repo, ok: true }

  const disableAllHooks = resolveScalar(sources, 'disableAllHooks')
  if (disableAllHooks.value === true) {
    result.ok = false
    findings.push(`disableAllHooks is true (set in ${disableAllHooks.source}) — this silently turns off every hook below, regardless of registration`)
  }

  const planGateReg = findRegistration(preToolUse, 'plan-gate.mjs', ['Edit', 'Write'])
  if (!planGateReg.ok) {
    result.ok = false
    result.planGate = { armed: false, reason: planGateReg.reason }
    findings.push(`plan gate: NOT ARMED — ${planGateReg.reason}`)
  } else {
    const proof = disableAllHooks.value === true ? { proven: false, reason: 'skipped: disableAllHooks is true' } : proveplanGateDenies(planGateReg)
    result.planGate = { armed: proof.proven, source: planGateReg.entry.source, path: planGateReg.path, reason: proof.reason }
    if (!proof.proven) { result.ok = false; findings.push(`plan gate: NOT ARMED — ${proof.reason}`) }
    else findings.push(`plan gate: ARMED (${planGateReg.entry.source}, ${planGateReg.path}) — proven by executing it against a synthetic Write with no plan present`)
  }

  const testLockReg = findRegistration(preToolUse, 'test-lock.mjs', ['Bash'])
  if (!testLockReg.ok) {
    result.ok = false
    result.testLock = { armed: false, reason: testLockReg.reason }
    findings.push(`test lock: NOT ARMED — ${testLockReg.reason}`)
  } else {
    const proof = disableAllHooks.value === true ? { proven: false, reason: 'skipped: disableAllHooks is true' } : proveTestLockDenies(testLockReg)
    result.testLock = { armed: proof.proven, source: testLockReg.entry.source, path: testLockReg.path, reason: proof.reason }
    if (!proof.proven) { result.ok = false; findings.push(`test lock: NOT ARMED — ${proof.reason}`) }
    else findings.push(`test lock: ARMED (${testLockReg.entry.source}, ${testLockReg.path}) — proven by executing it against a synthetic sed -i once armed`)
  }

  const armReg = findRegistration(postToolUse, 'test-lock-arm.mjs', ['Edit', 'Write'])
  if (!armReg.ok) {
    result.ok = false
    result.testLockArm = { armed: false, reason: armReg.reason }
    findings.push(`test lock arm (PostToolUse): NOT ARMED — ${armReg.reason}`)
  } else {
    const proof = disableAllHooks.value === true ? { proven: false, reason: 'skipped: disableAllHooks is true' } : proveArmHookArms(armReg)
    result.testLockArm = { armed: proof.proven, source: armReg.entry.source, path: armReg.path, reason: proof.reason }
    if (!proof.proven) { result.ok = false; findings.push(`test lock arm (PostToolUse): NOT ARMED — ${proof.reason}`) }
    else findings.push(`test lock arm (PostToolUse): ARMED (${armReg.entry.source}) — proven by executing it against a synthetic source edit`)
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`Checked: ${args.repo}\n`)
    for (const f of findings) console.log(`  ${f}`)
    console.log(`\nOverall: ${result.ok ? 'ARMED' : 'NOT ARMED'}`)
  }
  process.exit(result.ok ? 0 : 1)
}

main()
