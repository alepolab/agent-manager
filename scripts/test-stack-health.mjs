/**
 * "docker compose up exited zero" is not "the stack is serving".
 *
 * This suite pins the difference. A stack whose services are restarting, whose
 * liquibase stage exited non-zero, or which docker reports no containers for at
 * all, must come back as UNVERIFIED with the failing service named - not as a
 * cheerful summary a later step will test nothing against.
 *
 * The second property is the address. A visual step needs somewhere to open,
 * and the only honest sources are the ports docker published and the entry
 * points the registry names. A service on the host network publishes neither,
 * and this file asserts that case produces a sentence rather than a guessed
 * localhost:8080.
 *
 * No docker daemon, no network, no timers: exec, sleep, clock and fetch are all
 * injected, so the poll loop is driven deterministically rather than waited on.
 *
 *   node scripts/test-stack-health.mjs
 */
import assert from 'node:assert/strict'

const { verifyStack, readStackStatus, parseStatus } = await import('../server/utils/stackHealth.ts')

const recipe = {
  product: 'foo',
  infraDir: '/infra',
  composeFile: 'docker-compose.foo.yml',
  composePath: '/infra/docker-compose.foo.yml',
  envFile: '/infra/.env',
  profilesDeclared: ['foo-init', 'foo-liquibase', 'foo-stack'],
  stages: [
    { kind: 'init', profile: 'foo-init', detach: false },
    { kind: 'liquibase', profile: 'foo-liquibase', detach: false },
    { kind: 'stack', profile: 'foo-stack', detach: true },
  ],
  missingStages: [],
  unorderedSetupProfiles: [],
  source: 'contract',
}

const row = (o) => JSON.stringify(o)
const noFetch = async () => ({ status: 200 })
const noSleep = async () => {}

// ---- the status read names the same project the `up` did --------------------
// A `ps` with different -f/--env-file/profiles resolves a DIFFERENT compose
// project and reports an empty stack exactly as confidently as a broken one.
{
  const calls = []
  await readStackStatus(recipe, {
    runId: 'run-1',
    exec: async (cmd, args, env) => { calls.push({ cmd, args, env }); return '' },
  })
  assert.equal(calls.length, 1)
  const { args, env } = calls[0]
  assert.deepEqual(args.slice(0, 5), ['compose', '-f', recipe.composePath, '--env-file', recipe.envFile])
  for (const stage of recipe.stages) {
    assert.ok(args.includes(stage.profile), `every profile the up used must be named: ${stage.profile}`)
  }
  assert.deepEqual(args.slice(-3), ['ps', '--all', '--format', 'json'].slice(1), `got ${JSON.stringify(args)}`)
  assert.ok(env && Object.values(env).includes('run-1'), 'the run id goes to docker exactly as it did for the up')
}

// ---- warnings on stdout are not services ------------------------------------
// Compose writes variable-not-set warnings around its own output; a parser that
// treats one as a container reports a stack that does not exist.
{
  const parsed = parseStatus([
    'time="..." level=warning msg="The \\"X\\" variable is not set."',
    row({ Service: 'foo-app', State: 'running', Health: 'healthy', Publishers: [{ URL: '0.0.0.0', TargetPort: 8080, PublishedPort: 8081, Protocol: 'tcp' }] }),
  ].join('\n'))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].service, 'foo-app')
  assert.deepEqual(parsed[0].publishers, [{ host: '0.0.0.0', published: 8081, target: 8080, protocol: 'tcp' }])
}

// ---- a healthy stack reports where it answers -------------------------------
{
  const facts = await verifyStack(recipe, {
    fetchLike: noFetch,
    sleep: noSleep,
    exec: async () => [
      row({ Service: 'foo-init', State: 'exited', ExitCode: 0 }),
      row({ Service: 'foo-app', State: 'running', Health: 'healthy', Publishers: [{ URL: '0.0.0.0', TargetPort: 8080, PublishedPort: 8081, Protocol: 'tcp' }] }),
    ].join('\n'),
  })
  assert.equal(facts.healthy, true, facts.summary)
  assert.deepEqual(facts.endpoints, ['http://localhost:8081'])
  assert.ok(/8081/.test(facts.summary), `the summary must carry the address: ${facts.summary}`)
  assert.equal(facts.probes.length, 1, 'a published address is probed')
  assert.equal(facts.probes[0].status, 200)
}

// ---- a one-shot stage that failed is a fault, not a finished stage ----------
{
  const facts = await verifyStack(recipe, {
    fetchLike: noFetch,
    sleep: noSleep,
    exec: async () => [
      row({ Service: 'foo-liquibase', State: 'exited', ExitCode: 1 }),
      row({ Service: 'foo-app', State: 'running', Health: 'healthy', Publishers: [] }),
    ].join('\n'),
  })
  assert.equal(facts.healthy, false, 'a migration that exited non-zero cannot pass as a completed stage')
  assert.ok(/foo-liquibase/.test(facts.summary), facts.summary)
  assert.ok(/exit 1/.test(facts.summary), facts.summary)
}

// ---- no published port is said, never guessed -------------------------------
// The CRM stack runs on the host network: compose publishes nothing for it, and
// a derived localhost address would be an invention.
{
  const facts = await verifyStack(recipe, {
    fetchLike: noFetch,
    sleep: noSleep,
    exec: async () => row({ Service: 'foo-app', State: 'running', Health: 'healthy', Publishers: [] }),
  })
  assert.equal(facts.healthy, true)
  assert.deepEqual(facts.endpoints, [])
  assert.ok(/host network/i.test(facts.summary), `got: ${facts.summary}`)
  assert.equal(facts.probes.length, 0, 'nothing to probe means nothing probed')
}

// ---- the registry's own entry points win and are passed through unchanged ---
{
  const facts = await verifyStack(recipe, {
    urls: ['http://localhost:8080/lbss'],
    fetchLike: noFetch,
    sleep: noSleep,
    exec: async () => row({ Service: 'foo-app', State: 'running', Health: 'healthy', Publishers: [] }),
  })
  assert.deepEqual(facts.registryUrls, ['http://localhost:8080/lbss'])
  assert.ok(/lbss/.test(facts.summary), facts.summary)
}

// ---- a starting service is waited for, on a bounded clock -------------------
{
  const states = [
    row({ Service: 'foo-app', State: 'running', Health: 'starting', Publishers: [] }),
    row({ Service: 'foo-app', State: 'running', Health: 'starting', Publishers: [] }),
    row({ Service: 'foo-app', State: 'running', Health: 'healthy', Publishers: [] }),
  ]
  let clock = 0
  const slept = []
  const facts = await verifyStack(recipe, {
    fetchLike: noFetch,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms },
    pollMs: 1000,
    deadlineMs: 60_000,
    exec: async () => states.shift() ?? states[states.length - 1],
  })
  assert.equal(facts.healthy, true, facts.summary)
  assert.deepEqual(slept, [1000, 1000], 'it polled rather than slept a fixed time')
  assert.equal(facts.waitedMs, 2000)
}

// ---- a stack that never settles gives up and says so ------------------------
{
  let clock = 0
  const facts = await verifyStack(recipe, {
    fetchLike: noFetch,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    pollMs: 1000,
    deadlineMs: 3000,
    exec: async () => row({ Service: 'foo-app', State: 'restarting', Publishers: [] }),
  })
  assert.equal(facts.healthy, false)
  assert.ok(facts.waitedMs >= 3000, 'the wait is bounded by the deadline')
  assert.ok(/restarting/.test(facts.summary), facts.summary)
}

// ---- docker itself unreachable: nothing is claimed --------------------------
{
  const facts = await verifyStack(recipe, {
    fetchLike: noFetch,
    sleep: noSleep,
    exec: async () => { throw new Error('Cannot connect to the Docker daemon') },
  })
  assert.equal(facts.healthy, false)
  assert.ok(/nothing about this stack is verified/i.test(facts.summary), facts.summary)
  assert.equal(facts.probes.length, 0, 'an unreadable daemon is not probed around')
}

// ---- no containers at all is a fault, whatever `up` returned ----------------
// Waited for on the same bounded clock as a starting service: a container that
// has not appeared yet and one that never will look identical for the first
// few seconds, and only the deadline tells them apart.
{
  let clock = 0
  const facts = await verifyStack(recipe, {
    fetchLike: noFetch,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    pollMs: 1000,
    deadlineMs: 3000,
    exec: async () => '',
  })
  assert.equal(facts.healthy, false)
  assert.ok(/not running/i.test(facts.summary), facts.summary)
  assert.ok(facts.waitedMs >= 3000, 'and it waited for them rather than concluding instantly')
}

console.log('stack health: ok')
