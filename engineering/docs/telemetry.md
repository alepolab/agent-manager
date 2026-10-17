# Run telemetry and the daily spend breaker

Code: `server/utils/runEvents.ts`; emitted from `server/utils/workflowRunner.ts`
(`runEvents.*` and `emitTransitionEvents` inside `publish()`). Test: `scripts/test-run-events.mjs`.

## Events

| event | when | data |
|---|---|---|
| `run.started` | the wave loop begins (after preflight) | `auto_run`, `started_by`, `steps`, `runner` (host/sandbox) |
| `step.started` | a step's agent call begins | `step_id`, `agent`, `label`, `visit` |
| `step.finished` | the visit ended in a settled status | `status`, `model` (observed), `input_tokens` (fresh+cache, as `usageFrom` folds them), `output_tokens`, `cache_read_input_tokens`, `usd` (SDK's figure), `duration_ms`, `error` |
| `gate.requested` | the run stops on a person (question or approval) | `step_id`, `kind`, `reason`, `assignee` (the gate role), `status` |
| `gate.answered` | the person's decision moves the run on | `assignee` (who), `verdict`, `waited_minutes` |
| `run.settled` | completed / failed / stopped | `status`, `usd`, `input_tokens`, `output_tokens`, `cached_tokens`, `active_ms`, `steps_failed` |

Every event carries **tags**: `jira.key`, `run_id`, `product`, `origin`, `blast_radius`,
`workflow`, `watch`, `pod`, and `sandbox` (image) when sandboxed. `pod` is this instance:
`settings.pod` or `AGENT_MANAGER_POD`. Tags are read from the run at emit time, so events
after intake carry the classification; `run.started` does not when intake has not run yet.
Gate events fire on the transition (one per `askedAt`), not on every publish of the same
state. Test runs emit nothing.

## Where they go

1. **JSONL** — `<AGENT_RUNS_DIR>/events/<run id>.jsonl`, one event per line, appended as it
   happens. This is the ClaudeMetrics ingestion feed; `readRunEvents(runId)` reads it back.
2. **OTLP/HTTP** — when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (on the Agent Manager process):
   every event is one log record `POST <endpoint>/v1/logs`; `step.finished`, `run.settled` and
   `gate.answered` also post delta sums to `/v1/metrics`
   (`agent_manager.step.{input_tokens,output_tokens,cache_read_input_tokens,cost_usd,duration_ms}`,
   `agent_manager.run.{cost_usd,input_tokens,output_tokens,active_ms,settled}`,
   `agent_manager.gate.waited_minutes`). Resource attributes are the tags plus
   `service.name=agent-manager`. `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k=v`) is sent. Plain `fetch`,
   minimal OTLP JSON, 5 s timeout, failures logged once a minute per URL and dropped. No
   dependency added.
3. **Cost report** — unchanged: `costReport.ts` prices the run record's step usage, which is
   the same figure `step.finished`/`run.settled` carry, so `report-cost.mjs` and the events
   agree by construction.

## Claude Code's own telemetry

Each step's SDK env gets `OTEL_RESOURCE_ATTRIBUTES` with the same tags (merged with any the
host sets; ours win on a clash; values percent-encoded, spaces → `_`), so Claude Code's native
metrics/logs carry `jira.key`, `run_id`, `product`, `blast_radius`, `workflow`, `pod`. Enabling
that export is Claude Code configuration, not this app's: see `managed-settings.md` for the
`env` block (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`,
`OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`). In sandbox mode those `OTEL_*`
and `CLAUDE_CODE_ENABLE_TELEMETRY` variables are on the env allowlist and reach the container.

## Daily spend circuit breaker

`settings.dailySpendUsdCap` (USD per UTC day for the instance; `AGENT_DAILY_SPEND_USD_CAP`
overrides) and `settings.dailySpendUsdCapByProduct` (`{ "<product name>": usd }`). Spend is
computed from the runs themselves (`dailySpend`): every non-test run that worked today, at
the run's own `usage.usd`. Checked in `startOrQueue` (the automated path: watches,
schedules, dispatch) before admission; a manual Start is not held.

When a cap is reached the new run is **queued with `question.reason = 'budget'`** and a
message goes to the run's notify channel (or `SLACK_WEBHOOK_URL`): `<workflow>: HELD — Daily
spend cap reached…`. The run shows in the notifications inbox. It costs no slot. The queue
drain re-checks the cap on each pass and launches it when the day turns or the cap is
raised; **Continue** on the run sets `spendCapWaived` and lets the drain launch it past the cap.

```json
{ "agentManager": { "pod": "am-blr-1", "dailySpendUsdCap": 150, "dailySpendUsdCapByProduct": { "ASE CRM": 60 } } }
```
