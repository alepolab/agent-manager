/**
 * Driving deploy/ansible/deploy.sh, with the dangerous environments gated.
 *
 * That script is the infra repo's one integration surface - its own header says
 * Jenkins, a person and Claude Code drive it identically - and agent-manager
 * knew nothing about it. So an agent asked to check whether dev has its fix had
 * no way to look, and an agent that decided to look would invent flags.
 *
 * The reason this is gated rather than simply wired: `--env prod` exists. A
 * local `compose down` that keeps volumes is recoverable; a deploy to a
 * carrier's environment is not. So the rule pinned here is that anything other
 * than dev must have passed a human approval gate before a single ansible
 * argument is assembled - and it is enforced where the command is built, not
 * only in the UI that hides the button.
 *
 * Nothing here runs ansible. Every argv is captured through an injected exec.
 *
 *   node scripts/test-deploy-step.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { planDeploy, runDeploy, DeployError } = await import('../server/utils/deployStep.ts')

// An infra checkout with the contract the devops repo publishes.
const infra = mkdtempSync(join(tmpdir(), 'deploy-infra-'))
mkdirSync(join(infra, 'deploy', 'ansible'), { recursive: true })
mkdirSync(join(infra, 'agent'), { recursive: true })
writeFileSync(join(infra, '.env'), 'X=1\n')
writeFileSync(join(infra, 'deploy', 'ansible', 'deploy.sh'), '#!/usr/bin/env bash\nVALID_ENVS="dev staging prod"\n')
writeFileSync(join(infra, 'agent', 'stack-contract.json'), JSON.stringify({
  contract_version: 1,
  products: {},
  not_startable: {},
  deploy: {
    entrypoint: 'deploy/ansible/deploy.sh',
    environments: ['dev', 'staging', 'prod'],
    steps: ['all', 'setup', 'deploy', 'status', 'logs', 'down'],
    dry_run_flag: '--check',
    secrets_flag: '--secrets',
  },
}, null, 2))

const script = join(infra, 'deploy', 'ansible', 'deploy.sh')

// ---- dev proceeds unattended -----------------------------------------------
// The whole point of having this at all: an agent can answer "is my fix on dev"
// without a person, because dev is cheap to get wrong.
{
  const plan = await planDeploy({ infraDir: infra, env: 'dev', step: 'status' })
  assert.equal(plan.requiresApproval, false, 'dev needs no gate')
  assert.equal(plan.command, script, 'the infra repo\'s own entrypoint is used, not an ansible-playbook line')
  assert.deepEqual(plan.args, ['--step', 'status', '--env', 'dev'], `got ${JSON.stringify(plan.args)}`)

  const calls = []
  const result = await runDeploy(plan, { approved: false, exec: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return 'ok' } })
  assert.equal(result.ok, true, 'and it runs with no approval')
  assert.equal(calls.length, 1)
  // Asserted on what was EXECUTED, not on the plan: `--yes` is added at run
  // time, so checking the plan proves nothing about the command. It is a
  // consent flag, and nobody consented to a dev status check.
  assert.ok(!/--yes/.test(calls[0]), `dev asserts no consent it was not given; ran "${calls[0]}"`)
}

// ---- staging and prod are refused without an answered gate -----------------
{
  for (const env of ['staging', 'prod']) {
    const plan = await planDeploy({ infraDir: infra, env, step: 'deploy' })
    assert.equal(plan.requiresApproval, true, `${env} requires a human`)

    const calls = []
    const result = await runDeploy(plan, { approved: false, exec: async () => { calls.push('ran'); return '' } })
    assert.equal(result.ok, false, `${env} must not run unapproved`)
    assert.equal(calls.length, 0, `and nothing is executed at all; got ${JSON.stringify(calls)}`)
    assert.match(result.summary, /approv/i, 'the reason says a gate is missing')
    assert.match(result.summary, new RegExp(env), 'and names the environment')
  }
}

// ---- an approved prod deploy runs, and says it was approved ---------------
{
  const plan = await planDeploy({ infraDir: infra, env: 'prod', step: 'deploy', secrets: '/home/x/.config/alepo-deploy/prod.yml' })
  const calls = []
  const result = await runDeploy(plan, { approved: true, approvedBy: 'sandeep', exec: async (cmd, args) => { calls.push(args.join(' ')); return 'changed=3' } })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /--step deploy/)
  assert.match(calls[0], /--env prod/)
  assert.match(calls[0], /--secrets \/home\/x\/\.config\/alepo-deploy\/prod\.yml/, 'the configured secrets path is passed, never invented')
  assert.match(calls[0], /--yes/, 'non-interactive, because a person already approved it at the gate')
  assert.match(result.summary, /sandeep/, 'the record names who approved it')
}

// ---- a dry run is a dry run ------------------------------------------------
// `--check` is ansible's own answer to "what would change", and it is the
// honest default for an agent asking about an environment it does not own.
{
  const plan = await planDeploy({ infraDir: infra, env: 'staging', step: 'deploy', check: true, secrets: '/tmp/staging.yml' })
  assert.ok(plan.args.includes('--check'), `got ${JSON.stringify(plan.args)}`)
  assert.equal(plan.requiresApproval, true, 'a staging dry run still passes the gate: it reads a production-adjacent inventory')

  const calls = []
  const result = await runDeploy(plan, { approved: true, approvedBy: 'sandeep', exec: async (_cmd, args) => { calls.push(args.join(' ')); return 'changed=0' } })
  assert.equal(result.ok, true)
  assert.ok(/--check/.test(calls[0]), 'the dry run really is a dry run')
  assert.ok(!/--yes/.test(calls[0]),
    `a dry run never claims consent it does not need; ran "${calls[0]}"`)
  assert.match(result.summary, /nothing changed/, 'and the summary says nothing changed')
}

// ---- an unknown environment or step is refused with the real list ---------
{
  await assert.rejects(
    () => planDeploy({ infraDir: infra, env: 'production', step: 'deploy' }),
    (e) => {
      assert.ok(e instanceof DeployError)
      assert.match(e.message, /dev, staging, prod/, 'the valid environments come from the contract, not from prose')
      return true
    },
    '"production" is not an environment this repo has',
  )
  await assert.rejects(
    () => planDeploy({ infraDir: infra, env: 'dev', step: 'destroy' }),
    (e) => { assert.match(e.message, /all, setup, deploy, status, logs, down/, 'and so do the valid steps'); return true },
  )
}

// ---- a non-dev deploy with no secrets configured is refused ---------------
// deploy.sh's own usage shows --secrets for prod. Inventing a path would be a
// deploy that fails after ansible has already started changing things.
{
  const plan = await planDeploy({ infraDir: infra, env: 'prod', step: 'deploy' })
  const calls = []
  const result = await runDeploy(plan, { approved: true, approvedBy: 'sandeep', exec: async () => { calls.push('ran'); return '' } })
  assert.equal(result.ok, false, 'no secrets path means no prod deploy')
  assert.equal(calls.length, 0)
  assert.match(result.summary, /secrets/i, 'and the reason names what is missing')
  assert.ok(!/--secrets/.test(JSON.stringify(plan.args)), 'no path is invented')
}

// ---- a missing infra checkout or entrypoint says so ----------------------
{
  await assert.rejects(
    () => planDeploy({ infraDir: join(infra, 'nope'), env: 'dev', step: 'status' }),
    (e) => { assert.match(e.message, /infra/i); return true },
  )
  const noScript = mkdtempSync(join(tmpdir(), 'deploy-noscript-'))
  await assert.rejects(
    () => planDeploy({ infraDir: noScript, env: 'dev', step: 'status' }),
    (e) => { assert.match(e.message, /deploy\.sh/, 'the missing entrypoint is named'); return true },
  )
  rmSync(noScript, { recursive: true, force: true })
}

// ---- the environments fall back to deploy.sh when there is no contract ----
{
  const noContract = mkdtempSync(join(tmpdir(), 'deploy-nocontract-'))
  mkdirSync(join(noContract, 'deploy', 'ansible'), { recursive: true })
  writeFileSync(join(noContract, 'deploy', 'ansible', 'deploy.sh'), '#!/usr/bin/env bash\nVALID_ENVS="dev prod"\n')
  const plan = await planDeploy({ infraDir: noContract, env: 'prod', step: 'status' })
  assert.equal(plan.requiresApproval, true)
  await assert.rejects(
    () => planDeploy({ infraDir: noContract, env: 'staging', step: 'status' }),
    (e) => { assert.match(e.message, /dev, prod/, 'read from the script itself, so a checkout without the contract still works'); return true },
  )
  rmSync(noContract, { recursive: true, force: true })
}

// ---- the application is named, or nothing is deployed --------------------
// deploy.sh defaults APP to crm when it is given none. That default is safe for
// a person who knows they omitted it and catastrophic for a run that did: a
// PCRF ticket's deploy step would deploy CRM and report success.
{
  const withRoles = mkdtempSync(join(tmpdir(), 'deploy-roles-'))
  mkdirSync(join(withRoles, 'deploy', 'ansible', 'roles', 'app_crm'), { recursive: true })
  mkdirSync(join(withRoles, 'deploy', 'ansible', 'roles', 'app_pcrf_server'), { recursive: true })
  mkdirSync(join(withRoles, 'deploy', 'ansible', 'roles', 'preflight'), { recursive: true })
  writeFileSync(join(withRoles, 'deploy', 'ansible', 'deploy.sh'), '#!/usr/bin/env bash\nVALID_ENVS="dev staging prod"\nVALID_STEPS="all setup deploy status logs down"\n')

  await assert.rejects(
    () => planDeploy({ infraDir: withRoles, env: 'dev', step: 'deploy' }),
    (e) => {
      assert.ok(e instanceof DeployError)
      assert.match(e.message, /crm, pcrf-server/, 'the refusal lists what this checkout can deploy')
      return true
    },
    'an unnamed app must be refused rather than silently defaulted',
  )

  await assert.rejects(
    () => planDeploy({ infraDir: withRoles, env: 'dev', step: 'deploy', app: 'billing' }),
    (e) => { assert.match(e.message, /roles\/app_billing/, 'and names the role that would have to exist'); return true },
    'an app with no ansible role is refused',
  )

  // The roles directory IS the list, spelled the way the flag spells it.
  const plan = await planDeploy({ infraDir: withRoles, env: 'dev', step: 'deploy', app: 'pcrf-server' })
  assert.ok(plan.args.includes('--app'), `got ${JSON.stringify(plan.args)}`)
  assert.equal(plan.args[plan.args.indexOf('--app') + 1], 'pcrf-server')

  rmSync(withRoles, { recursive: true, force: true })
}

rmSync(infra, { recursive: true, force: true })
console.log('deploy step: dev runs unattended, staging and prod need an answered gate, the app is named or refused, and no path or flag is invented')
