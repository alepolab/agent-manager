/**
 * The sandbox runner against a real Docker daemon: a `docker run` built by
 * buildSandboxSpec, with a throwaway image standing in for the runner image,
 * proves that the env allowlist, the mounts and the limits are accepted by
 * the daemon and that only the allowlisted names are visible inside.
 *
 * Skipped unless SANDBOX_SMOKE=1 AND docker answers: CI has no daemon, and a
 * laptop without one must not fail the suite over it.
 *
 *   SANDBOX_SMOKE=1 node scripts/test-sandbox-smoke.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.SANDBOX_SMOKE !== '1') { console.log('sandbox smoke: skipped (set SANDBOX_SMOKE=1 with a docker daemon)'); process.exit(0) }
try { execFileSync('docker', ['info'], { stdio: 'ignore' }) } catch { console.log('sandbox smoke: skipped (docker daemon not reachable)'); process.exit(0) }

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'sandbox-smoke-'))
const sb = await import('../server/utils/runner/sandbox.ts')

await sb.ensureSandboxNetwork()
const worktree = mkdtempSync(join(tmpdir(), 'smoke-wt-'))
writeFileSync(join(worktree, 'marker'), 'present')
const configDir = await sb.stageSandboxConfig('smoke-run')
const engineeringDir = join(process.cwd(), 'engineering')

// busybox prints its env and lists the mounts; it has no `claude`, so the
// command tail is replaced for this probe only. Everything before the image is
// exactly what a real step gets.
const spec = sb.buildSandboxSpec({
  runId: 'smoke-run', stepId: 's1', image: 'busybox:1.36', cwd: worktree,
  mounts: { worktree, clone: undefined, configDir, engineeringDir },
  hostEnv: { ...process.env, ANTHROPIC_API_KEY: 'smoke-key', SUPER_SECRET: 'leak', JIRA_EMAIL: 'a@b' },
  cliArgs: [], limits: sb.sandboxLimits({ budget: { maxMinutes: 1 } }),
})
const i = spec.args.indexOf('timeout')
const args = [...spec.args.slice(0, i), 'sh', '-c', 'env; echo MARKER=$(cat marker); ls /sandbox/claude']
const r = spawnSync('docker', args, { env: { ...spec.env, PATH: process.env.PATH, HOME: process.env.HOME ?? '' }, encoding: 'utf8' })
assert.equal(r.status, 0, `docker run failed: ${r.stderr}`)
assert.match(r.stdout, /ANTHROPIC_API_KEY=smoke-key/, 'an allowlisted variable is inside')
assert.match(r.stdout, /JIRA_EMAIL=a@b/)
assert.match(r.stdout, /ALEPO_PIPELINE=1/)
assert.match(r.stdout, /CLAUDE_CONFIG_DIR=\/sandbox\/claude/)
assert.ok(!/SUPER_SECRET/.test(r.stdout), 'a non-allowlisted variable is not')
assert.match(r.stdout, /MARKER=present/, 'the worktree is mounted at its own path and is the cwd')
assert.match(r.stdout, /settings.json/, 'the staged config is mounted')

const left = await sb.reapSandboxContainers('smoke-run')
assert.deepEqual(left, [], '--rm left nothing to reap')
await sb.removeSandboxConfig(configDir)
console.log('sandbox smoke: ok')
