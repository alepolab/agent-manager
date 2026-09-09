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
import { checkoutState } from './workspace.ts'
import { checkoutDirFor } from './workspace.ts'
import { transitionReachable } from './jiraSteps.ts'
import { credentialsFor } from './ticketNotifier.ts'
import { agentEnvFor } from './agentCaller.ts'
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
  const needsStack = steps.some(s => s.agentSlug === 'sdlc-stack-provisioner')
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
    // ── the product checkout, or a token to clone it with ──
    await guard('product checkout', async () => {
      if (!repos.length) return null
      const dir = checkoutDirFor(repos[0]!, run.startedBy)
      if (existsSync(dir)) {
        const s = await checkoutState(dir)
        return { name: 'product checkout', level: 'ok', detail: `${s.name} on ${s.branch}${s.dirty ? `, ${s.dirty} uncommitted change(s)` : ', clean'}` }
      }
      const token = process.env.AGENT_GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
      return token
        ? { name: 'product checkout', level: 'ok', detail: `${repos[0]} is not checked out yet; a token is present, so the stack step can clone it.` }
        : { name: 'product checkout', level: 'fail', detail: `${repos[0]} is not checked out at ${dir} and no GitHub token is available to clone it. Sign in with GitHub, or set AGENT_GH_TOKEN.` }
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
        // Only the FIRST status is reachable from where the ticket is now; a
        // later one is reached from wherever the run leaves it, which no check
        // before the run can know. So a later target that does not match is a
        // warning, and the run decides at the step.
        const first = jiraTargets[0] === target
        return { name: `jira: ${target}`, level: r.ok ? 'ok' : first ? 'fail' : 'warn', detail: r.detail }
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

  const report = { at: Date.now(), checks }
  const failed = checks.filter(c => c.level === 'fail').length
  const warned = checks.filter(c => c.level === 'warn').length
  log[failed ? 'warn' : 'info']('preflight', { runId: run.id, failed, warned, ok: checks.filter(c => c.level === 'ok').length })
  return report
}
