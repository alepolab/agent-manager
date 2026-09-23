/**
 * What a cut-short step is answerable for, and what it must leave alone.
 *
 * Run b2470236's test-author started a containerised Gradle build, ran out of
 * its wall-clock budget, and was aborted mid-wait. `docker run` is a client:
 * the container kept running, held 1.8GB, and was still there long after the
 * run had failed — on a host that then killed a process for lack of memory.
 * Nothing in the run record pointed at it.
 *
 * The danger in reaping is reaping too much. This estate shares one network and
 * one SSO stack, and Runbook C deliberately leaves a product stack up between
 * steps, so the rule matches on the one thing that is unambiguously this run's:
 * a bind mount inside its own worktree.
 *
 *   node scripts/test-run-containers.mjs
 */
import assert from 'node:assert/strict'

const { containersToReap } = await import('../server/utils/runContainers.ts')

const worktree = 'C:/Users/dev/alepo-workspace/local/ASECRM-199@fix-ASECRM-199-b2470236'
const since = 1_000_000

const build = { id: 'aaa1', createdAt: since + 5_000, mounts: [worktree, 'C:/Users/dev/.gradle'] }
const nested = { id: 'aaa2', createdAt: since + 9_000, mounts: [`${worktree}/backend`] }
// The deployment repo, NOT the worktree: a product stack the runbook wants kept.
const stack = { id: 'bbb1', createdAt: since + 7_000, mounts: ['C:/Users/dev/alepo-workspace/local/alepo-dev-team-infra'] }
// Someone else's, started before this step began.
const older = { id: 'ccc1', createdAt: since - 1, mounts: [worktree] }
const unrelated = { id: 'ddd1', createdAt: since + 1_000, mounts: ['C:/repos/other-thing'] }

// ── the build this step orphaned, and anything under the worktree with it ──
assert.deepEqual(
  containersToReap([build, nested, stack, older, unrelated], { worktree, since }).sort(),
  ['aaa1', 'aaa2'],
)

// ── a container that predates the step is not this step's, however well it matches ──
assert.deepEqual(containersToReap([older], { worktree, since }), [])

// ── Windows hands back both separators and either case; one shape wins ──
const windowsy = { id: 'eee1', createdAt: since + 1, mounts: ['C:\\Users\\Dev\\Alepo-Workspace\\Local\\ASECRM-199@fix-ASECRM-199-b2470236\\backend'] }
assert.deepEqual(containersToReap([windowsy], { worktree, since }), ['eee1'])

// ── an agent in Git Bash reports its cwd MSYS-style ──
// The probe that proved the reaper mounted `/c/Users/...` while the run
// recorded `C:\Users\...`. Nothing matched, the container survived the run,
// and the reaper looked like it had simply not run.
const msys = { id: 'ggg1', createdAt: since + 1, mounts: ['/c/Users/dev/alepo-workspace/local/ASECRM-199@fix-ASECRM-199-b2470236'] }
assert.deepEqual(containersToReap([msys], { worktree, since }), ['ggg1'])
assert.deepEqual(containersToReap([build], { worktree: '/c/Users/dev/alepo-workspace/local/ASECRM-199@fix-ASECRM-199-b2470236', since }), ['aaa1'])

// ── a trailing separator on either side is still the same directory ──
assert.deepEqual(containersToReap([build], { worktree: `${worktree}/`, since }), ['aaa1'])

// ── a sibling directory that merely starts with the same characters is NOT inside it ──
const sibling = { id: 'fff1', createdAt: since + 1, mounts: [`${worktree}-scratch/build`] }
assert.deepEqual(containersToReap([sibling], { worktree, since }), [])

// ── no worktree means no rule: reap nothing rather than everything ──
// A run without a projectDir passes '' here, and a prefix test against an empty
// string matches every path in the estate.
assert.deepEqual(containersToReap([build, stack, unrelated], { worktree: '', since }), [])

console.log('run containers: ok')
