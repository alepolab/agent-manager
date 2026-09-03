# Workflow Watcher — auto-refresh and dispatch

Design for a scheduled poller that picks up new tickets on an interval and
dispatches a workflow run for each, without ever wedging on one that fails.

This is Loop 1 of the *Ticket to Merge-Ready* flow, scoped to what the app can
own today.

## The problem

Every run today starts because a human typed a prompt and clicked Run. Nothing
picks work up on its own, which is the brief's central diagnosis: *almost
nothing runs unattended*.

## Goal

1. Poll a ticket source every N seconds and dispatch a run for each new ticket.
2. Never dispatch the same ticket twice.
3. **A ticket whose run fails must not block the queue.** The next cycle
   processes every other ticket regardless.
4. A ticket that fails repeatedly is escalated and permanently skipped, not
   retried forever.

Point 3 is the requirement that shapes the design. A naive poller that loops
over tickets and lets an exception propagate stops processing the rest of that
cycle — and if the first ticket is poisoned, nothing after it ever runs.

## Product decisions (confirmed)

1. **The ticket source is pluggable, and ships with a stub.** The app has no
   Jira integration today, and the Atlassian MCP is bound to an interactive
   session rather than to this server process. Building the loop against a
   `TicketSource` interface means the scheduling, dedupe, isolation and cap
   logic is real and testable now, and Jira slots in later without redesign.
2. **Three attempts, then escalate.** Matching the implementation plan: retry
   up to 3 times, then mark the ticket `escalated`, record why, and never pick
   it up again. The queue cannot wedge on a poisoned ticket.

## Dependency

This requires **server-side workflow runs** (separate spec, in progress). A
poller that starts browser-driven runs is meaningless — nobody's browser is
open at 3am. The watcher calls the same run API the UI does.

## Architecture

```
shared/types/watch.ts            new   Watch, TicketRef, TicketState
server/utils/ticketSource.ts     new   the TicketSource interface + a file-backed stub
server/utils/watchStateStore.ts  new   per-ticket state, persisted
server/utils/watchScheduler.ts   new   the poll loop
server/plugins/watcher.ts        new   starts the scheduler with the server
server/api/watches/*             new   list watches, read state, pause/resume, force a poll
app/pages/watches.vue            new   operator view: what is being watched, what was picked up
```

### The ticket source seam

```ts
export interface TicketRef {
  key: string            // 'CSUP-7435' — the identity everything else keys on
  summary: string
  description: string
  updatedAt: number
}

export interface TicketSource {
  /** Tickets currently matching this watch. Returning a ticket repeatedly is
   *  expected and harmless — dedupe is the scheduler's job, not the source's. */
  fetch(watch: Watch): Promise<TicketRef[]>
}
```

The stub reads from `~/.claude/watch-tickets/<watchId>.json`, so the whole loop
is exercisable — including failure isolation — by editing a file. A Jira source
implementing the same interface is a later, additive change.

### Per-ticket state — where failure isolation lives

State is keyed by **ticket**, not by run. A run record answers "what happened
in this attempt"; the watcher needs "should I touch this ticket at all".

```ts
type TicketDisposition =
  | 'new'         // seen, not yet dispatched
  | 'dispatched'  // a run is in flight
  | 'done'        // its run completed
  | 'failed'      // its run failed, attempts remain
  | 'escalated'   // attempts exhausted — never picked up again

interface TicketState {
  key: string
  watchId: string
  disposition: TicketDisposition
  attempts: number
  lastRunId?: string
  lastError?: string
  firstSeenAt: number
  updatedAt: number
}
```

Persisted at `~/.claude/watch-state/<watchId>.json`, matching how runs, CLI
history and chat sessions already persist under `CLAUDE_DIR`.

### The poll cycle

For each enabled watch, every `intervalSeconds`:

1. `source.fetch(watch)` — every ticket currently matching.
2. Drop tickets whose disposition is `dispatched`, `done` or `escalated`.
   This is "label on pickup": two overlapping cycles never grab the same one.
3. Drop tickets over the concurrency cap and the daily dispatch cap.
4. For each remaining ticket, **in its own try/catch**, start a run and mark it
   `dispatched`.

Step 4's isolation is the whole point:

```
for (const ticket of eligible) {
  try { await dispatch(ticket) }
  catch (err) { await recordFailure(ticket, err) }   // then CONTINUE
}
```

A thrown error records against that ticket and the loop moves on. One bad
ticket costs one ticket.

### Failure and escalation

When a dispatched ticket's run reaches a terminal state, the watcher reconciles:

- Run `completed` → `done`.
- Run `failed`, `stopped` or `interrupted` → `attempts += 1`. Under 3, back to
  `failed` and eligible next cycle. At 3, `escalated` with the reason recorded.

An `escalated` ticket is never fetched into the eligible set again. Clearing one
is a deliberate operator action from the watches page — not something the
scheduler decides.

Reconciliation happens at the *start* of each cycle, so a run that finished
while the app was down is still accounted for.

### Caps

- `maxConcurrentRuns` per watch — a burst of new tickets must not spawn
  unbounded runs against the same repos.
- `dailyDispatchCap` per watch — the backstop against a JQL that matches far
  more than intended. Both come straight from the `watches.yaml` schema.
- **A new watch starts disabled.** Enabling it is an explicit act, so a
  mistyped query cannot dispatch on its first tick.

## Error handling

- The scheduler never throws out of a cycle. A source that fails is logged
  against the watch and retried next cycle; it does not stop other watches.
- A ticket whose workflow has an active run gets a `409` from the run API,
  which the watcher treats as "already in flight" — not a failure, no attempt
  consumed.
- Interval changes take effect on the next tick, not mid-cycle.
- Stopping the app stops the scheduler. Runs already in flight are reconciled
  on next start via their persisted state.

## Testing

- The stub source makes the whole loop testable with plain `node:assert`.
- **The isolation test is the important one**: a source returning three
  tickets where the *first* throws on dispatch must still dispatch the other
  two. That is the requirement in one assertion.
- Escalation: a ticket failing three times reaches `escalated` and is absent
  from the fourth cycle's eligible set.
- Dedupe: a ticket returned by two consecutive fetches dispatches once.
- Caps: eligible tickets beyond `maxConcurrentRuns` wait for the next cycle
  rather than being dropped.

## Out of scope

- The real Jira source, and the credentials it needs.
- Writing back to Jira (comments, transitions). The artifact's triage identity
  is comment-only; that arrives with the Jira source.
- Classification, dedupe against existing issues, and the context packet —
  Loop 1 steps 2–6. This spec covers pickup and dispatch only.
