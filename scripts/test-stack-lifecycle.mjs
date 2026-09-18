/**
 * Bringing a product's stack up and taking it down, without an agent inventing
 * how.
 *
 * Today the runner tells an agent one thing - "Stack: alepo-dev-team-infra/crm
 * (1node)" - and leaves it to work out the rest: which compose file, which
 * profile, whether an -init stage runs first, whether liquibase is a separate
 * up, which --env-file, and whether anything ever tears down. Nothing owned
 * termination, so a stack left running quietly ate the box.
 *
 * The infra repo already encodes the answer. Every product's compose file
 * declares its own profiles - `<p>-stack`, `<p>-init`, `<p>-liquibase` and the
 * liquibase ops variants - so the lifecycle is READ from the file rather than
 * kept as a table here. That distinction is the whole design: a product whose
 * compose file gains a stage is supported with no change to agent-manager, and
 * a product missing one says so instead of having a command invented for it.
 *
 * Two rules the user set, pinned here because both destroy things if wrong:
 *  - TEARDOWN NEVER REMOVES VOLUMES. `down`, never `down -v`. Seeded data
 *    survives a run; nothing gets a clean database by accident.
 *  - THE .env IS READ, NEVER WRITTEN. One file at the infra root, generated
 *    once by a human running setup.sh interactively.
 *
 * No docker runs here. Every command is captured through an injected exec.
 *
 *   node scripts/test-stack-lifecycle.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { resolveStackRecipe, StackError } = await import('../server/utils/stackRecipe.ts')
const { stackUp, stackDown } = await import('../server/utils/stackLifecycle.ts')

// A fake infra checkout: the shape the real one has, small enough to reason about.
const infra = mkdtempSync(join(tmpdir(), 'infra-'))
writeFileSync(join(infra, '.env'), 'CRM_TAG=1.0.0\n')
writeFileSync(join(infra, 'docker-compose.foo.yml'), `services:
  foo-app:
    image: example/foo
    profiles: [foo-stack]
  foo-init:
    image: example/init
    profiles: [foo-init]
  foo-liquibase:
    image: example/liquibase
    profiles: [foo-liquibase]
  foo-liquibase-rollback:
    image: example/liquibase
    profiles: [foo-liquibase-rollback]
`)
// A product with no init and no migrations: two of the three stages absent.
writeFileSync(join(infra, 'docker-compose.bare.yml'), `services:
  bare-app:
    image: example/bare
    profiles: [bare-stack]
`)

// ---- the recipe is READ from the compose file, not assumed ------------------
{
  const r = await resolveStackRecipe({ infraDir: infra, compose: 'alepo-dev-team-infra/foo' })
  assert.equal(r.product, 'foo')
  assert.equal(r.composeFile, 'docker-compose.foo.yml', 'the registry reference becomes the real filename')
  assert.equal(r.envFile, join(infra, '.env'))
  assert.deepEqual(r.stages.map(s => s.profile), ['foo-init', 'foo-liquibase', 'foo-stack'],
    `init, then migrations, then the services; got ${JSON.stringify(r.stages.map(s => s.profile))}`)
  // The ops variants exist in the file and are deliberately NOT part of `up`:
  // a rollback is an operator's decision, never a side effect of starting.
  assert.ok(!r.stages.some(s => /rollback|dryrun/.test(s.profile)), 'rollback and dry-run are never part of bringing a stack up')
  assert.ok(r.profilesDeclared.includes('foo-liquibase-rollback'), 'but they are reported, so a caller knows they exist')
}

// ---- a product missing stages gets the stages it has, not invented ones ----
{
  const r = await resolveStackRecipe({ infraDir: infra, compose: 'alepo-dev-team-infra/bare' })
  assert.deepEqual(r.stages.map(s => s.profile), ['bare-stack'],
    'no init and no liquibase means neither is run, rather than a command being made up')
  assert.deepEqual(r.missingStages, ['init', 'liquibase'], 'and the absence is reported')
}

// ---- honest failures, never a silent success -------------------------------
{
  await assert.rejects(
    () => resolveStackRecipe({ infraDir: infra, compose: 'alepo-dev-team-infra/nope' }),
    (e) => {
      assert.ok(e instanceof StackError)
      assert.match(e.message, /docker-compose\.nope\.yml/, 'the message names the file it looked for')
      return true
    },
    'a product with no compose file in the infra repo is an error',
  )
  await assert.rejects(
    () => resolveStackRecipe({ infraDir: join(infra, 'does-not-exist'), compose: 'alepo-dev-team-infra/foo' }),
    (e) => { assert.match(e.message, /infra/i, 'a missing infra checkout says so'); return true },
  )
  const noEnv = mkdtempSync(join(tmpdir(), 'infra-noenv-'))
  writeFileSync(join(noEnv, 'docker-compose.foo.yml'), 'services:\n  a:\n    image: x\n    profiles: [foo-stack]\n')
  await assert.rejects(
    () => resolveStackRecipe({ infraDir: noEnv, compose: 'alepo-dev-team-infra/foo' }),
    (e) => { assert.match(e.message, /\.env/, 'a missing .env is named, because setup.sh is a human job'); return true },
  )
  rmSync(noEnv, { recursive: true, force: true })
}

// ---- up: the documented command shape, in order ----------------------------
{
  const calls = []
  const exec = async (cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); return '' }
  const recipe = await resolveStackRecipe({ infraDir: infra, compose: 'alepo-dev-team-infra/foo' })
  const result = await stackUp(recipe, { exec })

  assert.equal(calls.length, 3, `one command per stage; got ${JSON.stringify(calls)}`)
  // Exactly the shape the infra repo documents for itself
  // (docs/crm-installation-guide.md:243 and README.md:267) - flag order and
  // all. An invented flag is how this breaks on a real box: the first draft of
  // this test expected `--abort-on-container-failure`, which compose does not
  // even have.
  const f = join(infra, 'docker-compose.foo.yml')
  const env = join(infra, '.env')
  assert.deepEqual(calls, [
    `docker compose -f ${f} --profile foo-init --env-file ${env} up`,
    `docker compose -f ${f} --profile foo-liquibase --env-file ${env} up`,
    `docker compose -f ${f} --profile foo-stack --env-file ${env} up -d`,
  ], 'the one-shot stages run in the foreground and only the services detach')
  assert.equal(result.ok, true)
  assert.match(result.summary, /foo/, 'the summary names the stack it started')
}

// ---- down: never -v, no matter what ---------------------------------------
{
  const calls = []
  const exec = async (cmd, args) => { calls.push(args.join(' ')); return '' }
  const recipe = await resolveStackRecipe({ infraDir: infra, compose: 'alepo-dev-team-infra/foo' })
  const result = await stackDown(recipe, { exec })

  assert.equal(calls.length, 1, 'one command takes the whole stack down')
  assert.match(calls[0], /down/)
  assert.ok(!/ -v|--volumes/.test(calls[0]),
    `teardown must never remove volumes - seeded data survives a run; command was "${calls[0]}"`)
  // Every profile, or compose leaves the one-shot containers behind.
  for (const p of ['foo-init', 'foo-liquibase', 'foo-stack']) {
    assert.match(calls[0], new RegExp(`--profile ${p}`), `${p} is included, or its containers are orphaned`)
  }
  assert.equal(result.ok, true)
}

// ---- a failing stage stops the sequence and says which one -----------------
{
  const calls = []
  const exec = async (cmd, args) => {
    calls.push(args.join(' '))
    if (args.includes('foo-liquibase')) throw new Error('liquibase exited 1: changeset checksum mismatch')
    return ''
  }
  const recipe = await resolveStackRecipe({ infraDir: infra, compose: 'alepo-dev-team-infra/foo' })
  const result = await stackUp(recipe, { exec })
  assert.equal(result.ok, false)
  assert.match(result.summary, /foo-liquibase/, 'the failing stage is named')
  assert.match(result.summary, /checksum mismatch/, 'and the real error is carried, not swallowed')
  assert.ok(!calls.some(c => c.includes('foo-stack')),
    'the services are NOT started after migrations failed - a stack on a half-migrated database is worse than none')
}

// ---- against the REAL infra repo, read-only --------------------------------
// Proves it reads rather than assumes. Skipped where the checkout is absent
// (CI), and the skip is reported rather than silently passing.
{
  const real = '/home/sandeep/alepo-workspace/alepo-dev-team-infra'
  if (!existsSync(join(real, 'docker-compose.crm.yml'))) {
    console.log('  (skipped: the real infra checkout is not on this machine)')
  } else {
    const r = await resolveStackRecipe({ infraDir: real, compose: 'alepo-dev-team-infra/crm' })
    assert.equal(r.composeFile, 'docker-compose.crm.yml')
    for (const p of ['crm-init', 'crm-liquibase', 'crm-stack']) {
      assert.ok(r.profilesDeclared.includes(p), `the real CRM compose declares ${p}`)
    }
    assert.deepEqual(r.stages.map(s => s.profile), ['crm-init', 'crm-liquibase', 'crm-stack'],
      'and the real lifecycle comes out in the documented order')
    assert.ok(r.profilesDeclared.includes('crm-liquibase-rollback'), 'including the ops profiles it reports but never runs')
  }
}

rmSync(infra, { recursive: true, force: true })
console.log('stack lifecycle: the recipe is read from the compose file, and teardown never removes volumes')
