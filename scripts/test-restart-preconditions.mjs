/**
 * A restart must not run a step into a workspace with no code in it, and a
 * failed step must record the model that burned its tokens.
 *
 *   node scripts/test-restart-preconditions.mjs
 *
 * Both come from one run that cost $87.65 and produced nothing:
 *
 *   Ticket Intake     sonnet     59,679 in      $0.22
 *   Stand Up Stack    sonnet    578,953 in      $1.85   (skipped: no stack needed)
 *   Failing Test      opus    2,284,316 in     $35.23
 *   Implement Fix     opus    3,259,010 in     $50.35   error_max_turns, twice
 *
 * The provisioner correctly judged the ticket needed no test harness, and
 * cloned nothing. Restarting `Implement Fix` re-ran only that step — the
 * workspace stayed empty, and it searched a directory with no code for a second
 * time at 3.26M tokens.
 *
 * The cost report showed that step at $10.07, because usage was recorded
 * without the model and it was priced at the sonnet default. A $40
 * understatement, in the direction nobody investigates.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { hasCheckout, runWorkspace } = await import('../server/utils/workspace.ts')

const root = mkdtempSync(join(tmpdir(), 'ws-'))

// Nothing there at all.
assert.equal(hasCheckout(join(root, 'absent')), false, 'a missing directory holds no checkout')

// The exact shape that burned $50: the directory exists and is empty.
const empty = join(root, 'empty'); mkdirSync(empty)
assert.equal(hasCheckout(empty), false, 'an empty workspace holds no checkout')

// A directory of files that is not a repository is still not a checkout.
const notARepo = join(root, 'files'); mkdirSync(notARepo)
writeFileSync(join(notARepo, 'README.md'), '#')
assert.equal(hasCheckout(notARepo), false, 'files without .git are not a checkout')

// An explicit projectDir IS the checkout.
const direct = join(root, 'direct'); mkdirSync(join(direct, '.git'), { recursive: true })
assert.equal(hasCheckout(direct), true, 'a .git in the workspace itself counts')

// A provisioner clones INTO the root, so one level down counts too.
const parent = join(root, 'parent')
mkdirSync(join(parent, 'alepo-dev-team-infra', '.git'), { recursive: true })
assert.equal(hasCheckout(parent), true, 'a repository cloned inside the root counts')

// A sibling that is not a repo must not mask a real one.
mkdirSync(join(parent, 'scratch'), { recursive: true })
assert.equal(hasCheckout(parent), true, 'a non-repo sibling does not hide the checkout')

// And the workspace a run resolves to is the thing checked.
assert.equal(runWorkspace({ projectDir: direct }), direct)

rmSync(root, { recursive: true, force: true })
console.log('restart preconditions: an empty workspace is detected before a step runs in it')
