#!/usr/bin/env node
/**
 * The runner owns a run's environment; this proves the guard says so in the one
 * place an agent could act otherwise.
 *
 * The line it draws is exact, and both sides of it matter:
 *
 *  - A stack an agent starts is unlabelled (the reaper removes only what the
 *    runner marked with the run id), unordered (the init/liquibase/stack
 *    sequence comes from the infra repo's contract) and unrecorded (nothing
 *    writes stack-facts.json for it). A `down -v` typed by hand costs hours of
 *    seeded data.
 *  - A BUILD inside the stack is the opposite: `docker compose run --rm crm
 *    gradle build` is exactly what the pull-request gate now demands, so a
 *    guard that denied it would deny the rule it serves. Reads must stay open
 *    for the same reason - an agent that cannot run `docker compose ps` cannot
 *    answer "is it up" and will reach for `up` instead.
 *
 *   node engineering/scripts/test-stack-guard.mjs
 */
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { denyReason } = await import(join(root, 'hooks', 'stack-guard.mjs'))

const bash = command => ({ tool_name: 'Bash', tool_input: { command } })

// ── denied: anything that changes what is running ───────────────────────────
for (const cmd of [
  'docker compose -f docker-compose.crm.yml --profile crm-stack --env-file .env up -d',
  'docker compose -f docker-compose.crm.yml down',
  'docker-compose -f docker-compose.pms.yml up',
  'docker compose -f x.yml restart crm',
  'podman compose -f x.yml stop crm',
  'cd ~/alepo-workspace/alepo-dev-team-infra && ./deploy/ansible/deploy.sh --step deploy --env dev',
  'ansible-playbook deploy/ansible/site.yml --limit dev',
]) {
  const reason = denyReason(bash(cmd))
  assert.ok(reason, `must be denied: ${cmd}`)
  assert.ok(/runner|gate/i.test(reason), `the refusal must say who owns it: ${reason}`)
}

// The destructive one names the data it protects.
assert.match(denyReason(bash('docker compose -f x.yml down -v')), /volume/i,
  'a teardown refusal must name the seeded data it is protecting')

// ── allowed: reading, and building inside the stack ─────────────────────────
for (const cmd of [
  'docker compose -f docker-compose.crm.yml ps',
  'docker compose -f docker-compose.crm.yml logs --tail 50 crm',
  'docker compose -f docker-compose.crm.yml config --no-interpolate',
  'docker ps',
  'docker inspect crm',
  // The container build the PR gate asks for. Denying these would deny the rule.
  'docker compose -f docker-compose.crm.yml run --rm crm gradle build',
  'docker compose -f docker-compose.crm.yml exec crm mvn -B test',
  'docker compose -f docker-compose.crm.yml build crm',
  'docker build -t crm:test .',
  'docker run --rm -v "$PWD":/w -w /w maven:3-eclipse-temurin-11 mvn -B verify',
  'agent-browser open http://localhost:8081',
  'git status',
]) {
  assert.equal(denyReason(bash(cmd)), null, `must be allowed: ${cmd}`)
}

// ── a flag's value is not a verb ────────────────────────────────────────────
// `--profile up-something` or a file called `down.yml` must not be read as the
// verb; only the first non-flag word after `compose` is.
assert.equal(denyReason(bash('docker compose -f down.yml ps')), null,
  'a file named down.yml is not a teardown')

// ── only Bash is judged ─────────────────────────────────────────────────────
assert.equal(denyReason({ tool_name: 'Read', tool_input: { file_path: '/infra/docker-compose.crm.yml' } }), null,
  'reading a compose file is how a step learns what the stack is')
assert.equal(denyReason({ tool_name: 'Bash', tool_input: {} }), null, 'an empty command denies nothing')

console.log('stack guard: the runner owns compose up/down and deploy.sh; reads and in-container builds stay open')
