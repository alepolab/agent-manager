/**
 * Everything a run needs that no agent should discover by spending its budget.
 *
 * Four real runs died on four such things, each after twenty to sixty minutes
 * of paid model work: a `docker-compose.<product>.yml` that did not exist in
 * the deployment repo, a Jira status the project does not have, commit signing
 * required by a mounted `~/.gitconfig` with no gpg in the image, and a hook
 * lock on a step that writes tests and code together. Every one is a question
 * answerable in under a second, before the first token.
 *
 * So this runs at start and at every restart, executes no model call, and
 * either fails the run in seconds with the exact fix or hands the run page a
 * report. A check that THROWS is reported as a failure of that check, never as
 * a crash: preflight must not become a new way for a run to die.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pipelineHooks } from './agentHooks.ts'
import { slackWebhookUrl } from './integrations.ts'
import { checkoutState } from './workspace.ts'
import { checkoutDirFor, workspaceRootFor } from './workspace.ts'
import { agentRunsRoot } from './runArtifacts.ts'
import { transitionReachable } from './jiraSteps.ts'
import { credentialsFor } from './ticketNotifier.ts'
import { agentEnvFor } from './agentCaller.ts'
import { defaultInfraDir } from './stackRecipe.ts'
import { availableApps } from './deployStep.ts'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '../../shared/types/run'

const log = createLogger('runner')
const execFileP = promisify(execFile)

export type PreflightLevel = 'ok' | 'warn' | 'fail' | 'skip'
export interface PreflightCheck { name: string, level: PreflightLevel, detail: string }
export interface PreflightReport { at: number, checks: PreflightCheck[] }

/** The steps a preflight needs to know about: which agents, and what they declare. */
export interface PreflightSteps {
  agentSlug: string
  label: string
  jira?: { transition?: string }
  testsUnlocked?: boolean
  /** This step has the runner bring the product's stack up. */
  stack?: 'up'
  /** This step drives the infra repo's deploy.sh. */
  deploy?: { env: string, step: string, app?: string }
}

/** Below this, a run is one clone or one artifacts bundle away from a full disk. */
const LOW_DISK_GB = 20

/** Free space on the filesystem holding `path`, or null when df could not say.
 *  The nearest existing ancestor is measured, because the directory a run will
 *  create does not exist yet on a fresh host — and its filesystem is the same one. */
async function freeGb(path: string): Promise<{ gb: number, usedPct: number, mount: string } | null> {
  let probe = path
  while (probe && probe !== '/' && !existsSync(probe)) probe = join(probe, '..')
  const { stdout } = await execFileP('df', ['-Pk', probe], { timeout: 10_000 })
  const line = stdout.trim().split('\n').pop() ?? ''
  const cols = line.split(/\s+/)
  const availableKb = Number(cols[3])
  if (!Number.isFinite(availableKb)) return null
  return { gb: availableKb / 1024 / 1024, usedPct: Number.parseInt(cols[4] ?? '', 10) || 0, mount: cols[5] ?? probe }
}

/** `owner/repo` from any origin URL shape, or undefined rather than a guess —
 *  a checkout with no origin cannot contradict a registry entry. */
export function repoOf(remote: string | undefined): string | undefined {
  const m = (remote ?? '').trim().match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)
  return m?.[1]
}

/** The one-line reason a run must not start, or null. */
export function preflightFailure(report: PreflightReport | undefined): string | null {
  const bad = (report?.checks ?? []).filter(c => c.level === 'fail')
  return bad.length ? bad.map(c => `${c.name} — ${c.detail}`).join('; ') : null
}

/**
 * Runs every applicable check. Never throws: a check that cannot answer its own
 * question reports `fail` with the error, which is the honest outcome.
 */
export async function runPreflight(run: WorkflowRun, steps: PreflightSteps[], fetchImpl: typeof fetch = fetch): Promise<PreflightReport> {
  const checks: PreflightCheck[] = []
  const add = (name: string, level: PreflightLevel, detail: string) => { checks.push({ name, level, detail }) }
  const guard = async (name: string, fn: () => Promise<PreflightCheck | null>) => {
    try { const c = await fn(); if (c) checks.push(c) }
    catch (err) { add(name, 'fail', `the check itself failed: ${err instanceof Error ? err.message : String(err)}`) }
  }

  const repos = run.product?.repos ?? []
  // What the STEPS declare, not who runs them. This asked for an agent named
  // `sdlc-stack-provisioner`, which no workflow in this instance has had since
  // the estate moved to the oh-my-agent agents - so every stack check below was
  // silently skipped on the two templates that do stand a stack up, and a run
  // learned its deployment compose file was missing from the stack step's own
  // failure instead of from preflight. The legacy slug is still honoured for a
  // workflow saved before the move.
  const needsStack = steps.some(s => s.stack === 'up' || s.agentSlug === 'sdlc-stack-provisioner')
  const deployStep = steps.find(s => s.deploy)
  const jiraTargets = steps.filter(s => s.jira?.transition).map(s => s.jira!.transition!)
  const unlockedStep = steps.find(s => s.testsUnlocked)

  // ── the guardrails: without them no agent may touch a product repository ──
  await guard('guardrail hooks', async () => {
    const { registered } = await pipelineHooks()
    return { name: 'guardrail hooks', level: 'ok', detail: `registered: ${[...new Set(registered)].join(', ')}` }
  })

  // ── the product, and the deployment compose file its stack step will want ──
  if (!run.product) {
    add('product', needsStack ? 'fail' : 'warn',
      needsStack
        ? 'no product in the registry matches this ticket, and this workflow stands a stack up. Add the project key or a component word, or start the run against a named product.'
        : 'no product matched; intake will work from the ticket text alone.')
  } else {
    add('product', 'ok', `${run.product.name} → ${repos.join(', ') || 'no repos listed'}`)
    const compose = run.product.stack?.compose ?? ''
    const m = /^([\w.-]+)\/([\w.-]+)$/.exec(compose)
    if (!needsStack) add('deployment compose', 'skip', 'this workflow stands no stack up')
    else if (!m) add('deployment compose', 'warn', `the registry says stack.compose is "${compose || 'not registered'}", which names no <repo>/<product>; the stack step will have to work it out.`)
    else {
      await guard('deployment compose', async () => {
        const [, repo, product] = m
        const dir = checkoutDirFor(`alepolab/${repo}`, run.startedBy)
        const file = `docker-compose.${product}.yml`
        if (!existsSync(dir)) return { name: 'deployment compose', level: 'warn', detail: `${repo} is not checked out at ${dir}; the stack step clones it, and ${file} is checked then.` }
        const state = await checkoutState(dir)
        return existsSync(join(dir, file))
          ? { name: 'deployment compose', level: 'ok', detail: `${file} present in ${repo} on ${state.branch}` }
          : { name: 'deployment compose', level: 'fail', detail: `${repo} is on branch ${state.branch} and has no ${file}. Deploying from the product's own compose is not permitted, so the stack step would halt. Add it to the deployment repo, or check out a branch that has it.` }
      })
    }
    // ── the ansible entrypoint a deploy step will drive, and the role it needs ──
    // Both are facts on disk in the infra checkout. A run that finds out at the
    // deploy step has already paid for every step before it, and deploy.sh
    // defaults its app to crm rather than to this run's product.
    if (deployStep) {
      await guard('deploy entrypoint', async () => {
        const infraDir = defaultInfraDir()
        const script = join(infraDir, 'deploy', 'ansible', 'deploy.sh')
        if (!existsSync(script)) {
          return {
            name: 'deploy entrypoint',
            level: 'warn',
            detail: `${script} is not on this host, so the ${deployStep.deploy!.env} deploy step will report that instead of deploying. Clone alepo-dev-team-infra there, or set ALEPO_INFRA_DIR.`,
          }
        }
        const apps = availableApps(infraDir)
        const app = deployStep.deploy!.app ?? run.product?.name ?? ''
        if (!apps.length) return { name: 'deploy entrypoint', level: 'ok', detail: `${script} is present; its roles could not be listed, so the app is checked when the step runs.` }
        return apps.includes(app)
          ? { name: 'deploy entrypoint', level: 'ok', detail: `${script} deploys "${app}" to ${deployStep.deploy!.env} (roles/app_${app.replace(/-/g, '_')}).` }
          : {
              name: 'deploy entrypoint',
              level: 'warn',
              detail: `this workflow deploys to ${deployStep.deploy!.env}, and the infra repo has no ansible role for "${app || 'this run\'s product'}" - it deploys: ${apps.join(', ')}. `
                + 'The deploy step will refuse rather than deploy a different product, and the rest of the run carries on.',
            }
      })
    }
    // ── the product checkout, or a token to clone it with ──
    await guard('product checkout', async () => {
      if (!repos.length) return null
      // The checkout the run was HANDED counts, before the one it would resolve
      // to. A run started against an explicit projectDir already has the repo on
      // disk; asking only about the canonical workspace path failed such a run
      // on any host that has never cloned the product — which is every fresh
      // host, and every CI runner — and told it to sign in to clone something it
      // was already sitting in.
      if (run.projectDir && existsSync(join(run.projectDir, '.git'))) {
        const s = await checkoutState(run.projectDir)
        // Handed is not the same as RIGHT. Run a3cb9d37 (CSUP-7526) was started
        // against product `infra`, resolved from one word in the ticket's
        // Environment boilerplate, and worked for 72 minutes in a devops
        // checkout while eight of its nine tasks belonged to a Selfcare
        // repository — its own output raised that as a T0 blocker and it
        // carried on. This check is the cheap half: the checkout a run was
        // handed must be a repository the product actually owns.
        const owner = repoOf(s.remote)
        if (owner && !repos.includes(owner)) {
          return {
            name: 'product checkout',
            level: 'fail',
            detail: `this run is registered against ${repos.join(', ')} but was handed a checkout of ${owner} (${run.projectDir}). `
              + 'Every commit, branch and pull request would land in the wrong repository. Re-run against the right product, or fix the registry entry.',
          }
        }
        return { name: 'product checkout', level: 'ok', detail: `${s.name} on ${s.branch}, handed to this run${s.dirty ? `, ${s.dirty} uncommitted change(s)` : ''}` }
      }
      const dir = checkoutDirFor(repos[0]!, run.startedBy)
      if (existsSync(dir)) {
        const s = await checkoutState(dir)
        return { name: 'product checkout', level: 'ok', detail: `${s.name} on ${s.branch}${s.dirty ? `, ${s.dirty} uncommitted change(s)` : ', clean'}` }
      }
      // The starter's own token counts. This used to read process.env alone and
      // told a developer whose profile holds a working GitHub token that there
      // was none — the same mistake the git-identity check made: asking the
      // server's shell a question about the environment the AGENTS get.
      // envForUser is where a run's credentials actually come from.
      const runEnv = await agentEnvFor(run.startedBy)
      const token = runEnv.AGENT_GH_TOKEN || runEnv.GH_TOKEN || runEnv.GITHUB_TOKEN
      if (token) return { name: 'product checkout', level: 'ok', detail: `${repos[0]} is not checked out yet; a token is present, so the stack step can clone it.` }

      // No token is not the same as no access, and this check used to conflate
      // them. A container with the developer's git credential store mounted
      // clones fine with no token anywhere in its environment — `gh` is
      // authenticated and git's helper answers — and a run was refused on a
      // repository it could reach, told to add a credential it already had.
      //
      // So ask git instead of guessing from the environment. `ls-remote` is the
      // cheapest question that has the real answer, and it is the same
      // authentication path the clone will take.
      const url = `https://github.com/${repos[0]}`
      try {
        await execFileP('git', ['ls-remote', url, 'HEAD'], { env: runEnv, timeout: 20_000 })
        return { name: 'product checkout', level: 'ok', detail: `${repos[0]} is not checked out yet; git can reach it with this run's credentials, so the stack step can clone it.` }
      } catch (err) {
        // git's own stderr, not just "Command failed": the reason is the whole
        // value of this check, and a credential-helper misconfiguration reads
        // nothing like a missing token. Any token-shaped string is stripped —
        // this text lands in the run record, which is not a place for one.
        const e = err as { message?: string, stderr?: string }
        const why = [e.stderr, e.message].filter(Boolean).join(' ').replace(/gh[pousr]_[A-Za-z0-9_]+/g, '<redacted>').split('\n').filter(l => l.trim()).slice(0, 3).join(' / ').slice(0, 400) || String(err)
        return { name: 'product checkout', level: 'fail', detail: `${repos[0]} is not checked out at ${dir}, and git cannot reach it with this run's credentials (${why}). Sign in on the Profile page, set AGENT_GH_TOKEN, or clone it to ${dir}.` }
      }
    })
  }

  // ── git as the AGENTS will see it: the env the runner hands them, not this shell ──
  await guard('git identity', async () => {
    const env = await agentEnvFor(run.startedBy)
    const cwd = run.projectDir && existsSync(run.projectDir) ? run.projectDir : process.cwd()
    const ident = (await execFileP('git', ['var', 'GIT_COMMITTER_IDENT'], { cwd, env, timeout: 10_000 })).stdout.trim()
    if (!ident) return { name: 'git identity', level: 'fail', detail: 'git has no committer identity; every agent commit would fail.' }
    const sign = await execFileP('git', ['config', '--get', 'commit.gpgsign'], { cwd, env, timeout: 10_000 })
      .then(r => r.stdout.trim(), () => '')
    if (sign !== 'true') return { name: 'git identity', level: 'ok', detail: `${ident.split(' <')[0]}, signing off` }
    const gpg = await execFileP('gpg', ['--version'], { timeout: 10_000 }).then(() => true, () => false)
    return gpg
      ? { name: 'git identity', level: 'warn', detail: `${ident.split(' <')[0]}, signing ON and gpg present; agents hold no key, so commits may still fail.` }
      : { name: 'git identity', level: 'fail', detail: 'commit.gpgsign is true for the agents and there is no gpg on this host: every commit would fail after the work is done. The runner forces it off through GIT_CONFIG_*; that override is not reaching git here.' }
  })

  // ── docker, and the network every deployment compose declares external ──
  if (!needsStack) add('docker', 'skip', 'this workflow stands no stack up')
  else {
    await guard('docker', async () => {
      const v = await execFileP('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 })
        .then(r => r.stdout.trim(), (e) => { throw new Error(`docker is unreachable: ${String(e.message ?? e).slice(0, 120)}`) })
      const net = await execFileP('docker', ['network', 'inspect', 'alepo-shared'], { timeout: 15_000 }).then(() => true, () => false)
      return net
        ? { name: 'docker', level: 'ok', detail: `server ${v}, alepo-shared present` }
        : { name: 'docker', level: 'warn', detail: `server ${v}, but the external network alepo-shared does not exist. Every compose file in the deployment repo declares it: docker network create --driver bridge alepo-shared` }
    })
  }

  // ── Jira: the ticket, and every status a step of this workflow will ask for ──
  if (!run.ticketKey) add('jira', 'skip', 'this run has no ticket key')
  else if (!jiraTargets.length) add('jira', 'skip', 'no step of this workflow moves the ticket')
  else {
    await guard('jira', async () => {
      await credentialsFor(run) // throws when the starter has no usable credentials
      return null
    })
    for (const target of [...new Set(jiraTargets)]) {
      await guard(`jira: ${target}`, async () => {
        const r = await transitionReachable(run, run.ticketKey!, target, fetchImpl)
        // Never fatal. Only the FIRST status is even reachable from where the
        // ticket is now — a later one is reached from wherever the run leaves
        // it, which no check before the run can know — but an unreachable
        // first status is not a reason to refuse the work either.
        //
        // It used to fail the run, and CSUP-7516 showed what that costs: a
        // billing bug with a production impact, sitting in an untriaged "New"
        // whose only transitions were "Close as invalid" and "Cancel". The run
        // died at dispatch having done nothing, because a ticket nobody had
        // triaged could not be moved to "In Progress". The fix never depended
        // on the bookkeeping, and moveTicket already treats "nothing safe to
        // move it to" as a normal outcome it reports and carries on from.
        //
        // A check that THROWS is different and still fails the run: that means
        // Jira is unreachable or the credentials are refused, and the same
        // outage may have left the run working from a bare ticket key with no
        // description at all.
        return { name: `jira: ${target}`, level: r.ok ? 'ok' : 'warn', detail: r.detail }
      })
    }
  }

  // ── a step that owns its tests needs the runner to be able to unlock them ──
  if (!unlockedStep) add('test unlock', 'skip', 'no step of this workflow writes tests and code together')
  else if (!run.projectDir) add('test unlock', 'skip', `"${unlockedStep.label}" needs .agent/ writable; there is no checkout yet, so it is checked again when the step starts.`)
  else {
    await guard('test unlock', async () => {
      const dir = join(run.projectDir!, '.agent')
      const probe = join(dir, '.preflight-probe')
      await mkdir(dir, { recursive: true })
      await writeFile(probe, '')
      await rm(probe, { force: true })
      return { name: 'test unlock', level: 'ok', detail: `.agent/ is writable in ${run.projectDir}, so "${unlockedStep.label}" can be unlocked.` }
    })
  }

  // ── the two things that stop runs and no check ever looked at ─────────────
  // Neither is ever fatal: a run on a tight disk usually finishes, and a run
  // nobody is notified about is still a run. They are `warn` because both were
  // invisible, and both were measured. The workspace held 40 GB with fourteen
  // leftover worktrees on it; the artifacts directory grows without bound and
  // nothing prunes it.
  for (const [name, path] of [['workspace disk', workspaceRootFor(run.startedBy)], ['artifacts disk', agentRunsRoot()]] as const) {
    await guard(name, async () => {
      const free = await freeGb(path)
      if (free === null) return { name, level: 'warn', detail: `df could not measure ${path}; free space on it is unknown.` }
      return free.gb < LOW_DISK_GB
        ? { name, level: 'warn', detail: `${free.gb.toFixed(1)} GB free on ${free.mount} (${path}), ${free.usedPct}% used. Runs clone repos, cut worktrees and write artifacts here; below ${LOW_DISK_GB} GB one of them will fail on a full disk.` }
        : { name, level: 'ok', detail: `${free.gb.toFixed(1)} GB free on ${free.mount} (${path}), ${free.usedPct}% used` }
    })
  }
  // A webhook can now also be stored on the settings page, so checking the
  // environment variable alone would report "unset" at an instance that is
  // configured and delivering — the same class of wrong answer, pointing the
  // other way, as the silence this check was added to expose.
  const slack = await slackWebhookUrl().catch(() => null)
  add('alerting', slack ? 'ok' : 'warn',
    slack
      ? `A Slack webhook is configured (${process.env.SLACK_WEBHOOK_URL ? 'SLACK_WEBHOOK_URL' : 'stored on the settings page'}); a pause, a failure or a red check reaches Slack.`
      : 'No Slack webhook is configured, so nothing about this run reaches Slack — a run paused on its budget waits until somebody happens to look. '
        + `Set one on the settings page under Notifications, or as SLACK_WEBHOOK_URL. Every notification is still appended to notifications.jsonl under ${agentRunsRoot()}.`)

  const report = { at: Date.now(), checks }
  const failed = checks.filter(c => c.level === 'fail').length
  const warned = checks.filter(c => c.level === 'warn').length
  log[failed ? 'warn' : 'info']('preflight', { runId: run.id, failed, warned, ok: checks.filter(c => c.level === 'ok').length })
  return report
}
