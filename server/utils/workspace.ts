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

/** What a browser-trace step can actually do here, decided by looking rather
 *  than by asking an agent to notice.
 *
 * The trace step twice produced no trace and no explanation, and the monitor
 * called it - correctly - "silence without explanation". The instruction to
 * declare `TRACE: n/a` was there; what was missing was anything concrete to
 * declare. A step told "there is no playwright config in this checkout and the
 * change touches no UI files" has a fact to quote. A step left to work it out
 * and then remember to say so has a chore it can skip.
 *
 * Deliberately conservative: it reports what is present, never that a trace is
 * impossible. The agent still decides, and every existing check on a CAPTURED
 * trace - populated trace.zip, real pass/fail counts, no fabricated artifact -
 * is untouched. This only closes the silent path.
 */
const PLAYWRIGHT_CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs']
const UI_EXTENSIONS = ['.vue', '.tsx', '.jsx', '.svelte', '.html', '.css', '.scss']

export interface BrowserSurface { playwright: boolean, uiFiles: string[], summary: string }

export function browserSurface(workspace: string): BrowserSurface {
  const roots: string[] = []
  if (existsSync(workspace)) {
    roots.push(workspace)
    try {
      for (const e of readdirSync(workspace, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.')) roots.push(join(workspace, e.name))
      }
    }
    catch { /* an unreadable workspace reports as bare */ }
  }

  const playwright = roots.some(r => PLAYWRIGHT_CONFIGS.some(c => existsSync(join(r, c))))

  // Only the working tree, and only one level of it: this is a hint for the
  // agent, not an inventory. A deep scan of a large checkout would cost more
  // than the step it is informing.
  const uiFiles: string[] = []
  for (const r of roots) {
    try {
      for (const e of readdirSync(r, { withFileTypes: true })) {
        if (e.isFile() && UI_EXTENSIONS.some(x => e.name.endsWith(x))) uiFiles.push(join(r, e.name))
      }
    }
    catch { /* skip */ }
  }

  const summary = playwright
    ? `Playwright config found${uiFiles.length ? '' : ', though no UI files were seen at the top level'} — a trace is expected unless the change has no UI surface.`
    : uiFiles.length
      ? 'No Playwright config found in this checkout, but UI files are present — say which you checked before reporting n/a.'
      : 'No Playwright config and no UI files found in this checkout — `TRACE: n/a` is the expected outcome, and this sentence is the reason to give.'

  return { playwright, uiFiles, summary }
}
