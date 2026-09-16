/**
 * `docs/plans/` stays visible to git.
 *
 * `oma link` (oh-my-agent) rewrites `.gitignore` on every run and re-adds
 * `docs/plans/` to it. That was verified by running it: the line came back at
 * `.gitignore:68` and undid the fix already committed once. `.gitignore` is a
 * TRACKED file, so unlike everything else `link` regenerates — `.claude/`,
 * `.codex/`, `AGENTS.md`, all gitignored and disposable — this one changes the
 * repository's real behaviour for everyone.
 *
 * The failure is silent by construction. An already-tracked file is unaffected
 * by a gitignore rule, so the single spec currently in `docs/plans/` keeps
 * working and nothing looks wrong. The NEXT design spec written there simply
 * never appears in `git status`, is never committed, and is missing from the
 * branch the next person checks out. No error, no warning, no diff.
 *
 * Deleting the line is not a fix, because it comes back — including when a
 * teammate runs `link` with no idea this interaction exists. This test is the
 * fix: CI globs `scripts/test-*.mjs`, so the regression fails a PR instead of
 * quietly shipping.
 *
 * It asserts BEHAVIOUR, not text. Grepping `.gitignore` for the literal
 * `docs/plans/` would pass against `/docs/plans/`, `docs/plans`, or
 * `docs/plans/**`, every one of which ignores the directory just as
 * effectively. `git check-ignore` is the only thing that answers the question
 * actually being asked.
 *
 * Not guarded here: `attribution` reappearing in `.claude/settings.json` on the
 * same `link` run. `.claude/` is gitignored, so it can never reach the
 * repository, and there is no config knob for it — `attribution` appears
 * nowhere in `oma-config.cue`, the yaml, `oma-scm`, or `rules/commit.md`. A
 * test here could assert nothing durable about it.
 *
 *   node scripts/test-gitignore-keeps-plans.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

/** Paths that must remain visible to git, with why each one matters. */
const MUST_NOT_BE_IGNORED = [
  ['docs/plans/2099-01-01-000-probe.md', 'a new design spec'],
  ['docs/plans/designs/probe.md', 'a design doc in the subdirectory oh-my-agent\'s own skills reference'],
]

/**
 * Is `path` ignored by git?
 *
 * `git check-ignore -q` exits 0 when the path IS ignored, 1 when it is not, and
 * 128 on a real error (not a repository, git missing). The 128 case must fail
 * loudly rather than read as "not ignored" — a guard that silently passes when
 * it cannot run is worse than no guard, because it still reports green.
 */
function isIgnored(path) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', path], { encoding: 'utf8' })
  if (r.error) assert.fail(`could not run git to check ${path}: ${r.error.message}`)
  assert.ok(r.status === 0 || r.status === 1,
    `git check-ignore failed on ${path} (exit ${r.status}). This test asserts a property of the `
    + `repository, so it must run inside a git checkout.\n${r.stderr ?? ''}`)
  return r.status === 0
}

// Sanity: the check must be capable of reporting "ignored" at all. Without
// this, a `git check-ignore` that always exited 1 would make every assertion
// below pass while testing nothing.
assert.ok(isIgnored('node_modules/anything.js'),
  'sanity: node_modules is ignored by this repo, so check-ignore must report it as ignored — '
  + 'if this fails, the check itself is broken and the rest of this test proves nothing')

for (const [path, what] of MUST_NOT_BE_IGNORED) {
  assert.ok(!isIgnored(path),
    `.gitignore is hiding ${path} (${what}).\n\n`
    + 'This is almost certainly `oma link`, which re-adds `docs/plans/` to .gitignore every\n'
    + 'time it runs. Remove that line from .gitignore.\n\n'
    + 'It matters because the failure is silent: already-tracked plans keep working, so\n'
    + 'nothing looks broken, while every NEW design spec written to docs/plans/ never shows\n'
    + 'up in `git status` and is lost without an error.')
}

console.log(`docs/plans stays visible to git: ${MUST_NOT_BE_IGNORED.length} paths checked, 0 ignored`)
