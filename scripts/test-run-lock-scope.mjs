/**
 * The run lock is scoped to the working directory, not the workflow.
 *
 *   node scripts/test-run-lock-scope.mjs
 *
 * The bug this pins: findActiveRun(workflowSlug) matched any live run of that
 * workflow, with no user filter. The second developer to start Runbook A got a
 * 409 and no queue — one global lock on the pipeline made a multi-user tool
 * single-user.
 *
 * The comment defending it said "two concurrent runs against the same
 * projectDir would have their agents editing the same files". True, and the
 * per-workflow lock was the wrong shape for it in BOTH directions:
 *
 * - too strict: two developers on unrelated products share no files at all
 * - too loose:  projectDir is unset on every real run, because the provisioner
 *               clones into AGENT_WORKSPACE_ROOT. That root was one shared
 *               directory, so two runs of two DIFFERENT workflows would clone
 *               the same repo to the same path — a collision the workflow-
 *               scoped lock could not see.
 */
import assert from 'node:assert/strict'

process.env.AGENT_WORKSPACE_ROOT = '/srv/agent-manager/workspace'
const { runWorkspace, workspaceRootFor, workspaceRoot } = await import('../server/utils/workspace.ts')

// Each developer gets their own root, so two people never share a checkout.
assert.equal(workspaceRootFor('alice'), '/srv/agent-manager/workspace/alice')
assert.equal(workspaceRootFor('bob'), '/srv/agent-manager/workspace/bob')
assert.notEqual(workspaceRootFor('alice'), workspaceRootFor('bob'))

// A login is one path segment: a crafted login must not escape the root.
assert.equal(workspaceRootFor('../../etc'), '/srv/agent-manager/workspace/.._.._etc')
assert.ok(!workspaceRootFor('a/b').includes('a/b'), 'a slash in a login is sanitised away')

// No identity (auth disabled, or a watch dispatch) keeps the old shared root.
assert.equal(workspaceRootFor(undefined), workspaceRoot())

// Two developers, same workflow, no projectDir -> different workspaces, so both run.
const alice = { startedBy: 'alice' }
const bob = { startedBy: 'bob' }
assert.notEqual(runWorkspace(alice), runWorkspace(bob), 'two developers must not block each other')

// One developer, two runs, no projectDir -> the same workspace, so the second blocks.
assert.equal(runWorkspace({ startedBy: 'alice' }), runWorkspace({ startedBy: 'alice' }))

// An explicit projectDir wins over identity: two people naming the same checkout
// DO collide, and must block each other however different their workflows are.
const shared = '/srv/agent-manager/workspace/shared/infra'
assert.equal(runWorkspace({ startedBy: 'alice', projectDir: shared }), shared)
assert.equal(
  runWorkspace({ startedBy: 'alice', projectDir: shared }),
  runWorkspace({ startedBy: 'bob', projectDir: shared }),
  'an explicit shared projectDir must still collide across developers',
)

// Whitespace is not a project directory.
assert.equal(runWorkspace({ startedBy: 'alice', projectDir: '   ' }), workspaceRootFor('alice'))

// Trailing slashes in the configured root must not create a second identity.
process.env.AGENT_WORKSPACE_ROOT = '/srv/agent-manager/workspace///'
assert.equal(workspaceRootFor('alice'), '/srv/agent-manager/workspace/alice')

// ══ A directory a person typed is canonicalised, or refused with a reason ══
//
// THE TRAP this guards: callAgent resolves its cwd as
// `projectDir && existsSync(projectDir) ? projectDir : claudeDir`, so a path
// that does not exist does not fail — it silently runs every agent inside the
// Claude config directory, with bypassPermissions, while the step header names
// the path that was typed. The run reports success. Refusing at the boundary a
// person types it is the only place that mistake is visible.
{
  const { canonicalProjectDir } = await import('../server/utils/workspace.ts')
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { tmpdir, homedir } = await import('node:os')
  const { join, resolve, sep } = await import('node:path')

  const real = mkdtempSync(join(tmpdir(), 'canon-'))

  // An existing absolute directory comes back resolved.
  assert.equal(canonicalProjectDir(real).path, resolve(real))

  // A trailing separator is stripped, because the lock compares directory
  // STRINGS: "/repo" and "/repo/" would otherwise be two locks on one checkout.
  assert.equal(canonicalProjectDir(real + sep).path, resolve(real),
    'a trailing separator must not create a second lock identity')
  assert.equal(canonicalProjectDir(real + sep).path, canonicalProjectDir(real).path)

  // A `~` is expanded rather than treated as a directory named "~", which is
  // what existsSync, Read and Glob all do with it.
  const underHome = canonicalProjectDir('~')
  assert.equal('error' in underHome ? '' : underHome.path, resolve(homedir()),
    'a leading ~ is expanded, not taken literally')

  // A relative path is refused: there is no cwd a run could sensibly resolve it against.
  assert.ok('error' in canonicalProjectDir('repos/app'), 'a relative path is refused')
  assert.match(canonicalProjectDir('repos/app').error, /not an absolute path/)

  // The case that motivates the whole check.
  assert.ok('error' in canonicalProjectDir(join(real, 'does-not-exist')))
  assert.match(canonicalProjectDir(join(real, 'does-not-exist')).error, /does not exist/,
    'a nonexistent directory is refused, not silently swapped for the config directory')

  // Nothing may aim a run at this instance's own configuration.
  const claudeDir = mkdtempSync(join(tmpdir(), 'canon-claude-'))
  process.env.CLAUDE_DIR = claudeDir
  const { setClaudeDir } = await import('../server/utils/claudeDir.ts')
  setClaudeDir(claudeDir)
  mkdirSync(join(claudeDir, 'workflows'), { recursive: true })
  assert.ok('error' in canonicalProjectDir(claudeDir), 'the config directory itself is refused')
  assert.match(canonicalProjectDir(join(claudeDir, 'workflows')).error, /Claude config directory/,
    'a directory INSIDE the config directory is refused too - a run must not edit its own configuration')

  // Empty is "not stated", and the caller decides what that means; it is never a path.
  assert.ok('error' in canonicalProjectDir('   '))
}

console.log('run lock scope: per developer, per checkout, and a typed directory is checked')
