/**
 * The defect: ~150 GB of docker estate leaked and nothing owned it.
 *
 * Measured on this box: 116 images for 53.5 GB (84% reclaimable), 102 volumes
 * for 18.8 GB, 48 GB of build cache, and containers still up six days after
 * their run ended, serving images tagged with the run id that built them. No
 * object said which run created it, so nothing could be removed without
 * guessing — and guessing on a shared docker daemon is how somebody else's
 * database disappears.
 *
 * So: the runner labels what it creates, and the reaper removes ONLY what
 * carries that label. These assertions are about that boundary — the label is
 * applied, labelled objects are selected, unlabelled ones never are, volumes
 * are never touched, and the orphan sweep reports before it acts.
 *
 * The docker CLI is stubbed throughout; the real daemon is never contacted.
 *
 *   node scripts/test-docker-reap.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const R = await import('../server/utils/dockerReap.ts')
const { stackUp, stackDown } = await import('../server/utils/stackLifecycle.ts')
const { resolveStackRecipe } = await import('../server/utils/stackRecipe.ts')

const HOUR = 60 * 60_000
const NOW = Date.parse('2026-09-21T12:00:00Z')
/** docker's own CreatedAt shape, trailing zone name included — the thing
 *  Date.parse refuses and the reaper has to cope with. */
const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} +0000 UTC`

/** A fake daemon. Rows are [id, createdMs, label, name]; a label of '' is an
 *  unlabelled object, which must never be selected. */
function daemon(rows) {
  const ran = []
  const exec = async (args) => {
    ran.push(args.join(' '))
    const kind = args[0] === 'ps' ? 'container' : args[0] === 'image' ? 'image' : args[0] === 'network' && args[1] === 'ls' ? 'network' : null
    if (!kind) return ''
    const i = args.indexOf('--filter')
    const filter = i === -1 ? '' : args[i + 1]
    // The real daemon's label filter: `label=key` matches any value,
    // `label=key=value` matches that value.
    const want = filter.startsWith('label=') ? filter.slice(6) : null
    return rows.filter(r => r.kind === kind)
      .filter(r => want === null ? true : want.includes('=') ? r.label === want : r.label.startsWith(`${want}=`))
      .map(r => [r.id, stamp(r.created), r.label ? r.label.split('=').slice(1).join('=') : '', r.name].join('\t'))
      .join('\n')
  }
  return { exec, ran }
}
const row = (kind, id, label, ageHours, name = id) =>
  ({ kind, id, label: label ? `run.id=${label}` : '', created: NOW - ageHours * HOUR, name })

// ── the label itself: one key, one shape ────────────────────────────────────
{
  assert.equal(R.RUN_LABEL, 'run.id')
  assert.equal(R.runLabel('run-7'), 'run.id=run-7')
  assert.deepEqual(R.labelArgs('run-7'), ['--label', 'run.id=run-7'], 'flags for any docker create/run/build')
  assert.deepEqual(R.labelEnv('run-7'), { AGENT_RUN_ID: 'run-7' }, 'and the same fact for a child that takes no flag')
}

// ── the label is wired into the runner where it starts a stack ──────────────
{
  const infra = mkdtempSync(join(tmpdir(), 'reap-infra-'))
  writeFileSync(join(infra, '.env'), 'X=1\n')
  writeFileSync(join(infra, 'docker-compose.foo.yml'),
    'services:\n  a:\n    image: x\n    profiles: [foo-stack]\n  b:\n    image: y\n    profiles: [foo-init]\n')
  const recipe = await resolveStackRecipe({ infraDir: infra, compose: 'alepo-dev-team-infra/foo' })

  const envs = []
  const exec = async (cmd, args, env) => { envs.push(env); return '' }
  await stackUp(recipe, { exec, runId: 'run-42' })
  assert.equal(envs.length, 2, 'one command per stage')
  for (const env of envs) {
    assert.deepEqual(env, { AGENT_RUN_ID: 'run-42' }, 'every stage is told whose run it is')
  }

  envs.length = 0
  await stackDown(recipe, { exec, runId: 'run-42' })
  assert.deepEqual(envs[0], { AGENT_RUN_ID: 'run-42' }, 'and so is the teardown, or `down` resolves a different project than `up` did')

  // No run id: byte-for-byte the old behaviour, because every existing caller
  // passes none and a stack must not start differently for this change.
  envs.length = 0
  await stackUp(recipe, { exec })
  assert.deepEqual(envs, [undefined, undefined], 'no run id means no environment change at all')
  rmSync(infra, { recursive: true, force: true })
}

// ── reapRun removes what carries the label, and nothing else ────────────────
{
  const d = daemon([
    row('container', 'c1', 'run-1', 2, 'pms-app'),
    row('container', 'c2', '', 2, 'someones-postgres'), //  unlabelled: never ours
    row('container', 'c3', 'run-2', 2, 'other-run'),
    row('image', 'i1', 'run-1', 2, 'localhost/agent-sdlc/lum-selfcare-v1:88bc24e9'),
    row('image', 'i2', '', 2, 'postgres:15'),
    row('network', 'n1', 'run-1', 2, 'run-1-net'),
    row('network', 'n2', '', 2, 'alepo-shared'),
  ])
  const res = await R.reapRun('run-1', { exec: d.exec })

  assert.deepEqual(res.targets.map(t => t.id).sort(), ['c1', 'i1', 'n1'], `only run-1's objects: ${JSON.stringify(res.targets)}`)
  assert.deepEqual(res.removed.map(t => t.id).sort(), ['c1', 'i1', 'n1'])
  const removals = d.ran.filter(c => /^rm |^rmi |^network rm /.test(c))
  assert.deepEqual(removals, ['rm -f c1', 'rmi i1', 'network rm n1'],
    `containers, then images, then networks — and only by id: ${JSON.stringify(d.ran)}`)

  for (const id of ['c2', 'i2', 'n2', 'c3']) {
    assert.ok(!d.ran.some(c => c.split(' ').includes(id)),
      `${id} carries no run.id=run-1 label and must never appear in a command; ran: ${JSON.stringify(d.ran)}`)
  }
  assert.ok(d.ran.every(c => !c.startsWith('volume')),
    `volumes are never touched, not even listed: ${JSON.stringify(d.ran)}`)
  assert.ok(d.ran.filter(c => c.includes('--filter')).every(c => c.includes('--filter label=run.id=run-1')),
    'every listing is filtered by the label; an unfiltered list is the whole box')
  assert.match(res.summary, /Volumes were not touched/)
}

// ── an unlabelled object is dropped even if the filter lets it through ──────
// Belt and braces on purpose: a `docker ps` whose filter silently did nothing
// returns every container on the host, and that is the failure that deletes
// somebody else's database.
{
  const rows = [row('container', 'c9', '', 2, 'not-ours')]
  const exec = async (args) => (args[0] === 'ps'
    ? [rows[0].id, stamp(rows[0].created), '', rows[0].name].join('\t')  // label column empty
    : '')
  const res = await R.reapRun('run-1', { exec })
  assert.deepEqual(res.targets, [], 'a row with an empty label is not a target, whatever the filter returned')
  assert.deepEqual(res.removed, [])
}

// ── a run id that would widen the filter is refused ─────────────────────────
for (const bad of ['', ' ', '*', 'run-1 --all']) {
  await assert.rejects(() => R.reapRun(bad, { exec: async () => '' }),
    /plain run id/, `"${bad}" must not reach docker`)
}

// ── the orphan pass reports before it acts ──────────────────────────────────
{
  const rows = [
    row('container', 'old1', 'run-old', 72, 'six-day-old-stack'),
    row('container', 'live', 'run-live', 72, 'a-running-run'),
    row('container', 'young', 'run-young', 2, 'started-two-hours-ago'),
    row('container', 'plain', '', 99999, 'unlabelled-and-ancient'),
    row('image', 'oldimg', 'run-old', 72, 'localhost/agent-sdlc/x:88bc24e9'),
  ]
  const report = daemon(rows)
  const dry = await R.reapOrphans({ olderThanHours: 24, keepRunIds: ['run-live'], exec: report.exec, now: NOW })
  assert.deepEqual(dry.targets.map(t => t.id).sort(), ['old1', 'oldimg'], `what it WOULD remove: ${JSON.stringify(dry.targets)}`)
  assert.deepEqual(dry.removed, [], 'and it removed nothing, because reporting is the default')
  assert.ok(!report.ran.some(c => /^rm |^rmi |^network rm /.test(c)), `no removal command was issued: ${JSON.stringify(report.ran)}`)
  assert.match(dry.summary, /Would remove 2/, dry.summary)
  assert.match(dry.summary, /pass apply to act/)

  const acting = daemon(rows)
  const wet = await R.reapOrphans({ olderThanHours: 24, apply: true, keepRunIds: ['run-live'], exec: acting.exec, now: NOW })
  assert.deepEqual(wet.removed.map(t => t.id).sort(), ['old1', 'oldimg'])
  assert.ok(!acting.ran.some(c => c.split(' ').includes('plain')), 'the ancient unlabelled container is still not ours to remove')
  assert.ok(!acting.ran.some(c => c.split(' ').includes('live')), 'nor is a run that is still going')
  assert.ok(!acting.ran.some(c => c.split(' ').includes('young')), 'nor one younger than the cutoff')
  assert.ok(acting.ran.every(c => !c.startsWith('volume')), 'and volumes are never included')
}

console.log('docker reap: the runner labels what it creates, and nothing unlabelled is ever selected')
