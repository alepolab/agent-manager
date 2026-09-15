/**
 * Everything a run needs that no agent should discover by spending its budget.
 *
 * Four real runs died on four such things — a missing docker-compose.<product>.yml,
 * a Jira status the project does not have, commit signing with no gpg, a hook lock
 * on a step that writes tests and code together — each after twenty to sixty
 * minutes of paid model work. Every one is answerable in under a second.
 *
 *   node scripts/test-preflight.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'preflight-'))
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_WORKSPACE_ROOT = join(root, 'ws')
process.env.AGENT_RUNS_DIR = join(root, 'runs')
process.env.JIRA_BASE_URL = 'https://jira.test'
process.env.JIRA_EMAIL = 'dev@example.test'
process.env.JIRA_API_TOKEN = 'not-a-real-token'
mkdirSync(process.env.CLAUDE_DIR, { recursive: true })

const { runPreflight, preflightFailure } = await import('../server/utils/preflight.ts')

const git = (cwd, args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
const repo = (path, branch = 'develop') => {
  mkdirSync(path, { recursive: true })
  git(path, ['init', '--quiet', '-b', branch]); git(path, ['config', 'user.email', 't@x']); git(path, ['config', 'user.name', 't'])
  writeFileSync(join(path, 'a.txt'), 'a\n'); git(path, ['add', '.']); git(path, ['commit', '--quiet', '-m', 'init'])
  return path
}
const run = (over = {}) => ({ id: 'run-1', status: 'running', workflowName: 'Runbook C', workflowSlug: 'runbook-c', watch: 'direct-invocation', steps: [], startedAt: Date.now(), budget: { maxMinutes: 1, maxTokens: 1 }, ...over })
const of = (report, name) => report.checks.find(c => c.name === name)
const stackStep = { agentSlug: 'sdlc-stack-provisioner', label: 'Stand Up Stack' }
const product = (over = {}) => ({ name: 'pms', repos: ['alepolab/pms'], branches: { bug: 'develop' }, tests: {}, stack: { compose: 'alepo-dev-team-infra/pms', topology_default: '1node' }, ...over })

// ── 1. a workflow that needs nothing: every optional check declares itself skipped, and nothing fails ──
{
  const r = await runPreflight(run(), [{ agentSlug: 'sdlc-ticket-intake', label: 'Ticket Intake' }])
  assert.equal(preflightFailure(r), null, JSON.stringify(r.checks))
  assert.equal(of(r, 'guardrail hooks').level, 'ok', 'the guardrails are registered on this instance')
  for (const name of ['docker', 'jira', 'test unlock']) {
    assert.equal(of(r, name).level, 'skip', `${name} says why it did not run: ${of(r, name)?.detail}`)
  }
  assert.equal(of(r, 'product').level, 'warn', 'no product is a warning when nothing stands a stack up')
}

// ── 2. the run that actually happened: a stack step, and no compose file for this product ──
{
  const infra = repo(join(process.env.AGENT_WORKSPACE_ROOT, 'alepo-dev-team-infra'), 'main')
  writeFileSync(join(infra, 'docker-compose.selfcare.yml'), '# LUM selfcare, a different product\n')
  repo(join(process.env.AGENT_WORKSPACE_ROOT, 'pms'))
  const r = await runPreflight(run({ product: product() }), [stackStep])
  const c = of(r, 'deployment compose')
  assert.equal(c.level, 'fail', JSON.stringify(c))
  assert.match(c.detail, /docker-compose\.pms\.yml/, 'the message names the file that is missing')
  assert.match(c.detail, /on branch main/, 'and the branch it looked on, because a checkout on the wrong branch is the usual cause')
  assert.match(preflightFailure(r), /deployment compose/, 'and the run would not start')

  // present: the same check passes and names the branch
  writeFileSync(join(infra, 'docker-compose.pms.yml'), 'name: pms\n')
  const ok = await runPreflight(run({ product: product() }), [stackStep])
  assert.equal(of(ok, 'deployment compose').level, 'ok', JSON.stringify(of(ok, 'deployment compose')))
  assert.equal(of(ok, 'product checkout').level, 'ok')
  assert.match(of(ok, 'product checkout').detail, /pms on develop/)
}

// ── 3. no product at all, but the workflow stands a stack up: fail, do not guess ──
{
  const r = await runPreflight(run(), [stackStep])
  assert.equal(of(r, 'product').level, 'fail', JSON.stringify(of(r, 'product')))
  assert.match(of(r, 'product').detail, /Add the project key/, 'the message says what a person can do about it')
}

// ── 4. git as the AGENTS see it, not as this shell sees it ──
{
  // The runner forces commit.gpgsign=false through GIT_CONFIG_*; a checkout whose
  // own config demands signing must therefore still pass, because the agents' env wins.
  const signed = repo(join(root, 'signed'))
  git(signed, ['config', 'commit.gpgsign', 'true'])
  const r = await runPreflight(run({ projectDir: signed }), [{ agentSlug: 'sdlc-ce-work', label: 'Implement Fix' }])
  const c = of(r, 'git identity')
  assert.equal(c.level, 'ok', `the agents' environment overrides a signing checkout: ${JSON.stringify(c)}`)
  assert.match(c.detail, /signing off/)
}

// ── 5. Jira: the first status must be reachable now; a later one is only a warning ──
{
  const transitions = { transitions: [{ id: '11', name: 'Start progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }] }
  const jira = async (url) => {
    const u = String(url)
    if (u.endsWith('?fields=status')) return new Response(JSON.stringify({ fields: { status: { name: 'Open', statusCategory: { key: 'new' } } } }), { status: 200 })
    if (u.endsWith('/transitions')) return new Response(JSON.stringify(transitions), { status: 200 })
    return new Response('{}', { status: 200 })
  }
  const steps = [
    { agentSlug: 'sdlc-jira-tracker', label: 'Jira: In Progress', jira: { transition: 'In Progress' } },
    { agentSlug: 'sdlc-jira-tracker', label: 'Jira: Dev Done', jira: { transition: 'Dev Done' } },
  ]
  const r = await runPreflight(run({ ticketKey: 'SCN-658' }), steps, jira)
  assert.equal(of(r, 'jira: In Progress').level, 'ok', JSON.stringify(of(r, 'jira: In Progress')))
  assert.equal(of(r, 'jira: Dev Done').level, 'warn',
    'a later status is reached from wherever the run leaves the ticket, which no check before the run can know')
  assert.equal(preflightFailure(r), null, 'so a later status never blocks the run')

  // The SCN-658 shape: the first status is not reachable and has no synonym or category match.
  const stuck = { transitions: [{ id: '1', name: 'Close', to: { name: 'Closed', statusCategory: { key: 'done' } } }] }
  const jira2 = async (url) => String(url).endsWith('?fields=status')
    ? new Response(JSON.stringify({ fields: { status: { name: 'Submitted', statusCategory: { key: 'new' } } } }), { status: 200 })
    : new Response(JSON.stringify(stuck), { status: 200 })
  const bad = await runPreflight(run({ ticketKey: 'SCN-658' }), steps, jira2)
  assert.equal(of(bad, 'jira: In Progress').level, 'fail')
  assert.match(of(bad, 'jira: In Progress').detail, /Submitted.*Closed/s, 'naming where the ticket is and what it offers')
}

// ── 6. a step that owns its tests needs .agent/ writable, and says so before it runs ──
{
  const ok = repo(join(root, 'unlockable'))
  const r = await runPreflight(run({ projectDir: ok }), [{ agentSlug: 'sdlc-ce-work', label: 'Implement Fix', testsUnlocked: true }])
  assert.equal(of(r, 'test unlock').level, 'ok', JSON.stringify(of(r, 'test unlock')))

  const locked = repo(join(root, 'readonly'))
  chmodSync(locked, 0o555)
  try {
    const bad = await runPreflight(run({ projectDir: locked }), [{ agentSlug: 'sdlc-ce-work', label: 'Implement Fix', testsUnlocked: true }])
    assert.equal(of(bad, 'test unlock').level, 'fail', JSON.stringify(of(bad, 'test unlock')))
  } finally { chmodSync(locked, 0o755) }
}

// ── 7. a check that throws is that check failing, never the preflight crashing ──
{
  const exploding = async () => { throw new Error('jira is down') }
  const r = await runPreflight(run({ ticketKey: 'X-1' }), [{ agentSlug: 'sdlc-jira-tracker', label: 'Jira', jira: { transition: 'In Progress' } }], exploding)
  assert.equal(of(r, 'jira: In Progress').level, 'fail')
  assert.match(of(r, 'jira: In Progress').detail, /the check itself failed: jira is down/)
}

// ── 8. a host with no git identity of its own still passes: the run's identity
//      comes from the env the agents get, not from ~/.gitconfig ──────────────
// This is the shape of the bug that made CI red for a day: preflight asked
// `git var GIT_COMMITTER_IDENT` in an environment missing the identity every
// agent is handed, so every run on a runner (or any fresh container) died
// before an agent started. It passes on a developer's machine either way,
// which is why it needs forcing here rather than being left to the suite.
{
  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM }
  const bare = mkdtempSync(join(tmpdir(), 'preflight-nohome-'))
  process.env.HOME = bare
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  try {
    const r = await runPreflight(run(), [{ agentSlug: 'sdlc-ticket-intake', label: 'Ticket Intake' }])
    assert.equal(of(r, 'git identity').level, 'ok', JSON.stringify(of(r, 'git identity')))
    assert.ok(!preflightFailure(r), `a host without a global gitconfig must not fail the run: ${preflightFailure(r)}`)
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(bare, { recursive: true, force: true })
  }
}

// ── 9. the checkout the run was handed satisfies the product check ───────────
// Preflight used to look only at the canonical workspace path, so a run given
// an explicit projectDir was failed for "not checked out" and told to sign in
// to clone the repo it was already sitting in.
{
  const handed = repo(join(root, 'handed-checkout'))
  const r = await runPreflight(run({ projectDir: handed, product: product() }), [stackStep])
  assert.equal(of(r, 'product checkout').level, 'ok', JSON.stringify(of(r, 'product checkout')))
  assert.match(of(r, 'product checkout').detail, /handed to this run/)
}

rmSync(root, { recursive: true, force: true })
console.log('preflight: the four things that killed real runs are caught before any agent starts')
