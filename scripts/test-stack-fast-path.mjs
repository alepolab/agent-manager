/**
 * A claimed stack that is healthy and runs the checkout's commit is reused by
 * the runner, without a model call. 58 of 75 stand-ups were handed a stack and
 * still spent 8-12 minutes in an agent session confirming it.
 *
 *   node scripts/test-stack-fast-path.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const m = await import('../server/utils/stackFastPath.ts')
const { claimableStack } = await import('../server/utils/runTeardown.ts')
const HEAD = 'a35b08490d4b922abe89eeb8045c955374dbf2c6'
const c = (name, o = {}) => ({ name, image: `img/${name}`, state: 'running', exitCode: 0, health: 'healthy', revision: null, service: name.replace(/^p-/, ''), ...o })

// ── sameCommit ───────────────────────────────────────────────────────────────
assert.ok(m.sameCommit(HEAD, 'a35b08490'))
assert.ok(!m.sameCommit(HEAD, 'a35b08'), 'six characters name nothing')
assert.ok(!m.sameCommit(HEAD, null))

// ── reuseVerdict: strict ─────────────────────────────────────────────────────
const app = c('p-app', { revision: HEAD })
assert.equal(m.reuseVerdict([app, c('p-minio'), c('p-init', { state: 'exited', health: null })], HEAD).ok, true, 'an init job that exited 0 is fine')
assert.equal(m.reuseVerdict([app, c('p-app-rollback-9aa4bac4', { state: 'exited', exitCode: 143, health: 'unhealthy', service: 'app' })], HEAD).ok, true,
  'a stopped rollback copy of a service that is running anyway is not a dead service')
for (const [containers, why] of [
  [[app, c('p-minio', { health: 'unhealthy' })], /unhealthy/],
  [[app, c('p-minio', { health: 'starting' })], /starting/],
  [[app, c('p-init', { state: 'exited', exitCode: 1, health: null })], /code 1/],
  [[app, c('p-x', { state: 'restarting' })], /restarting/],
  [[c('p-app', { revision: '19fc7573a6773c7032722a683080bc110a9dd67d' })], /runs 19fc7573a, not this checkout's a35b08490/],
  [[c('p-app')], /unlabelled/],
  [[c('p-app', { state: 'exited', revision: HEAD })], /nothing in the stack is running/],
]) assert.match(m.reuseVerdict(containers, HEAD).reason, why)
assert.match(m.reuseVerdict([app], undefined).reason, /no HEAD/)

// ── inheritedStackMeta ───────────────────────────────────────────────────────
assert.deepEqual(m.inheritedStackMeta({ stack: { profile: 'ase-crm-stack', topology: 'single' } }), { profile: 'ase-crm-stack', topology: 'single', liquibase_tag: null })
assert.equal(m.inheritedStackMeta({ stack: null }), null)
assert.equal(m.inheritedStackMeta({ stack: { profile: 'p' } }), null)

// ── tryStackFastPath, end to end on fakes ────────────────────────────────────
function fakes({ appRevision = HEAD, image = '' } = {}) {
  const files = {
    '/src/meta.json': JSON.stringify({ stack: { profile: 'ase-crm-stack', topology: 'single', liquibase_tag: null } }),
    '/me/meta.json': JSON.stringify({ ticket: 'X-1', stack_required: true }),
  }
  const inspect = { 'p-app': { Config: { Image: 'ghcr.io/a/app:dev', Labels: { 'org.opencontainers.image.revision': appRevision } }, State: { Status: 'running', ExitCode: 0, Health: { Status: 'healthy' } } } }
  const exec = async (cmd, args) => {
    const a = args.join(' ')
    if (cmd === 'git' && a === 'rev-parse HEAD') return HEAD
    if (cmd === 'git' && a === 'remote -v') return 'origin https://github.com/o/r.git (fetch)'
    if (cmd === 'git' && a === 'status --short') return ''
    if (cmd === 'docker' && args[0] === 'ps' && a.includes('{{.Names}} {{.Status}}')) return 'p-app Up 2 hours (healthy)'
    if (cmd === 'docker' && args[0] === 'ps') return 'p-app'
    if (cmd === 'docker' && args[0] === 'inspect') return JSON.stringify(inspect[args.at(-1)])
    if (cmd === 'docker' && args[0] === 'images') return image
    throw new Error(`unexpected ${cmd} ${a}`)
  }
  const fs = { readFile: async p => { if (!(p in files)) throw new Error('ENOENT'); return files[p] }, writeFile: async (p, s) => { files[p] = s } }
  return { exec, fs, files }
}
const r = { project: 'sdlc-src', claimedFrom: 'src-run', projectDir: '/co', branch: 'fix/X-1', artifactsDir: '/me', sourceArtifactsDir: '/src' }
{
  const f = fakes()
  const res = await m.tryStackFastPath(r, f.fs, f.exec)
  assert.equal(res.ok, true)
  assert.match(res.output, /without a model call/)
  const meta = JSON.parse(f.files['/me/meta.json'])
  assert.deepEqual(meta.stack, { profile: 'ase-crm-stack', topology: 'single', liquibase_tag: null }, 'stack merged from the run that stood it up')
  assert.equal(meta.ticket, 'X-1', 'meta.json merged, not overwritten')
  const report = f.files['/me/stack-report.md']
  for (const must of ['$ git rev-parse HEAD', HEAD, '$ docker ps -a --filter label=com.docker.compose.project=sdlc-src', 'p-app Up 2 hours (healthy)', 'run src-run', 'Nothing was seeded'])
    assert.ok(report.includes(must), `report quotes ${must}`)
}
{
  const f = fakes({ appRevision: '19fc7573a6773c7032722a683080bc110a9dd67d', image: 'localhost/agent-sdlc/app:base-a35b08490d4b' })
  const res = await m.tryStackFastPath(r, f.fs, f.exec)
  assert.equal(res.ok, false)
  assert.match(res.reason, /not this checkout's/)
  assert.equal(res.image, 'localhost/agent-sdlc/app:base-a35b08490d4b', 'the agent is told which image of this commit to deploy')
  assert.equal(f.files['/me/stack-report.md'], undefined, 'nothing written when the agent takes over')
}
{
  const f = fakes()
  const res = await m.tryStackFastPath({ ...r, sourceArtifactsDir: '/nowhere' }, f.fs, f.exec)
  assert.match(res.reason, /recorded no stack profile/)
}

// ── claimableStack prefers a free stack already on the run's commit ─────────
{
  const exec = async () => JSON.stringify([{ Name: 'sdlc-aaaa', Status: 'running(3)' }, { Name: 'sdlc-bbbb', Status: 'running(3)' }])
  const runs = [
    { id: 'aaaa', status: 'paused', product: { name: 'p' } },
    { id: 'bbbb', status: 'paused', product: { name: 'p' } },
  ]
  const me = { id: 'cccc', product: { name: 'p' } }
  assert.equal((await claimableStack(me, runs, exec)).project, 'sdlc-aaaa', 'first free one without a preference')
  assert.equal((await claimableStack(me, runs, exec, async p => p === 'sdlc-bbbb')).project, 'sdlc-bbbb', 'the one on the right commit when asked')
  assert.equal((await claimableStack(me, runs, exec, async () => false)).project, 'sdlc-aaaa', 'still a stack when none matches')
}

// ── Wiring ───────────────────────────────────────────────────────────────────
const runner = readFileSync(new URL('../server/utils/workflowRunner.ts', import.meta.url), 'utf8')
const fast = runner.indexOf('tryStackFastPath({')
assert.ok(fast > 0 && fast < runner.indexOf('agentCaller(step.agentSlug, agentInput'), 'tried before the agent is called')
assert.match(runner, /agentCaller\(step\.agentSlug, agentInput,/, 'the agent gets the image hint')
const tpl = readFileSync(new URL('../app/utils/templates.ts', import.meta.url), 'utf8')
assert.match(tpl, /## Build once per commit[\s\S]*--label org\.opencontainers\.image\.revision=<full HEAD sha>/)

console.log('ok - a claimed stack on the right commit is reused without a model call')
