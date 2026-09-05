# Run manager: restart, resume and clone workflow runs

Date: 2026-09-05
Status: approved in discussion, awaiting spec review

## Problem

A workflow run that fails, is stopped, or loses its server process cannot be
resumed. Every step's input and output is already persisted in the run record,
but the runner keeps its scheduling state (graph, armed nodes, outputs) only in
memory. The only recovery is a brand-new run from step one. On Runbook A that is
30 to 40 minutes and several million tokens to re-test a fix to the last step.

Three developer overheads follow from that one gap:

1. Re-running from a failed step is impossible.
2. Starting a run with the same inputs means re-typing them in the modal.
3. There is no screen that shows every run across workflows with what happened
   and what can be done about it.

## Goals

- Restart a run from any settled step, keeping earlier steps' outputs and the
  same artifacts directory, so evidence accumulates instead of being discarded.
- Continue a run whose server process died, from the step that was executing.
- Clone a run's inputs into the Run modal with one click.
- A Runs page listing every run across workflows with status, timing, per-step
  progress and actions. Opening a run lands in the existing builder.

## Non-goals

- Editing a step's input before restarting.
- Restarting into a different branch of the graph than the graph would take.
- Any change to how monitors, retries, pause or run-to-completion behave.
- A new editor. The builder page stays the detail view.

## Design

### Server

#### `rehydrate(run, workflow)` in `server/utils/workflowRunner.ts`

Rebuilds the in-memory `Live` record from a persisted run:

- `graph` from `buildGraph(workflow.steps)`.
- `state` from `initRunState(graph)`, then for every step in `run.steps` whose
  status is `completed`, call `markCompleted(graph, state, id)` in step order and
  set `state.visits[id]` from `step.visits`. Steps that are `failed`, `skipped`,
  `pending` or `running` stay pending and unarmed unless a completed predecessor
  arms them, which `markCompleted` already does.
- `outputs[id]` and `lastInputs[id]` from each completed step's `output` and
  `input`.
- `retryFeedback` empty, `stopped` false, `running` false.

The result is registered in `live` under the run id. Because `readyNodes`
derives what runs next from `armed` and `status`, the existing wave loop
continues a rehydrated run exactly as it would a live one.

Workflow steps are loaded from the workflow file via the existing
`GET /api/workflows/:slug` shape. A run whose workflow no longer exists cannot be
rehydrated: the endpoints return 409 with a message naming the missing workflow.

#### `restartRun(runId, fromStepId)`

Allowed when `run.status` is `failed`, `stopped`, `interrupted` or `completed`.
A `paused` run uses Continue; a `running` run is refused with 409.

1. Load the run and its workflow, rehydrate.
2. Compute the reset set: `fromStepId` plus every transitive forward successor
   of it in the graph.
3. For each step in the reset set: snapshot the current step artifact as
   `restart-<visits>` via `writeStepArtifact`, the same convention monitor
   retries use, then reset the persisted step to `pending` with empty output,
   error, timestamps and verdict, and in `state` set status `pending`, armed
   `false`. Visits are kept, so `cost.attempts` stays honest and `maxVisits`
   still caps a step that keeps failing.
4. Re-arm `fromStepId` by re-marking each of its completed forward predecessors
   with `markCompleted`, or arming it directly if it is a graph entry.
5. Set `run.status` to `running`, clear `run.error` and `run.endedAt`, set
   `run.pid` to the current process, publish, then `driveToSettlement` in the
   background exactly as `startRun` does. `autoRun` is preserved from the run.

The one-active-run-per-workflow rule still holds: restart is refused with 409
if another run of the same workflow is running or paused.

#### Continue on an interrupted run

`continueRun` currently returns early when the run has no `Live` record. Change:
if the run is `interrupted`, rehydrate and then restart from the steps in
`currentStepIds`, which are the steps that were executing when the process
died. This is `restartRun` applied to each of those ids. The client already
shows Continue only for paused runs; the panel will also show it for
interrupted runs, labelled "Resume".

#### Endpoints

- `POST /api/runs/:id/restart` body `{ stepId }` returns the run.
- `GET /api/runs` returns `listRuns()` across all workflows, newest first.

Clone needs no endpoint.

### Client

#### Runs page `app/pages/runs.vue`, sidebar entry "Runs"

Added to `navTop` after Workflows with icon `i-lucide-play-circle`. Lists
`GET /api/runs`, refreshed every 5 seconds while any run is running or paused.
One row per run:

- workflow name, status badge, started, duration
- the per-step segment bar already drawn by `WorkflowRunPanel`, extracted into
  a small `RunProgressBar` component so both use one implementation
- actions: Open, Restart, Clone, Stop
  - Open navigates to `/workflows/<slug>?run=<id>`
  - Restart appears on failed, stopped and interrupted runs and calls restart
    with the first failed step, or the first of `currentStepIds` for an
    interrupted run
  - Clone navigates to `/workflows/<slug>?clone=<id>`
  - Stop appears on running and paused runs

Filters: a text filter on workflow name and a status select. Nothing else.

#### Workflows page `app/pages/workflows/index.vue`

Each workflow card gets a Run button. It navigates to
`/workflows/<slug>?start=1`, which opens the builder with the Run modal already
open. Cards with no steps show the button disabled with the reason as its
tooltip, matching the builder's own `canRun` rule. No other change to the page.

#### Builder `app/pages/workflows/[slug].vue`

- On load, if `?run=<id>` is present, attach that run instead of the newest
  active one. If `?clone=<id>` is present, open the Run modal prefilled with
  that run's `initialPrompt`, `projectDir` and `autoRun`. If `?start=1` is
  present, open the Run modal empty. The query is consumed once and removed
  from the URL so a reload does not reopen the modal.
- `WorkflowRunModal` gains optional `initial` props for those three values.

#### Run panel `app/components/WorkflowRunPanel.vue`

- When the run is not running or paused, each settled step row gets a
  "Restart from here" action that emits `restart` with the step id.
- Finished runs get a "Clone run" button that emits `clone`.
- Interrupted runs show "Resume" in place of Continue, emitting `continue`.
- `useWorkflowRun` gains `restart(stepId)` using the existing `act` helper with a
  body, and the page wires both emits.

## Data flow for a restart

Runs page → `POST /api/runs/:id/restart {stepId}` → `restartRun` rehydrates,
resets, publishes `running` → SSE stream on the builder page shows the step
running → wave loop runs, monitors and pause behave as before → run settles.

## Error handling

- Unknown run: 404. Unknown step id: 400 naming the id.
- Workflow file missing: 409 naming the workflow.
- Another active run for the workflow: 409 with that run's id, matching the
  existing start endpoint's shape so the client can attach to it.
- A restart while the run is `running`: 409.

## Testing

Extend `scripts/test-workflow-runner.mjs` with the stubbed agent caller:

1. A three-step run whose second step fails; restart from step two re-runs only
   steps two and three, step one's output is reused in step two's input, and
   the `restart-1` artifact snapshot exists.
2. Rehydrate from disk: after a failed run, drop the `live` map entry (simulating
   a restart), restart, and assert it proceeds.
3. Restart refused while running, and on a missing step id.
4. Interrupted run: mark `pid` dead, assert `getRun` reads `interrupted`, then
   continue and assert the executing step re-runs.

Live verification through the UI with agent-browser: on the Runs page, restart
the failed final step of run `bdf4a656`, watch it open in the builder, and
confirm the PR step completes. Then clone that run from the Runs page and
confirm the modal is prefilled. Screenshots of each state.

## Files

- `server/utils/workflowRunner.ts`: `rehydrate`, `restartRun`, interrupted
  continue.
- `server/api/runs/[id]/restart.post.ts`, `server/api/runs/index.get.ts`: new.
- `app/composables/useWorkflowRun.ts`: `restart`.
- `app/components/WorkflowRunPanel.vue`: per-step restart, clone, resume.
- `app/components/RunProgressBar.vue`: extracted segment bar.
- `app/components/WorkflowRunModal.vue`: `initial` props.
- `app/pages/runs.vue`: new. `app/app.vue`: nav entry.
- `app/pages/workflows/index.vue`: Run button on each card.
- `app/pages/workflows/[slug].vue`: `run`, `clone` and `start` query handling.
- `scripts/test-workflow-runner.mjs`: new cases.
