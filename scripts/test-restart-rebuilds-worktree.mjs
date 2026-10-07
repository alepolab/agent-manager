/**
 * A restart puts back a run worktree that was removed out from under the run,
 * on the run's own branch, before preflight reads it. Real git throughout.
 *
 * `git worktree remove` stops part-way on files it cannot delete (a
 * container's ignored output, owned by root) and leaves a `.git` file pointing
 * at a gitdir that is already gone. ASECRM-357's restart then failed preflight
 * with "not a git repository". A worktree removed cleanly was worse, quietly:
 * it was made again with `-B` from the base branch, and the run's commits were
 * gone from its branch.
 *
 *   node scripts/test-restart-rebuilds-worktree.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'rebuild-wt-'))
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_RUNS_DIR = join(root, 'runs')
process.env.AGENT_WORKSPACE_ROOT = join(root, 'ws')
process.env.AGENT_REGISTRY_PATH = join(root, 'products.yaml')
// The agents' git, as the runner's preflight asks it: an identity, no signing.
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n')
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
mkdirSync(process.env.AGENT_WORKSPACE_ROOT, { recursive: true })

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const origin = join(root, 'origin.git')
git(root, 'init', '--quiet', '--bare', '-b', 'main', origin)
const seed = join(root, 'seed')
git(root, 'clone', '--quiet', origin, seed)
writeFileSync(join(seed, 'A'), 'a\n'); git(seed, 'add', 'A'); git(seed, 'commit', '--quiet', '-m', 'a'); git(seed, 'push', '--quiet', 'origin', 'main')
git(seed, 'checkout', '--quiet', '-b', 'develop'); git(seed, 'push', '--quiet', 'origin', 'develop')
const clone = join(process.env.AGENT_WORKSPACE_ROOT, 'demo')
git(root, 'clone', '--quiet', origin, clone)
writeFileSync(process.env.AGENT_REGISTRY_PATH, `products:
  demo:
    match: { projects: [DEMO] }
    repos: [alepolab/demo]
    branches: { bug: develop, feature: develop }
`)

const steps = [
  { id: 'code', agentSlug: 'agent-code', label: 'Code', next: ['check'] },
  { id: 'check', agentSlug: 'agent-check', label: 'Check', next: [] },
]
const workflow = { slug: 'fix', name: 'fix', steps }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'fix.json'), JSON.stringify({ name: 'fix', description: '', steps, createdAt: new Date().toISOString() }))

const runner = await import('../server/utils/workflowRunner.ts')
const { runPreflight } = await import('../server/utils/preflight.ts')
// The real preflight, product checkout and git identity included: that is
// where "not a git repository" refused the restart. Only the guardrail hooks
// check is dropped, which asks about this host's ~/.claude settings.
runner.setPreflight(async (run, s) => {
  const report = await runPreflight(run, s)
  return { ...report, checks: report.checks.filter(c => c.name !== 'guardrail hooks') }
})

// What each step saw, by ticket: the code step commits and leaves scratch in
// .agent/; the check step looks at the checkout it was handed.
const seen = {}
const failCheckOnce = new Set()
runner.setAgentCaller(async (slug, input, cwd) => {
  const key = input.match(/DEMO-\d+/)[0]
  const s = seen[key] ??= { checks: [] }
  if (slug === 'agent-code') {
    for (const f of ['fix.txt', 'lib.txt', 'other.txt']) writeFileSync(join(cwd, f), `${f}\n`)
    git(cwd, 'add', '.'); git(cwd, 'commit', '--quiet', '-m', `fix ${key}`)
    s.commit = git(cwd, 'rev-parse', 'HEAD')
    mkdirSync(join(cwd, '.agent'), { recursive: true })
    writeFileSync(join(cwd, '.agent', 'plan.md'), `plan for ${key}\n`)
    return 'coded'
  }
  let state
  try {
    state = {
      cwd,
      toplevel: git(cwd, 'rev-parse', '--show-toplevel'),
      branch: git(cwd, 'branch', '--show-current'),
      hasCommit: (() => { try { git(cwd, 'merge-base', '--is-ancestor', s.commit, 'HEAD'); return true } catch { return false } })(),
      fixFile: existsSync(join(cwd, 'fix.txt')),
      plan: existsSync(join(cwd, '.agent', 'plan.md')) ? readFileSync(join(cwd, '.agent', 'plan.md'), 'utf8') : null,
    }
  } catch (err) { state = { cwd, error: String(err.stderr || err.message) } }
  s.checks.push(state)
  if (failCheckOnce.delete(key)) throw new Error('check failed, as the test arranged')
  return 'checked'
})

async function restart(id, stepId) {
  for (let i = 0; ; i++) {
    try { return await runner.restartRun(id, stepId, 'go again') }
    catch (err) {
      // A failure is published just before the run lets go of its slot.
      if (err.statusCode === 409 && /already running|in progress/.test(err.message) && i < 20) { await new Promise(r => setTimeout(r, 100)); continue }
      if (/not a git repository/.test(err.message)) assert.fail(`THE REGRESSION: the restart was refused on the removed worktree: ${err.message}`)
      throw err
    }
  }
}

async function finished(ticket, { failFirst = false } = {}) {
  if (failFirst) failCheckOnce.add(ticket)
  const own = join(process.env.AGENT_WORKSPACE_ROOT, ticket)
  const started = await runner.startRun({ workflow, initialPrompt: `${ticket}: fix it`, watch: 'direct-invocation', autoRun: true, projectDir: own, ticketKey: ticket })
  const run = await runner.waitForSettled(started.id, 15000)
  assert.equal(run.status, failFirst ? 'failed' : 'completed', run.error)
  assert.equal(run.projectDir, `${clone}@${run.branch.replace(/\//g, '-')}`, 'the run owns a worktree beside the clone')
  return run
}

function assertWorking(run, ticket) {
  const s = seen[ticket]
  const after = s.checks.at(-1)
  assert.ok(!after.error, `THE REGRESSION: the restarted step ran outside a working checkout: ${after.error}`)
  assert.equal(after.cwd, run.projectDir, 'the restarted step worked in the run worktree')
  assert.equal(after.toplevel, run.projectDir, 'which is a git checkout of its own')
  assert.equal(after.branch, run.branch, 'on the run branch')
  assert.ok(after.hasCommit, 'THE REGRESSION: the run\'s commit is gone from its branch (the worktree was made again from the base with -B)')
  assert.ok(after.fixFile, 'and the committed work is on disk')
  assert.equal(git(clone, 'rev-parse', `refs/heads/${run.branch}`), s.commit, 'the branch was not moved')
}

const brokenBeside = (run) => readdirSync(dirname(run.projectDir)).filter(n => n.startsWith(`.broken-${basename(run.projectDir)}-`))
const rebuiltArtifact = (run) => {
  const dirs = readdirSync(process.env.AGENT_RUNS_DIR, { recursive: true }).filter(p => String(p).endsWith('worktree-rebuilt.json') && String(p).includes(run.id))
  assert.equal(dirs.length, 1, 'the rebuild is recorded as an artifact of the run')
  return JSON.parse(readFileSync(join(process.env.AGENT_RUNS_DIR, dirs[0]), 'utf8'))
}

// ── (a) a completed run whose worktree was removed whole ────────────────────
{
  const run = await finished('DEMO-1')
  git(clone, 'worktree', 'remove', '--force', run.projectDir)
  assert.ok(!existsSync(run.projectDir))

  const restarted = await restart(run.id, 'check')
  const done = await runner.waitForSettled(restarted.id, 15000)
  assert.equal(done.status, 'completed', done.error)
  assertWorking(done, 'DEMO-1')
  assert.deepEqual(brokenBeside(run), [], 'nothing was left to move aside')
  const note = done.preflight.checks.find(c => c.name === 'run worktree')
  assert.match(note?.detail ?? '', /was missing.*made again from the clone/, 'the operator sees what was done, in the restart\'s preflight')
  assert.equal(rebuiltArtifact(run).branchKept, true)
}

// ── (b) a failed run whose worktree was removed part-way ────────────────────
// What `git worktree remove` leaves when it stops on a file it cannot delete:
// some files gone, the registration in the clone gone, the `.git` file and
// whatever else it did not reach still there.
{
  const run = await finished('DEMO-2', { failFirst: true })
  const name = basename(git(run.projectDir, 'rev-parse', '--git-dir'))
  rmSync(join(run.projectDir, 'fix.txt')); rmSync(join(run.projectDir, 'A'))
  rmSync(join(clone, '.git', 'worktrees', name), { recursive: true })
  assert.ok(existsSync(join(run.projectDir, '.git')), 'the dangling .git file is still there')
  assert.throws(() => git(run.projectDir, 'status'), /not a git repository/, 'and git refuses the directory, as it did ASECRM-357\'s')

  const restarted = await restart(run.id, 'check')
  const done = await runner.waitForSettled(restarted.id, 15000)
  assert.equal(done.status, 'completed', done.error)
  assertWorking(done, 'DEMO-2')
  assert.equal(seen['DEMO-2'].checks.at(-1).plan, 'plan for DEMO-2\n', 'the old .agent/ was carried over')

  const aside = brokenBeside(run)
  assert.equal(aside.length, 1, 'what was left of the old worktree was moved aside, not deleted')
  const kept = join(dirname(run.projectDir), aside[0])
  assert.ok(existsSync(join(kept, 'lib.txt')) && existsSync(join(kept, '.agent', 'plan.md')), 'with its files')
  const art = rebuiltArtifact(run)
  assert.equal(art.movedAside, kept)
  assert.equal(art.agentCarried, true)
  assert.match(done.preflight.checks.find(c => c.name === 'run worktree')?.detail ?? '', /no longer a git checkout/)
}

// ── (c) the branch is gone too: refused, with what to do instead ────────────
{
  const run = await finished('DEMO-3')
  git(clone, 'worktree', 'remove', '--force', run.projectDir)
  git(clone, 'branch', '-D', run.branch)
  await assert.rejects(runner.restartRun(run.id, 'check'), (err) => {
    assert.equal(err.statusCode, 409)
    assert.match(err.message, /so is its branch.*Restart the run from its first step/)
    return true
  })
  // From the first step there is nothing to keep: a new branch is cut.
  const restarted = await restart(run.id, 'code')
  const done = await runner.waitForSettled(restarted.id, 15000)
  assert.equal(done.status, 'completed', done.error)
  assert.equal(git(done.projectDir, 'branch', '--show-current'), done.branch)
}

console.log('ok - a restart rebuilds a removed run worktree on its branch, moving any remains aside')
process.exit(0)
