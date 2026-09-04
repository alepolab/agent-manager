# Server-Side Workflow Runs

Design for making a workflow run a server-owned object with persisted,
observable status — so a run survives leaving the page, and opening a workflow
shows what it is doing right now, per agent.

## The problem

Today a run exists only in one browser tab's memory.

`useWorkflowExecution.ts` holds every piece of run state in refs (`steps`,
`isRunning`, `isPaused`, `currentStepIds`), and the browser *drives* the run:
each step is a `$fetch` from the client to `/api/chat`. The only thing that
outlives the tab is `Workflow.lastRunAt` — a timestamp.

The consequences are worse than a missing status panel:

| Action | What happens today |
|---|---|
| Close the tab mid-run | The run dies after the in-flight step |
| Reload the page | Visibility lost; the run does not resume |
| Open the workflow in a second tab | No run appears to exist |
| Return later to check progress | There is nothing to return to |

This also silently bounds the auto-run feature: an unattended Runbook A run is
alive only as long as its tab is.

## Goal

1. A run is owned by the server. Starting one returns a run id; the server
   drives the graph to completion whether or not anyone is watching.
2. Opening a workflow shows any active run, live, without the viewer having
   started it.
3. **Per-agent status is first class** — for each step: which agent, its
   status, when it started and finished, how many visits, and its output.
4. Run history persists, so a finished run can be read afterwards.

## Non-goals (this pass)

- Multi-user concurrency control. Single-operator assumption holds, as it does
  everywhere else in this app.
- Resuming a run across a *server* restart. A run interrupted by a server
  restart is marked `interrupted` on next read, not silently resurrected —
  claiming a run survived when its driving process died would be the same class
  of lie this design exists to remove.
- Changing what a step does. The agent call, monitor verdicts, retry semantics
  and fan-in behaviour are ported as-is, not redesigned.

## Architecture

### Where the graph logic lives

`app/utils/workflowGraph.ts` holds the pure scheduler — `buildGraph`,
`readyNodes`, `markCompleted`, `canRevisit`, `joinInputs`, `MAX_CONCURRENCY`.
The server needs exactly this logic, and this repo's `CLAUDE.md` is explicit
that app utils cannot be imported server-side.

**Duplicating it is not an option** — two copies of a scheduler drift, and the
drift shows up as a workflow that behaves differently depending on who started
it, which is close to undebuggable.

Nuxt resolves a `shared/` directory in this version (verified empirically:
`composablesDirs.push(resolve(layer.config.rootDir, layer.config.dir?.shared ??
"shared", "utils"))` in the installed `nuxt/dist/index.mjs`), and the project
already sets `future: { compatibilityVersion: 4 }`.

Move `workflowGraph.ts` to `shared/utils/workflowGraph.ts`, importable from
both sides. `scripts/test-workflow-graph.mjs` moves with it and must keep
passing unchanged — it is the proof the move was behaviour-preserving.

**The implementer must verify the server-side import actually resolves before
building on it.** If it does not, stop and report rather than falling back to a
duplicate.

### Components

```
shared/utils/workflowGraph.ts     moved, unchanged   the pure scheduler
shared/types/run.ts               new                WorkflowRun, RunStep

server/utils/workflowRunStore.ts  new                persistence
server/utils/workflowRunner.ts    new                the run loop
server/api/workflows/[slug]/runs.post.ts   new       start a run
server/api/workflows/[slug]/runs.get.ts    new       runs for this workflow
server/api/runs/[id].get.ts                new       one run, full detail
server/api/runs/[id]/stream.get.ts         new       SSE live updates
server/api/runs/[id]/continue.post.ts      new       continue a paused run
server/api/runs/[id]/respond.post.ts       new       reply to a step
server/api/runs/[id]/stop.post.ts          new       stop a run

app/composables/useWorkflowRun.ts new                subscribes; replaces the driver
app/components/WorkflowRunPanel.vue new              status + per-agent rows
app/pages/workflows/[slug].vue    modified           hosts the panel, attaches to active runs
```

`app/composables/useWorkflowExecution.ts` is **deleted**, not left beside the
new path. Two engines that can both run a workflow is the same drift problem as
two schedulers.

### Persistence

One JSON file per run at `~/.claude/workflow-runs/{runId}.json`, matching how
this app already persists CLI history and chat sessions under `CLAUDE_DIR`.

Written on every state transition — a status that is only accurate when the
process exits cleanly is not a status. Writes are last-write-wins on a single
in-process owner; no locking, consistent with the single-operator assumption.

### Data model

```ts
type RunStatus = 'running' | 'paused' | 'completed' | 'failed'
               | 'stopped' | 'interrupted'

interface RunStep {
  stepId: string
  label: string
  agentSlug: string          // the agent — what the operator actually wants to see
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  input: string
  output: string
  error?: string
  startedAt?: number
  completedAt?: number
  visits: number
  monitorVerdict?: 'CONTINUE' | 'RETRY' | 'ABORT'
  monitorNote?: string
}

interface WorkflowRun {
  id: string
  workflowSlug: string
  workflowName: string
  status: RunStatus
  autoRun: boolean
  initialPrompt: string
  projectDir?: string
  steps: RunStep[]
  currentStepIds: string[]
  nextStepIds: string[]
  startedAt: number
  endedAt?: number
  error?: string
  pid: number                // whose process owned it — see `interrupted` below
}
```

`interrupted`: on read, a run whose status is `running`/`paused` but whose
owning process is gone is reported as `interrupted`. This is computed at read
time rather than written, because the process that would have written it is by
definition not there.

### Live updates

SSE at `GET /api/runs/[id]/stream`, matching `/api/chat`'s existing pattern
rather than introducing a third transport. Events: `step_update`,
`run_update`, `done`. The client reconciles against the full run object it
fetched on load, so a missed event self-heals on the next one.

Polling is the fallback if SSE proves awkward through the container — the
run object is small and `GET /api/runs/[id]` is cheap.

### Concurrency

One run per workflow at a time. Starting a run while one is active returns
`409` with the active run's id, and the UI offers to attach to it instead.
Two concurrent runs of the same workflow against the same `projectDir` would
have their agents editing the same files.

## What the operator sees

On `/workflows/[slug]`:

- **No active run** — the run history list, most recent first.
- **Active run** — a status panel at the top, live, whether or not this tab
  started it: overall status, elapsed time, and a row per agent showing status,
  duration, visit count, monitor verdict where present, and expandable output.
- **Paused** — the same continue / continue-with-edit / respond controls that
  exist today, now posting to the run endpoints instead of driving locally.

The per-agent rows are the point of the feature: a workflow is a set of agents,
and "which agent is running, and what has it produced" is the question being
asked.

## Error handling

- A step failing marks the run `failed`, skips pending steps, and persists —
  identical to today's behaviour, just durable.
- The SSE stream closing does not affect the run. The run is not the connection.
- A malformed or missing run file yields a `404`, never a crashed page.
- A run whose owning process died reads back as `interrupted`, with its steps
  frozen at their last persisted state.

## Testing

- `scripts/test-workflow-graph.mjs` must pass **unchanged** after the move —
  the proof the scheduler was not altered in transit.
- New `scripts/test-workflow-run-store.mjs`: create, transition, persist,
  reload, list, and the `interrupted` computation for a dead owner.
- The runner's step execution is exercised against a stub agent call rather
  than live API calls, so the loop is testable without spending tokens.
- Manual: start a run, close the tab, reopen the workflow, confirm the run is
  still going and the per-agent rows are live.

## Migration

`useWorkflowExecution.ts` and its callers change in one commit — the composable
is deleted and `[slug].vue` moves to the new composable together. Leaving both
paths alive briefly is how two engines happen.

No stored data migrates: no runs are persisted today, so there is nothing to
convert.
