/**
 * The image must not run as root.
 *
 *   node scripts/test-dockerfile-nonroot.mjs
 *
 * This is not a hygiene check. agentCaller.ts starts every pipeline agent with
 * permissionMode 'bypassPermissions' and allowDangerouslySkipPermissions, and
 * Claude Code refuses both under uid 0:
 *
 *   --dangerously-skip-permissions cannot be used with root/sudo privileges
 *   for security reasons
 *
 * The SDK reports that only as "Claude Code process exited with code 1", so a
 * deployed team instance failed every run at its first step and the message
 * named nothing. Root is therefore a functional defect here, not a preference,
 * and it is exactly the kind of thing a later Dockerfile edit reintroduces
 * without noticing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dockerfile = readFileSync(join(import.meta.dirname, '..', 'Dockerfile'), 'utf8')

// Only the final stage matters: a build stage may legitimately need root.
const stages = dockerfile.split(/^FROM /m)
const runtime = stages[stages.length - 1]
assert.ok(runtime && stages.length > 2, 'expected a multi-stage Dockerfile')

const users = [...runtime.matchAll(/^USER\s+(\S+)/gm)].map(m => m[1])
assert.ok(
  users.length > 0,
  'the runtime stage declares no USER, so the container runs as root — and '
  + 'Claude Code refuses --dangerously-skip-permissions as root, which makes '
  + 'every pipeline step fail with "Claude Code process exited with code 1".',
)

const last = users[users.length - 1]
assert.ok(
  last !== 'root' && last !== '0',
  `the runtime stage ends on USER ${last}. See above: root breaks every pipeline step.`,
)

console.log(`dockerfile: runtime stage runs as "${last}", not root`)
