/**
 * Run events: one structured record per thing a run does that somebody will
 * want to count, tagged the same way everywhere, and three places it goes.
 *
 *   run.started          the run's wave loop began
 *   step.started         a step's agent call began (visit)
 *   step.finished        it ended: status, model, tokens incl. cache, usd, ms
 *   gate.requested       the run stopped on a person (a question or approval)
 *   gate.answered        a person answered: who, and how long it waited
 *   run.settled          the run reached completed/failed/stopped, with cost
 *
 * Every event carries the run's tags (RunTags): jira.key, run_id, product,
 * origin, blast_radius, workflow, pod. `pod` is this instance's name
 * (settings.pod or AGENT_MANAGER_POD), so several instances exporting to one
 * collector stay apart.
 *
 * Sinks, all best-effort and never awaited by the runner's hot path:
 *   (a) the artifacts dir: `events/<run id>.jsonl`, one JSON object per line,
 *       for ClaudeMetrics ingestion. Appended per event; the file is the
 *       durable record.
 *   (b) OTLP/HTTP, when OTEL_EXPORTER_OTLP_ENDPOINT is set: each event is one
 *       log record on /v1/logs, and step.finished and run.settled also post
 *       sum metrics (tokens, usd, duration) on /v1/metrics. Plain fetch with a
 *       minimal OTLP JSON body: no SDK, no new dependency. Failures are logged
 *       once per endpoint per minute and dropped.
 *   (c) the cost report: nothing to do here, because costReport.ts reads the
 *       run record, which already carries every step's usage; the JSONL file
 *       under events/ is what the report can be cross-checked against.
 *
 * The daily spend circuit breaker also lives here (dailySpend, spendCapHit):
 * the runner asks it before starting a run, and a hit means the run queues on
 * a budget question rather than running.
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentRunsRoot } from './runArtifacts.ts'
import { agentManagerSettings, envString } from './appSettings.ts'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '~~/shared/types/run'

const log = createLogger('runner')

export type RunEventType = 'run.started' | 'step.started' | 'step.finished' | 'gate.requested' | 'gate.answered' | 'run.settled'

export interface RunTags {
  'jira.key'?: string
  run_id: string
  product?: string
  origin?: string
  blast_radius?: string
  workflow: string
  pod?: string
  /** The watch, schedule or trigger that started the run. */
  watch?: string
  sandbox?: string
}

export interface RunEvent {
  type: RunEventType
  /** ISO time. */
  ts: string
  tags: RunTags
  /** Event-specific fields; flat, so a line is one row. */
  data: Record<string, string | number | boolean | null | undefined>
}

/** This instance's name, for the `pod` tag. */
export function podName(): string | undefined {
  return envString('AGENT_MANAGER_POD') ?? agentManagerSettings().pod
}

/** The tags every event of this run carries. */
export function tagsFor(run: Pick<WorkflowRun, 'id' | 'ticketKey' | 'product' | 'origin' | 'blastRadius' | 'workflowSlug' | 'watch' | 'sandbox'>): RunTags {
  const t: RunTags = { run_id: run.id, workflow: run.workflowSlug }
  if (run.ticketKey) t['jira.key'] = run.ticketKey
  if (run.product?.name) t.product = run.product.name
  if (run.origin) t.origin = run.origin
  if (run.blastRadius) t.blast_radius = run.blastRadius
  if (run.watch) t.watch = run.watch
  const pod = podName()
  if (pod) t.pod = pod
  if (run.sandbox) t.sandbox = run.sandbox.image
  return t
}

/** The same tags, as OTEL_RESOURCE_ATTRIBUTES keys for the step's Claude Code process. */
export function otelAttributesFor(run: Parameters<typeof tagsFor>[0]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(tagsFor(run))) if (v) out[k] = String(v)
  return out
}

// ── sinks ────────────────────────────────────────────────────────────────────

export type EventSink = (event: RunEvent) => Promise<void>
const sinks: EventSink[] = []
/** Test seam: an added sink sees every event; `resetSinks` restores the defaults. */
export function addSink(fn: EventSink): () => void { sinks.push(fn); return () => { const i = sinks.indexOf(fn); if (i >= 0) sinks.splice(i, 1) } }
export function resetSinks(): void { sinks.length = 0 }

/** Where the JSONL goes: `<artifacts root>/events/<run id>.jsonl`. */
export function eventsDir(): string { return join(agentRunsRoot(), 'events') }
export function eventsFile(runId: string): string { return join(eventsDir(), `${runId}.jsonl`) }

async function jsonlSink(event: RunEvent): Promise<void> {
  await mkdir(eventsDir(), { recursive: true })
  await appendFile(eventsFile(event.tags.run_id), `${JSON.stringify(event)}\n`, 'utf-8')
}

/** The OTLP endpoint in force, without a trailing slash; undefined turns the exporter off. */
export function otlpEndpoint(): string | undefined {
  const raw = envString('OTEL_EXPORTER_OTLP_ENDPOINT')
  return raw ? raw.replace(/\/+$/, '') : undefined
}

function otlpHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  for (const pair of (envString('OTEL_EXPORTER_OTLP_HEADERS') ?? '').split(',')) {
    const i = pair.indexOf('=')
    if (i > 0) headers[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
  }
  return headers
}

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean }
const otlpValue = (v: string | number | boolean): OtlpValue =>
  typeof v === 'boolean' ? { boolValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v }
const attributes = (obj: Record<string, unknown>) =>
  Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([key, value]) => ({ key, value: otlpValue(value as string | number | boolean) }))

const nanos = (iso: string) => `${Date.parse(iso)}000000`

/** The /v1/logs body for one event: one log record carrying the event's data as attributes and the tags as the resource. */
export function otlpLogsPayload(event: RunEvent): unknown {
  const { run_id, ...rest } = event.tags
  return {
    resourceLogs: [{
      resource: { attributes: attributes({ 'service.name': 'agent-manager', run_id, ...rest }) },
      scopeLogs: [{
        scope: { name: 'agent-manager.runs' },
        logRecords: [{
          timeUnixNano: nanos(event.ts),
          severityText: 'INFO',
          body: { stringValue: event.type },
          attributes: attributes({ 'event.name': event.type, ...event.data }),
        }],
      }],
    }],
  }
}

/** The /v1/metrics body for an event that carries numbers worth summing; null for the rest. */
export function otlpMetricsPayload(event: RunEvent): unknown | null {
  const points: { name: string, unit: string, value: number }[] = []
  const d = event.data
  if (event.type === 'step.finished') {
    if (typeof d.input_tokens === 'number') points.push({ name: 'agent_manager.step.input_tokens', unit: '{token}', value: d.input_tokens })
    if (typeof d.output_tokens === 'number') points.push({ name: 'agent_manager.step.output_tokens', unit: '{token}', value: d.output_tokens })
    if (typeof d.cache_read_input_tokens === 'number') points.push({ name: 'agent_manager.step.cache_read_input_tokens', unit: '{token}', value: d.cache_read_input_tokens })
    if (typeof d.usd === 'number') points.push({ name: 'agent_manager.step.cost_usd', unit: 'USD', value: d.usd })
    if (typeof d.duration_ms === 'number') points.push({ name: 'agent_manager.step.duration_ms', unit: 'ms', value: d.duration_ms })
  } else if (event.type === 'run.settled') {
    if (typeof d.usd === 'number') points.push({ name: 'agent_manager.run.cost_usd', unit: 'USD', value: d.usd })
    if (typeof d.input_tokens === 'number') points.push({ name: 'agent_manager.run.input_tokens', unit: '{token}', value: d.input_tokens })
    if (typeof d.output_tokens === 'number') points.push({ name: 'agent_manager.run.output_tokens', unit: '{token}', value: d.output_tokens })
    if (typeof d.active_ms === 'number') points.push({ name: 'agent_manager.run.active_ms', unit: 'ms', value: d.active_ms })
    points.push({ name: 'agent_manager.run.settled', unit: '{run}', value: 1 })
  } else if (event.type === 'gate.answered' && typeof d.waited_minutes === 'number') {
    points.push({ name: 'agent_manager.gate.waited_minutes', unit: 'min', value: d.waited_minutes })
  }
  if (!points.length) return null
  const { run_id, ...rest } = event.tags
  const pointAttrs = attributes({ status: d.status, model: d.model, step: d.step_id, agent: d.agent, assignee: d.assignee, kind: d.kind })
  return {
    resourceMetrics: [{
      resource: { attributes: attributes({ 'service.name': 'agent-manager', run_id, ...rest }) },
      scopeMetrics: [{
        scope: { name: 'agent-manager.runs' },
        metrics: points.map(p => ({
          name: p.name, unit: p.unit,
          sum: {
            aggregationTemporality: 1, // DELTA
            isMonotonic: true,
            dataPoints: [{ timeUnixNano: nanos(event.ts), attributes: pointAttrs, ...(Number.isInteger(p.value) ? { asInt: String(p.value) } : { asDouble: p.value }) }],
          },
        })),
      }],
    }],
  }
}

export type Poster = (url: string, body: unknown, headers: Record<string, string>) => Promise<void>
let poster: Poster = async (url, body, headers) => {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) })
  if (!res.ok) throw new Error(`OTLP endpoint answered ${res.status}`)
}
/** Test seam. */
export function setOtlpPoster(fn: Poster) { poster = fn }

const otlpFailedAt = new Map<string, number>()
async function otlpSink(event: RunEvent): Promise<void> {
  const base = otlpEndpoint()
  if (!base) return
  const headers = otlpHeaders()
  const posts: [string, unknown][] = [[`${base}/v1/logs`, otlpLogsPayload(event)]]
  const metrics = otlpMetricsPayload(event)
  if (metrics) posts.push([`${base}/v1/metrics`, metrics])
  for (const [url, body] of posts) {
    try {
      await poster(url, body, headers)
    } catch (err) {
      const last = otlpFailedAt.get(url) ?? 0
      if (Date.now() - last > 60_000) {
        otlpFailedAt.set(url, Date.now())
        log.warn('OTLP export failed; dropping events until it recovers', { url, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}

/**
 * Records one event: builds it, appends it to the JSONL file, posts it to OTLP
 * when configured, and hands it to any added sink. Returns the event. Never
 * throws and is safe to call without awaiting.
 */
export async function emitRunEvent(
  run: Parameters<typeof tagsFor>[0],
  type: RunEventType,
  data: RunEvent['data'] = {},
): Promise<RunEvent> {
  const event: RunEvent = { type, ts: new Date().toISOString(), tags: tagsFor(run), data }
  await Promise.all([jsonlSink(event), otlpSink(event), ...sinks.map(s => s(event))].map(p => p.catch((err) => {
    log.warn('run event sink failed', { type, runId: run.id, error: err instanceof Error ? err.message : String(err) })
  })))
  return event
}

// ── convenience emitters, so the runner states one line per site ─────────────

export const runEvents = {
  started: (run: WorkflowRun) => emitRunEvent(run, 'run.started', { auto_run: run.autoRun, started_by: run.startedBy, steps: run.steps.length, runner: run.sandbox ? 'sandbox' : 'host' }),
  stepStarted: (run: WorkflowRun, step: { stepId: string, agentSlug: string, label: string, visits: number }) =>
    emitRunEvent(run, 'step.started', { step_id: step.stepId, agent: step.agentSlug, label: step.label, visit: step.visits }),
  stepFinished: (run: WorkflowRun, step: { stepId: string, agentSlug: string, label: string, visits: number, status: string, model?: string | null, startedAt?: number, completedAt?: number, usage?: { input_tokens: number, output_tokens: number, cache_read_input_tokens?: number, usd?: number } | null, error?: string }) =>
    emitRunEvent(run, 'step.finished', {
      step_id: step.stepId, agent: step.agentSlug, label: step.label, visit: step.visits, status: step.status,
      model: step.model ?? null,
      input_tokens: step.usage?.input_tokens, output_tokens: step.usage?.output_tokens,
      cache_read_input_tokens: step.usage?.cache_read_input_tokens, usd: step.usage?.usd,
      duration_ms: step.startedAt && step.completedAt ? step.completedAt - step.startedAt : undefined,
      error: step.error ? step.error.slice(0, 300) : undefined,
    }),
  gateRequested: (run: WorkflowRun) => emitRunEvent(run, 'gate.requested', {
    step_id: run.question?.stepId, kind: run.question?.kind, reason: run.question?.reason, assignee: run.question?.role, status: run.status,
  }),
  gateAnswered: (run: WorkflowRun, answer: { by?: string, verdict?: string, stepId?: string, askedAt?: number, at?: number }) => emitRunEvent(run, 'gate.answered', {
    step_id: answer.stepId ?? run.question?.stepId, assignee: answer.by, verdict: answer.verdict,
    waited_minutes: answer.askedAt ? Math.round(((answer.at ?? Date.now()) - answer.askedAt) / 6000) / 10 : undefined,
  }),
  settled: (run: WorkflowRun) => emitRunEvent(run, 'run.settled', {
    status: run.status, usd: run.usage?.usd, input_tokens: run.usage?.input_tokens, output_tokens: run.usage?.output_tokens,
    cached_tokens: run.usage?.cached_tokens, active_ms: run.activeMs, error: run.error ? run.error.slice(0, 300) : undefined,
    steps_failed: run.steps.filter(s => s.status === 'failed').length,
  }),
}

// ── the daily spend circuit breaker ──────────────────────────────────────────

/** The caps in force: AGENT_DAILY_SPEND_USD_CAP over the saved instance cap; per-product caps from settings only. */
export function spendCaps(): { instance?: number, byProduct: Record<string, number> } {
  const s = agentManagerSettings()
  const env = Number(envString('AGENT_DAILY_SPEND_USD_CAP'))
  const instance = env > 0 ? env : (typeof s.dailySpendUsdCap === 'number' && s.dailySpendUsdCap > 0 ? s.dailySpendUsdCap : undefined)
  const byProduct: Record<string, number> = {}
  for (const [k, v] of Object.entries(s.dailySpendUsdCapByProduct ?? {})) if (typeof v === 'number' && v > 0) byProduct[k] = v
  return { instance, byProduct }
}

/** The UTC day a time falls on, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * USD spent today, from the runs themselves: every run that worked today,
 * priced the way the cost report prices it. A run that started yesterday and
 * is still going counts in full today, which errs towards tripping.
 */
export function dailySpend(runs: Pick<WorkflowRun, 'usage' | 'startedAt' | 'endedAt' | 'status' | 'product' | 'testOf'>[], now = Date.now(), product?: string): number {
  const today = utcDay(now)
  let usd = 0
  for (const r of runs) {
    if (r.testOf) continue
    if (product && r.product?.name !== product) continue
    const last = r.endedAt ?? now
    if (utcDay(last) !== today && utcDay(r.startedAt) !== today) continue
    usd += r.usage?.usd ?? 0
  }
  return Math.round(usd * 10000) / 10000
}

/**
 * Whether starting a run of `product` now would exceed a daily cap. Returns
 * the reason in words, or null while under every cap that applies.
 */
export function spendCapHit(runs: Parameters<typeof dailySpend>[0], product?: string, now = Date.now(), caps = spendCaps()): string | null {
  if (caps.instance !== undefined) {
    const spent = dailySpend(runs, now)
    if (spent >= caps.instance) return `Daily spend cap reached: $${spent.toFixed(2)} of this instance's $${caps.instance.toFixed(2)} cap spent today (UTC).`
  }
  if (product && caps.byProduct[product] !== undefined) {
    const spent = dailySpend(runs, now, product)
    if (spent >= caps.byProduct[product]!) return `Daily spend cap reached for ${product}: $${spent.toFixed(2)} of its $${caps.byProduct[product]!.toFixed(2)} cap spent today (UTC).`
  }
  return null
}

/** Reads a run's events back from its JSONL file; empty when there is none. For the API and tests. */
export async function readRunEvents(runId: string): Promise<RunEvent[]> {
  try {
    const raw = await readFile(eventsFile(runId), 'utf-8')
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l) as RunEvent)
  } catch {
    return []
  }
}

/** Every run id with an events file. */
export async function runsWithEvents(): Promise<string[]> {
  try {
    return (await readdir(eventsDir())).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6))
  } catch {
    return []
  }
}
