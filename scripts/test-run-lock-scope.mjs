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

console.log('run lock scope: per developer, and per checkout when one is named')
