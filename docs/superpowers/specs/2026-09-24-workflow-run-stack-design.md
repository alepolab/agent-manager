# Workflow run stack: build, test and watch runs as one vertical stack

Date: 2026-09-24
Status: approved in discussion, awaiting spec review
Builds on: `2026-09-05-run-manager-restart-clone-design.md`, the notifications inbox (`6049ae1`)

## Problem

A workflow is built on a free-form Vue Flow canvas, and a run of it is shown in
three places: `WorkflowRunBar` above the canvas, the "Run details" slideover
(`WorkflowRunPanel`), and `/runs/:id`. The builder has three further problems:

1. **Step kinds are hidden behind agent slugs.** Jira, notify and dispatch
   steps are chosen by picking `sdlc-jira-tracker`, `sdlc-notifier` or
   `sdlc-auto-dispatcher` as the agent. That reveals extra fields in one long
   settings modal.
2. **The canvas makes simple workflows look complex.** Every workflow in
   `~/.claude/workflows` (3 runbooks, 8 scan pipelines) is a straight line with
   at most one split. None has a `next[]` edge back to an earlier step. The
   canvas still asks you to position, pan and wire every node.
3. **A step can't be tried on its own.** Tuning one step means starting a whole
   run, 30 to 70 minutes and several dollars on Runbook A.

## Goals

- One component, the **run stack**, shows a workflow as a vertical column of
  step cards. It is used for building, for watching a live run, and for reading
  a finished one.
- `/workflows/[slug]` builds and runs a workflow in that stack, with typed
  actions in place of agent-slug tricks and a Setup / Configure / Test drawer.
- **Test** runs one step against a finished run's outputs, using the step's
  unsaved config, with no side effects.
- `/runs` lists runs across every workflow, and each run opens in the same
  stack.
- Retries and send-backs stay first-class and show on the stack itself.

## Non-goals

- A change to the workflow file format. Every edit writes the fields that exist
  today. The only additions are to the run record: `origin: 'test'`,
  `stopAfter`, `RunStep.headAtStart`, and agent entries in `decisions`.
- Any change to how monitors, retries, gates, rework limits or the graph engine
  decide what runs next.
- A cost estimate on the Test button.
- A change to `PipelineBoard` on the home page, or to the `/graph` relationship
  page.
- Arbitrary graph editing. A graph the stack can't draw opens read-only.

## Model mapping

| Today | In the stack |
|---|---|
| Watch or schedule pointing at the workflow | **Trigger** card at the top |
| `step.jira`, `step.notify`, `step.triggerWorkflow`, plain agent | Typed actions: Update Jira ticket, Create Jira tickets, Post to a channel, Loop over items, Run an agent |
| `step.approval` + `gateRole` | An **Approval** card drawn above the step it guards. The flag stays on that step. |
| `monitorSlug` + `maxVisits` | A **Check** badge and "Retries up to N" on the step card |
| `next[]` with 2+ targets, `runWhen` | **Paths**: side-by-side branches, each with a condition. Branches either rejoin or end separately. |
| Rework (human send-back or `PIPELINE-REWORK`) | A return arrow in the left margin, drawn in run mode only |

A send-back target is chosen while the run is going: it can be any other step of
the run, and there is a limit of 2 (`REWORK_LIMIT`, `rework.post.ts`). So the
builder has nothing to configure for it. The Approval card states the rule in
one line.

## Design

### 1. Stack layout (`shared/utils/workflowStack.ts`, new)

- `toStack(steps): { ok: true, blocks: Block[] } | { ok: false, reason: string }`
  - `Block = { kind: 'step', stepId } | { kind: 'paths', branches: Block[][], rejoin: boolean }`
  - A step with no `next` follows the next step in array order, as the graph
    engine does today.
  - A graph is drawable when it splits into series and parallel blocks: each
    split either rejoins at one step or every branch ends separately.
    Anything else (cross edges between branches, back edges, a branch that
    rejoins at a step in another split) returns `ok: false` with a reason that
    names the steps involved.
  - Nested paths are allowed in the layout, but the builder only creates one
    level.
- `fromStack(blocks, steps): WorkflowStep[]` is the inverse. It writes explicit
  `next[]` on every step and leaves every other field, `position` included,
  untouched.
- Pure functions with no Vue or server imports, so both layers can use them.

### 2. Run stack components

**`RunStack.vue`** takes a `workflow`, plus an optional `run` and `logs`. It walks
the blocks and renders:

- **The trigger card:** the manual prompt and parameters, or the watch or
  schedule that started the run.
- **One `RunStackCard.vue` per step.**
- **Paths** as side-by-side columns, each headed by its condition (the first
  step's `runWhen.artifact`, or "always").
- **The Approval card** above any step with `approval: true`.
- **Send-back arrows** in run mode, built from `run.decisions` entries with
  `verdict: 'sent-back'`. Each runs from the deciding step to `target`, and its
  label gives who sent it, the note, and "n of 2".

**`RunStackCard.vue`** has two modes:

- **Build mode:** type icon, label, agent, and chips for Check, `produces` and
  `runWhen`. Clicking it selects the step for the drawer.
- **Run mode:**
  - **Collapsed:** status dot (colour from `RUN_STATUS_COLOR`), label, type,
    duration, tokens and cost. Duration and cost come from `RunStep`, and
    cost from the existing `/api/runs/:id/cost`.
  - **Expanded:**
    - **In:** the artifacts the step read, per its `contextMode`.
    - **Out:** `produces` and the step's artifacts.
    - **Check:** one tab per visit, each with that visit's `monitorVerdict`
      and `monitorNote`.
    - **Log tail:** the existing `LogLines`.
    - **Actions:**
      - Replay from here: `POST /api/runs/:id/restart`.
      - Ask this agent: the existing chat link.
      - Full log: opens `RunArtifacts` in a side panel.
  - **Loop over items:** shows its child runs as a count by status and links to
    `/runs?parent=<runId>`.

**The gate moves into the stack.** The card for `run.question.stepId` hosts
everything at the top of `WorkflowRunPanel` today, moved and not rewritten:

- the gate banner text and role, and whether it is yours
- `RunDecisionPanel` and `RunVerdictCard`
- "Earlier decisions"
- the Reply, Approve, Send back, Reject and "Continue with a fresh allowance"
  actions

**The run header** (inside `RunStack`, run mode) has:

- status pill and ticket
- elapsed time
- tokens against `budget.maxTokens`
- cost
- the note-to-agent box
- Clone and Stop

**Agent send-backs get recorded.** Where the runner applies a rework
(`workflowRunner.ts`, the `l.rework` hand-over around line 2032), it also
appends a `RunDecision` with:

- `verdict: 'sent-back'`
- `by: 'agent:<slug>'`
- `note` set to the instruction
- `target`
- `waitedMs: 0`

Human send-backs already write one. Without this, only human send-backs would be
drawn.

**Removed:** `WorkflowRunBar.vue` and the "Run details" slideover.
`WorkflowRunPanel.vue` is removed once its pieces live in `RunStack` and its
callers (`runs/[id].vue`, `NotificationRunDetail`) use the new component.

### 3. Builder (`app/pages/workflows/[slug].vue`)

The page is a header plus `RunStack` in build mode plus a right drawer. A
**Build | Run #n** switch in the header shows the live or selected run of this
workflow in run mode. The URL carries `?run=<id>`.

**Trigger card drawer**

This replaces the Schedule tab, the "Inputs (n)" modal and the header selects.
It has three tabs:

- **Triggers:**
  - Lists the schedules and watches whose `workflowSlug` is this workflow.
  - "Add schedule" opens the existing `ScheduleFormModal`.
  - "Add Jira watch" links to `/watches`.
- **Inputs:** the existing `parameters` editor.
- **Settings:** concurrency group and notification channel.

**Adding a step.** Every "+" between cards opens the action picker. Each choice
writes today's fields:

| Choice | Writes |
|---|---|
| Run an agent | `agentSlug` |
| Update Jira ticket | `agentSlug: sdlc-jira-tracker`, `jira{transition, comment, attach}` |
| Create Jira tickets | `agentSlug: sdlc-jira-creator`, `jira{action: 'create', source}` |
| Post to a channel | `agentSlug: sdlc-notifier`, `notify{channel, message}` |
| Loop over items | `agentSlug: sdlc-auto-dispatcher`, `triggerWorkflow{...}` |
| Ask for approval | `approval: true` and `gateRole` on the step below the "+" |
| Split into paths | a `paths` block with two empty branches and a Rejoin toggle |

**Step drawer**

- **Setup:** the action type and, for agent steps, the agent.
- **Configure:** only the fields for that type. They are today's step-settings
  fields, split by type:
  - **Agent:** `produces`, context mode, `testsUnlocked`, max visits, monitor
    agent, `continuesSession`.
  - **Jira:** transition, comment and attach, or the create source.
  - **Notify:** channel and message.
  - **Loop:** `source` / `fromParameter`, `itemParameter`, `join`, `routeBy`,
    `routes`, fallback `slug`.
- **Test:** see section 4.

**Editing**

- A path's condition is its first step's `runWhen`. An empty condition means
  the branch always runs.
- Drag-reordering works only among siblings at the same level.
- Deleting a step reconnects its predecessor to its successors.
- Deleting the Approval card clears `approval` on the step it guards.

**Saving and read-only workflows**

- Save calls `fromStack` and the existing `PUT /api/workflows/[slug]`.
- When `toStack` returns `ok: false`, the page opens read-only with the reason
  and offers no editing. The file is never reshaped.

**Removed:**

- the Vue Flow canvas, `WorkflowNode.vue`, the agent palette, the step settings
  modal and the Schedule tab
- `@vue-flow/*` from `package.json`, if nothing else imports them (check at
  plan time)

**Narrow screens:** the drawer becomes a bottom sheet.

### 4. Test a step

**The Test tab has:**

- a run picker: finished runs of this workflow, newest selected
- a **Test step** button
- the result: status, monitor verdict, what the step produced, log tail, tokens
  and cost, and a link to the test run

**Endpoint:** `POST /api/runs/:id/test` with body `{ stepId, stepOverride? }`.
`stepOverride` is the drawer's current, possibly unsaved, step config. The
endpoint calls `startTestRun`, a new function in `workflowRunner.ts`, which:

1. **Copies the source run.** It creates a new run record with a new id,
   `origin: 'test'` and `parentRunId` set to the source. Parameters, prompt and
   product are copied.
2. **Copies the earlier work.** Steps before `stepId` are copied in as
   completed, with their outputs. Their artifacts are copied into the test
   run's artifacts directory.
3. **Cuts its own branch.** It creates branch and worktree
   `test/<sourceRunId>-<stepId>-<n>` from the tested step's
   `RunStep.headAtStart`, if the source run recorded one. Otherwise it cuts from
   the source run's branch head and puts a warning on the result: "Code is the
   state at the end of run #n, not when this step ran".
4. **Runs the one step.** It runs `stepId` with `stepOverride` merged over the
   saved step, and `stopAfter: stepId`: the runner settles the run as completed
   (or failed) after that step and arms nothing downstream.
5. **Cleans up.** It removes the worktree and deletes the branch when the run
   settles. The artifacts stay with the test run.

**No side effects**

- In a run with `origin: 'test'`, Jira, notify and loop steps are dry runs.
  They record what they would have done (transition, comment, message, the
  child-run list) as the step's output and artifact. They call no external
  service and start no child run.
- `stopAfter` guarantees that no PR, push or Jira update downstream runs.

**Kept apart from real runs:**

- Hidden from `/runs` by default, with a "Tests" filter chip.
- Excluded from watch caps, `dailyDispatchCap` and concurrency group slots.
- Never produce a notification item. Monitors still run, but a test never pauses
  for a gate: an approval flag on the tested step is ignored.
- Reported as a separate "tests" line in `costReport.ts`.
- Stop at the workflow's normal `budget.maxTokens`.

**New run fields**

- `RunStep.headAtStart?: string` is recorded when a step starts, only in runs
  that have a worktree.
- `WorkflowRun.origin` gains the value `'test'`.
- `WorkflowRun.stopAfter?: string`.

### 5. `/runs` and `/runs/:id`

**`/runs`** is a two-column page.

- **The list** has one row per run:
  - ticket or first prompt line, workflow name
  - status pill, elapsed time, cost
  - a segmented progress bar, one segment per step
  - a live line for running runs (`assistantMessages`, `lastTool`,
    `lastActivityAt`, from what `RunLiveCard` shows today)
- **Filter chips:** All, Waiting on me, Running, Failed, Tests.
  - "Waiting on me" uses `isWaitingOnAPerson` plus the gate-role test from the
    notifications inbox.
  - `?parent=<runId>` filters to one run's children.
- **Bulk action:** "Delete N failed" stays.
- **The right column** shows the selected run in `RunStack`, run mode.
- **Narrow screens:** list only. A row opens `/runs/:id`.

**`/runs/:id`**

- `RunStack` in run mode, full width.
- "Open in builder" goes to `/workflows/[slug]?run=<id>`.
- `#step-<stepId>` scrolls to that card and expands it.

**Notifications inbox**

- Its links point at `/runs/:id#step-<stepId>`.
- `NotificationRunDetail` renders the same Approval card component, so a
  decision looks and behaves the same everywhere.

## Testing

**Plain-node tests** (`scripts/test-*.mjs`):

- `test-workflow-stack.mjs`:
  - `toStack` on all 11 real workflows, which must all succeed.
  - A round trip `fromStack(toStack(w))` that must give back the same `next[]`
    for each.
  - Rejection cases, which must each return `ok: false` with a reason:
    a back edge, a cross edge between branches, and a rejoin at a step outside
    the split.
- `test-test-run.mjs`:
  - `stopAfter` settles the run after the one step.
  - A test Jira, notify or loop step calls nothing external.
  - A test run holds no group slot and produces no notification item.

**Runner:**

- A step's rework appends an agent `RunDecision`.
- `headAtStart` is recorded on step start in a run with a worktree.

**UI, checked in the running app with agent-browser:**

- Build Runbook A from scratch in the stack and save. The file must match the
  shipped one apart from step ids.
- Test "Implement the fix" against a finished run. Nothing downstream runs and
  the source branch is untouched.
- Approve and send back from the Approval card on `/runs/:id` and from the inbox.
  The return arrow appears.
- 400px width: the stack and the bottom sheet work.

## Risks

- **Test code state.** Runs from before this change have no `headAtStart`, so
  their tests use the branch head. For implementer steps the fix may already be
  there. The warning on the result says so.
- **Test cost.** Each test spends real tokens with no estimate shown. The token
  budget is the only stop.
- **Moving the gate UI.** `WorkflowRunPanel` holds the approval, rework and
  budget logic behind existing flows. Its pieces move as they are, and its
  removal waits until both callers have switched.
- **Hand-edited workflows** with shapes the stack can't draw lose their editor.
  They stay runnable, and the read-only reason says what to change.
