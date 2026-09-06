/**
 * Which directory a run's agents will work in.
 *
 * The run lock exists because two runs editing the same files corrupt each
 * other. It was written as "one run per workflow", which is neither necessary
 * nor sufficient once more than one developer signs in:
 *
 * - Not necessary: two people working on unrelated products share nothing, yet
 *   the second one got a 409 and no queue. A single global lock on the pipeline
 *   makes the tool single-user in practice.
 * - Not sufficient: `projectDir` is unset on every real run, because the
 *   provisioner clones into AGENT_WORKSPACE_ROOT. That root was ONE shared
 *   directory, so two runs of two DIFFERENT workflows would both clone
 *   alepo-dev-team-infra into the same path and stomp each other — a collision
 *   a per-workflow lock cannot see.
 *
 * So the root is now per developer, and the lock is scoped to the directory a
 * run will actually touch. Two people run concurrently; one person still cannot
 * start a second run over their own checkout.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Login sanitiser, matching users.ts: a login becomes one safe path segment. */
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_')

export const WORKSPACE_ROOT_VAR = 'AGENT_WORKSPACE_ROOT'

/** The configured root all developer workspaces live under. */
export function workspaceRoot(): string {
  return (process.env[WORKSPACE_ROOT_VAR] || '~/alepo-workspace').replace(/\/+$/, '')
}

/**
 * One developer's own checkout area. Anonymous runs (auth disabled, or a watch
 * dispatch with no starter) share the bare root, which is the old behaviour and
 * correct for them: there is no identity to separate them by.
 */
export function workspaceRootFor(login: string | undefined): string {
  const root = workspaceRoot()
  return login ? `${root}/${safe(login)}` : root
}

/**
 * The directory a run will actually write in, and therefore the thing the lock
 * must be taken on. An explicit projectDir wins — the caller named a checkout,
 * and two runs against it collide however different their workflows are.
 */
export function runWorkspace(run: { projectDir?: string, startedBy?: string }): string {
  return (run.projectDir?.trim()) || workspaceRootFor(run.startedBy)
}

/**
 * Whether a workspace holds a git checkout — the side effect a restart cannot
 * recreate on its own.
 *
 * The directory itself is either the checkout (an explicit projectDir) or the
 * root the provisioner clones repositories into, so both shapes count: a `.git`
 * here, or a `.git` one level down.
 */
export function hasCheckout(workspace: string): boolean {
  if (!existsSync(workspace)) return false
  if (existsSync(join(workspace, '.git'))) return true
  try {
    return readdirSync(workspace, { withFileTypes: true })
      .some(e => e.isDirectory() && existsSync(join(workspace, e.name, '.git')))
  }
  catch { return false }
}
