---
description: List DEVOPS board issues raised in the last N seconds, so new infra work is picked up without waiting for a poll cycle.
argument-hint: [window-seconds]
allowed-tools: Read, mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql, mcp__claude_ai_Atlassian__getJiraIssue
---

List the issues raised on the **DEVOPS** board within the last N seconds.

## The window

Resolve N in this order, first hit wins:

1. The argument to this command, if given (`/tasks-picker-infra 300`).
2. `tasksPickerWindowSeconds` in `~/.claude/settings.json`.
3. `60`.

Say which source you used and what N is, so a surprising result is traceable
to its window rather than looking like an empty board.

## Querying, and the trap in it

**JQL has no sub-minute granularity.** `created >= -60s` is not valid — the
smallest relative unit is `-1m`. Querying `-1m` for a 60-second window is not
equivalent either: JQL's `-1m` is measured from *now* to minute precision, so
it silently returns issues older than the window as often as not.

So do it in two stages, and do not skip the second:

1. Query with the window **rounded UP** to whole minutes, so the result is a
   superset and nothing inside the window can be missed:

       project = DEVOPS AND created >= -{ceil(N/60)}m ORDER BY created DESC

2. Then filter the returned issues by their actual `created` timestamp,
   keeping only those within N seconds of now. This is where the real window
   is applied.

Report both numbers — how many the query returned and how many survived the
filter. A large gap is not an error; it is the rounding doing its job, and
seeing it is how someone notices the window is set smaller than is useful.

## Reporting

For each surviving issue: key, summary, type, priority, status, reporter, and
the browse URL. A table.

If none survive, say so plainly — "no DEVOPS issues raised in the last N
seconds" — and state the window. An empty result is a real answer here, not a
failure, and must not be dressed up as one.

## What this command does NOT do

It lists. It does not start a workflow run, transition an issue, comment, or
assign anything. Dispatching work is a separate, deliberate act — creating or
transitioning a Jira issue always needs the human's explicit go-ahead. If
something looks like it warrants a run, say so and let the human decide.
