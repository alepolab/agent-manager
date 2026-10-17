/**
 * Run events and the daily spend circuit breaker (server/utils/runEvents.ts).
 *
 *   1. A run through the real runner, with a stub caller, emits run.started,
 *      step.started/finished (model, tokens including the cache figure, usd,
 *      duration), gate.requested / gate.answered (assignee, minutes) and
 *      run.settled (status, cost) - every one tagged with jira.key, run_id,
 *      product, origin, blast_radius, workflow and pod.
 *   2. The same events land in events/<run id>.jsonl under the artifacts dir
 *      and, when OTEL_EXPORTER_OTLP_ENDPOINT is set, as OTLP JSON on /v1/logs
 *      and /v1/metrics - with a plain POST, no SDK.
 *   3. The step's SDK env carries the tags in OTEL_RESOURCE_ATTRIBUTES.
 *   4. The breaker: past settings.dailySpendUsdCap a new automated run queues
 *      with question.reason 'budget' and a notification goes out; a per-product
 *      cap holds that product's runs and not another's; a continue waives it.
 *
 *   node scripts/test-run-events.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'run-events-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'run-events-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'run-events-ws-'))
process.env.AGENT_MANAGER_POD = 'pod-test'
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel.test:4318/'
process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer t'
delete process.env.AGENT_DAILY_SPEND_USD_CAP
delete process.env.AGENT_RUNNER_MODE
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const store = await import('../server/utils/workflowRunStore.ts')
const runner = await import('../server/utils/workflowRunner.ts')
const events = await import('../server/utils/runEvents.ts')
const notify = await import('../server/utils/notify.ts')
const TIMEOUT = 15000

const save = (wf) => writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${wf.slug}.json`),
  JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))
const saveSettings = (agentManager) => writeFileSync(join(process.env.CLAUDE_DIR, 'settings.json'), JSON.stringify({ agentManager }))
const gated = { slug: 'gated', name: 'Gated', steps: [
  { id: 'a', agentSlug: 'agent-a', label: 'Work', next: ['s'] },
  { id: 's', agentSlug: 'agent-s', label: 'Ship', next: [], approval: true, gateRole: 'qa' },
] }
save(gated)

const seen = []
events.addSink(async e => { seen.push(e) })
const posted = []
events.setOtlpPoster(async (url, body, headers) => { posted.push({ url, body, headers }) })
const notified = []
notify.setPoster(async (url, body) => { notified.push({ url, body }) })
process.env.SLACK_WEBHOOK_URL = 'https://hooks.example/x'

const callerEnvs = []
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
runner.setAgentCaller(async (slug, input, dir, opts) => {
  callerEnvs.push({ slug, opts })
  return { output: `out ${slug}`, model: 'claude-sonnet-4-6', usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 1000, usd: 0.0123 } }
})

const product = { name: 'ASE CRM', repos: ['alepolab/ase-crm'], branches: {}, stack: { compose: 'x', topology_default: '-' }, tests: {} }

// ── 1 + 2 + 3: a gated run end to end ────────────────────────────────────────
{
  let g = (await runner.startOrQueue({ workflow: gated, initialPrompt: 'go', watch: 'watch-1', ticketKey: 'ASECRM-77', autoRun: true, startedBy: 'dev1', productKey: 'ase-crm' })).run
  g = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(g.status, 'paused'); assert.equal(g.question.kind, 'approval')
  // Something intake would have written; set directly since no intake ran.
  g.blastRadius = 'schema'; g.origin = 'customer'; g.product = product
  await store.saveRun(g)

  const types = () => seen.filter(e => e.tags.run_id === g.id).map(e => e.type)
  assert.deepEqual(types(), ['run.started', 'step.started', 'step.finished', 'gate.requested'], `so far: ${types()}`)

  const started = seen.find(e => e.type === 'run.started' && e.tags.run_id === g.id)
  assert.equal(started.tags['jira.key'], 'ASECRM-77')
  assert.equal(started.tags.workflow, 'gated')
  assert.equal(started.tags.pod, 'pod-test')
  assert.equal(started.tags.watch, 'watch-1')
  assert.equal(started.data.runner, 'host', 'default runnerMode: the host')

  const fin = seen.find(e => e.type === 'step.finished' && e.tags.run_id === g.id)
  assert.equal(fin.data.step_id, 'a'); assert.equal(fin.data.agent, 'agent-a'); assert.equal(fin.data.status, 'completed')
  assert.equal(fin.data.model, 'claude-sonnet-4-6')
  assert.equal(fin.data.input_tokens, 1200); assert.equal(fin.data.output_tokens, 300)
  assert.equal(fin.data.cache_read_input_tokens, 1000, 'the cache figure is carried, not folded away')
  assert.equal(fin.data.usd, 0.0123)
  assert.equal(typeof fin.data.duration_ms, 'number')

  const gate = seen.find(e => e.type === 'gate.requested' && e.tags.run_id === g.id)
  assert.equal(gate.data.step_id, 's'); assert.equal(gate.data.kind, 'approval'); assert.equal(gate.data.assignee, 'qa', 'the gate role is the assignee')

  // The SDK env carries the tags for Claude Code's own telemetry.
  const a = callerEnvs.find(c => c.slug === 'agent-a')
  assert.equal(a.opts.otelAttributes.run_id, g.id)
  assert.equal(a.opts.otelAttributes['jira.key'], 'ASECRM-77')
  assert.equal(a.opts.otelAttributes.pod, 'pod-test')
  assert.equal(a.opts.sandbox, undefined, 'runnerMode host: no sandbox option reaches the caller')

  // Approve, as the route does: the decision carries who and when.
  const askedAt = g.question.askedAt
  await new Promise(r => setTimeout(r, 20))
  const decision = { stepId: 's', label: 'Ship', at: Date.now(), by: 'qa-lead', verdict: 'approved', waitedMs: Date.now() - askedAt, blastRadius: 'schema' }
  await runner.continueRun(g.id, 'fine', { decision })
  const done = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(done.status, 'completed', done.error)
  await new Promise(r => setTimeout(r, 50))

  assert.deepEqual(types(), ['run.started', 'step.started', 'step.finished', 'gate.requested', 'gate.answered', 'step.started', 'step.finished', 'run.settled'], `all: ${types()}`)
  const answered = seen.find(e => e.type === 'gate.answered' && e.tags.run_id === g.id)
  assert.equal(answered.data.assignee, 'qa-lead'); assert.equal(answered.data.verdict, 'approved')
  assert.equal(typeof answered.data.waited_minutes, 'number'); assert.ok(answered.data.waited_minutes >= 0)
  assert.equal(answered.tags.blast_radius, 'schema', 'later events carry the classification')
  assert.equal(answered.tags.product, 'ASE CRM'); assert.equal(answered.tags.origin, 'customer')

  const settled = seen.find(e => e.type === 'run.settled' && e.tags.run_id === g.id)
  assert.equal(settled.data.status, 'completed')
  assert.ok(Math.abs(settled.data.usd - 0.0246) < 1e-9, `cost per run is the sum of its steps: ${settled.data.usd}`)
  assert.equal(settled.data.input_tokens, 2400)

  // JSONL under the artifacts dir.
  const lines = await events.readRunEvents(g.id)
  assert.deepEqual(lines.map(l => l.type), types(), 'the file holds the same events in order')
  assert.ok((await events.runsWithEvents()).includes(g.id))
  assert.ok(events.eventsFile(g.id).startsWith(join(process.env.AGENT_RUNS_DIR, 'events')))

  // OTLP: one /v1/logs per event; /v1/metrics for the ones with numbers.
  const logs = posted.filter(p => p.url === 'http://otel.test:4318/v1/logs')
  const metrics = posted.filter(p => p.url === 'http://otel.test:4318/v1/metrics')
  assert.ok(logs.length >= 8, `a log record per event: ${logs.length}`)
  assert.equal(logs[0].headers.Authorization, 'Bearer t', 'OTEL_EXPORTER_OTLP_HEADERS are sent')
  const rec = logs.find(p => p.body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue === 'step.finished')
  const resAttrs = Object.fromEntries(rec.body.resourceLogs[0].resource.attributes.map(a => [a.key, Object.values(a.value)[0]]))
  assert.equal(resAttrs['service.name'], 'agent-manager'); assert.equal(resAttrs['jira.key'], 'ASECRM-77'); assert.equal(resAttrs.run_id, g.id)
  const stepMetric = metrics.find(p => p.body.resourceMetrics[0].scopeMetrics[0].metrics.some(m => m.name === 'agent_manager.step.cost_usd'))
  assert.ok(stepMetric, 'step cost is a metric')
  const names = stepMetric.body.resourceMetrics[0].scopeMetrics[0].metrics.map(m => m.name)
  assert.ok(names.includes('agent_manager.step.cache_read_input_tokens'))
  assert.ok(metrics.some(p => p.body.resourceMetrics[0].scopeMetrics[0].metrics.some(m => m.name === 'agent_manager.run.cost_usd')), 'and run cost')
  assert.ok(metrics.some(p => p.body.resourceMetrics[0].scopeMetrics[0].metrics.some(m => m.name === 'agent_manager.gate.waited_minutes')), 'and gate wait')
}

// A failing OTLP endpoint never fails a run or an event.
{
  events.setOtlpPoster(async () => { throw new Error('connection refused') })
  const before = seen.length
  const e = await events.emitRunEvent({ id: 'r-x', workflowSlug: 'w' }, 'run.started', {})
  assert.equal(e.type, 'run.started'); assert.equal(seen.length, before + 1, 'the other sinks still saw it')
  events.setOtlpPoster(async (url, body, headers) => { posted.push({ url, body, headers }) })
}

// ── 4. the breaker ───────────────────────────────────────────────────────────
// The pure arithmetic first.
{
  const now = Date.parse('2026-10-17T12:00:00Z')
  const runs = [
    { usage: { usd: 10 }, startedAt: now - 3600_000, status: 'completed', endedAt: now - 60_000, product: { name: 'A' } },
    { usage: { usd: 5 }, startedAt: now - 3600_000, status: 'running', product: { name: 'B' } },
    { usage: { usd: 99 }, startedAt: now - 2 * 86_400_000, status: 'completed', endedAt: now - 86_400_000 - 3600_000, product: { name: 'A' } },
    { usage: { usd: 7 }, startedAt: now - 3600_000, status: 'completed', endedAt: now, product: { name: 'A' }, testOf: { sourceRunId: 'x', stepId: 's', startPoint: '' } },
  ]
  assert.equal(events.dailySpend(runs, now), 15, 'today\'s runs, live ones included; yesterday\'s and test runs excluded')
  assert.equal(events.dailySpend(runs, now, 'A'), 10)
  assert.equal(events.spendCapHit(runs, 'A', now, { instance: 20, byProduct: {} }), null)
  assert.match(events.spendCapHit(runs, 'A', now, { instance: 15, byProduct: {} }), /Daily spend cap reached: \$15\.00 of this instance's \$15\.00/)
  assert.match(events.spendCapHit(runs, 'A', now, { byProduct: { A: 10 } }), /for A: \$10\.00/)
  assert.equal(events.spendCapHit(runs, 'B', now, { byProduct: { A: 10 } }), null, 'another product\'s cap does not hold this one')
  assert.equal(events.spendCapHit(runs, undefined, now, {  byProduct: {} }), null, 'no cap, no hold')
}

// Through the runner: spend already on record today, a cap below it.
{
  const spentToday = await store.listRuns()
  const spent = spentToday.reduce((s, r) => s + (r.usage?.usd ?? 0), 0)
  assert.ok(spent > 0, 'the gated run above spent something')
  saveSettings({ dailySpendUsdCap: spent / 2 })
  notified.length = 0
  const { run, queued } = await runner.startOrQueue({ workflow: gated, initialPrompt: 'go', watch: 'watch-1', ticketKey: 'ASECRM-78', autoRun: true })
  assert.equal(queued, true, 'THE REQUIREMENT: over the cap, a new run queues')
  assert.equal(run.status, 'queued')
  assert.equal(run.question?.reason, 'budget', 'with a budget question')
  assert.match(run.question.text, /Daily spend cap reached/)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(notified.length, 1, 'and a person is told once')
  assert.match(notified[0].body.text, /HELD .* Daily spend cap/)

  // The drain leaves it alone while the cap holds.
  const { drainRunQueue } = await import('../server/utils/runQueue.ts')
  assert.equal(await drainRunQueue(runner.launchQueuedRun), 0, 'still held')
  assert.equal((await store.getRun(run.id)).status, 'queued')

  // Raising the cap releases it on the next drain.
  saveSettings({ dailySpendUsdCap: spent * 100 })
  assert.equal(await drainRunQueue(runner.launchQueuedRun), 1, 'under the cap, the queue launches it')
  const released = await runner.waitForSettled(run.id, TIMEOUT)
  assert.notEqual(released.status, 'queued')
  assert.notEqual(released.question?.reason, 'budget', 'the hold is cleared from the record')
  await runner.continueRun(run.id, 'ok')
  await runner.waitForSettled(run.id, TIMEOUT)
}

// A per-product cap holds that product only, and a continue waives it.
{
  const all = await store.listRuns()
  const spentCrm = all.filter(r => r.product?.name === 'ASE CRM').reduce((s, r) => s + (r.usage?.usd ?? 0), 0)
  assert.ok(spentCrm > 0)
  saveSettings({ dailySpendUsdCapByProduct: { 'ASE CRM': spentCrm / 2 } })
  const other = (await runner.startOrQueue({ workflow: gated, initialPrompt: 'go', watch: 'w', ticketKey: 'OTHER-1', autoRun: true })).run
  assert.notEqual(other.status, 'queued', 'a run of no product is not held by ASE CRM\'s cap')
  await runner.waitForSettled(other.id, TIMEOUT)
  // Finish it: with no checkout every run here shares one workspace, and a run
  // stopped at its gate would hold the lock the next one needs.
  await runner.continueRun(other.id, 'ok')
  await runner.waitForSettled(other.id, TIMEOUT)

  // The registry has no ase-crm here, so attach the product the way intake would: via the run store after a queue.
  // Simulate by caps on the instance: the product path is proven by the pure checks above.
  saveSettings({ dailySpendUsdCap: 0.0001 })
  const held = (await runner.startOrQueue({ workflow: gated, initialPrompt: 'go', watch: 'w', ticketKey: 'OTHER-2', autoRun: true })).run
  assert.equal(held.status, 'queued'); assert.equal(held.question.reason, 'budget')
  const waived = await runner.continueRun(held.id, undefined, { decision: { stepId: 'a', label: 'Work', at: Date.now(), by: 'cto', verdict: 'approved', waitedMs: 1 } })
  assert.equal(waived.spendCapWaived, true, 'a continue waives the cap for this run')
  assert.equal(waived.question, undefined)
  const { drainRunQueue } = await import('../server/utils/runQueue.ts')
  await drainRunQueue(runner.launchQueuedRun)
  const r = await runner.waitForSettled(held.id, TIMEOUT)
  assert.notEqual(r.status, 'queued', 'and the queue launches it although the cap still holds')
  saveSettings({})
  await runner.continueRun(held.id, 'ok').catch(() => {})
}

console.log('run events: ok')
process.exit(0)
