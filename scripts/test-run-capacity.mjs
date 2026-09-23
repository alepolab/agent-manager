/**
 * An instance-wide ceiling on live runs.
 *
 * The workspace lock stops two runs corrupting one checkout. It says nothing
 * about the total: forty runs against forty different directories pass the
 * lock forty times and are still forty concurrent agent pipelines, each with
 * its own token and minute budget, on one machine and one account's rate
 * limit. Nothing between "start a run" and "start one per ticket on the
 * board" refused.
 *
 *   node scripts/test-run-capacity.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'capacity-'))
process.env.CLAUDE_DIR = dir
delete process.env.AGENT_MAX_CONCURRENT_RUNS

const setLimit = (v) => writeFileSync(join(dir, 'settings.json'),
  JSON.stringify(v === undefined ? {} : { agentManager: { maxConcurrentRuns: v } }))

setLimit(undefined)
const C = await import('../server/utils/runCapacity.ts')

const runs = (...statuses) => statuses.map(status => ({ status }))

// ---- No cap configured: nothing is refused ------------------------------
{
  assert.equal(C.maxConcurrentRuns(), null)
  const v = C.capacityFor(runs('running', 'running', 'paused', 'running'))
  assert.equal(v.ok, true, 'an instance with no cap keeps its old behaviour exactly')
  assert.equal(v.live, 4)
  assert.equal(v.limit, null)
  assert.equal(C.describeCapacity(runs('running', 'paused')), '2 live')
}

// ---- Paused runs count ---------------------------------------------------
// The one judgement worth pinning: a paused run is not free. It holds a
// checkout and a budget and will resume, so counting only `running` would let
// an instance fill with paused runs and still call itself idle.
{
  setLimit(2)
  assert.equal(C.maxConcurrentRuns(), 2)
  assert.equal(C.capacityFor(runs('paused', 'paused')).ok, false,
    'two paused runs fill a limit of two')
  assert.equal(C.capacityFor(runs('running', 'paused')).ok, false)
  assert.equal(C.capacityFor(runs('running')).ok, true)
}

// ---- Settled runs never count -------------------------------------------
// 348 completed runs were restored on this instance in one pass; if those
// counted, the cap would refuse every future run forever.
{
  setLimit(2)
  const settled = runs('completed', 'failed', 'stopped', 'interrupted', 'completed', 'completed')
  const v = C.capacityFor([...settled, ...runs('running')])
  assert.equal(v.ok, true, 'a history of settled runs does not consume capacity')
  assert.equal(v.live, 1, 'only running and paused are live')
}

// ---- The refusal says what to do ----------------------------------------
{
  setLimit(1)
  const v = C.capacityFor(runs('running'))
  assert.equal(v.ok, false)
  assert.match(v.reason, /allows 1 run at once and 1 is already live/, 'singular reads correctly')
  assert.match(v.reason, /Wait for one to settle, stop one, or raise the limit/,
    'a refusal that names no action is a dead end')
  setLimit(3)
  assert.match(C.capacityFor(runs('running', 'paused', 'running')).reason, /allows 3 runs at once and 3 are already live/)
  assert.equal(C.describeCapacity(runs('running', 'paused', 'running')), '3 of 3 live')
}

// ---- A nonsense setting is no cap, not a cap of zero --------------------
// A cap of 0 would refuse every run on an instance whose operator was trying
// to REMOVE the cap. Absent, zero and negative all mean "no limit".
for (const bad of [0, -1, undefined, null, 'lots', 1.9]) {
  setLimit(bad)
  const limit = C.maxConcurrentRuns()
  if (bad === 1.9) {
    assert.equal(limit, 1, 'a fractional limit floors rather than refusing to parse')
  } else {
    assert.equal(limit, null, `${JSON.stringify(bad)} is not a limit`)
    assert.equal(C.capacityFor(runs('running', 'running')).ok, true)
  }
}

// ---- The environment wins and cannot be raised from the page ------------
{
  setLimit(50)
  process.env.AGENT_MAX_CONCURRENT_RUNS = '2'
  assert.equal(C.maxConcurrentRuns(), 2, 'a deployment that must hold a harder line holds it')
  assert.equal(C.capacityFor(runs('running', 'running')).ok, false)
  delete process.env.AGENT_MAX_CONCURRENT_RUNS
  assert.equal(C.maxConcurrentRuns(), 50, 'and removing it returns to the configured value')
}

// ---- An unreadable settings file is no cap ------------------------------
// Fail open, matching agentManagerSettings: a corrupt file must not silently
// stop every run on the instance.
{
  writeFileSync(join(dir, 'settings.json'), '{ not json')
  assert.equal(C.maxConcurrentRuns(), null)
  assert.equal(C.capacityFor(runs('running', 'running', 'running')).ok, true)
}

rmSync(dir, { recursive: true, force: true })
console.log('run capacity: paused runs count, settled ones never do, the environment cannot be raised from the page, and a nonsense limit is no limit rather than a limit of zero')
