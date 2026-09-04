# Runbook A — Jira-to-Diff Pipeline

Design for a one-click-installable Agent Manager workflow that implements
**B1 ("Runbook A")** from the *Agentic SDLC Brief* (Internal Weekly, 1 Sep
2026): a Jira ticket goes in, an evidence-carrying pull request comes out,
with no manual step in between except the review of that PR.

## Why

The brief's own framing: on the four CSUP tickets studied, the fix took 1.4
days on average and *verification* took 8.3 — none of the 8.3 was a coding
problem. Runbook A is the paper's proposed answer: an environment an agent
can create, an oracle it can read, and an evidence bundle a human can review
in minutes instead of a diff they have to re-derive trust in from scratch.

This is also the meeting's top action item ("Sandeep — start the
Jira-originated autonomous agent... Decided, start now", 02:17), reframed
per the brief's recommendation to make the evidence bundle the deliverable,
not the diff.

## Scope

**In scope:** the pipeline itself, as a Workflow template inside this app,
runnable against any repo checked out locally, targeting the
`alepo-dev-team-infra` compose conventions for stack stand-up. Full
autonomy through to an opened PR, per product decision below.

**Out of scope (fast-follow candidates, not built here):**
- Live Jira API fetch — v1 takes pasted ticket text/URL as the run prompt,
  identical to how every other workflow in this app already starts.
- A structured evidence-bundle viewer in the UI — v1's bundle is the
  markdown PR body, which is what the brief's R1 action actually asks the
  GitHub Checks API to carry.
- Blast-radius routing / adversarial review (the brief's *Review & Gate*
  stage) — a separate piece, not part of B1.
- A real `PreToolUse` hook enforcing the test-file lock (B3) — v1 relies on
  instruction text; the hook is the airtight version and is called out
  below as a named follow-on.

## Product decisions (confirmed with the user)

1. **PR creation is fully autonomous.** The final step pushes a branch and
   runs `gh pr create` without a code-level pause. The human gate is the PR
   review itself, not a stop-and-confirm inside the run — this matches the
   brief's own dispatch model (B5: "posts the PR link back") and is a
   deliberate, product-level choice, distinct from an assistant taking such
   actions unprompted mid-session.
2. **Stack stand-up targets `alepo-dev-team-infra` conventions**
   specifically (profiles, `alepo-shared` network, `TAG` var, etc., per the
   user's own CLAUDE.md), not a generic "guess the repo's test setup"
   agent. It runs on whatever host the Agent Manager server process itself
   runs on (the engineer's own machine — the same pattern used to deploy
   this app locally in this session), not the shared `.61` lab host, since
   neither this app nor an assistant session has automated shell access
   there.

## Architecture

No new page, no new data model. Runbook A ships as:

- One new **workflow template** (`app/utils/workflowTemplates.ts`)
- Seven new **agent templates** (`app/utils/templates.ts`), each declaring
  the tools and skills it needs
- One new **skill** (`agent-browser`, for the trace-capture step — see
  *Skills wiring* below)
- Three small, backward-compatible **engine changes**, because the current
  engine cannot run any of this without them (found during design review,
  not part of the original ask — see below)
- One **template-instantiation change** so a template can describe a
  fan-out/fan-in graph, not just a linear chain

### Engine changes (prerequisite — the pipeline cannot run without these)

All three are in `server/api/chat.post.ts`, the endpoint every workflow
step (and Agent Studio chat) executes through.

**E1 — Make `AgentFrontmatter.tools` actually bind.**

> **CORRECTION (added after the whole-branch review).** This section as
> originally written was factually wrong, and the error mattered. It claimed
> `allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep']` restricted agents
> and that "no workflow step can run a shell command, full stop." Neither is
> true. Per the SDK's own typings, `allowedTools` means *auto-allowed without
> prompting*; restricting the available set requires the separate `tools`
> option. This app also sets `permissionMode: 'bypassPermissions'` with
> `allowDangerouslySkipPermissions: true`, so the permission flow returns
> `allow` before allow-rules are consulted. **Every agent in this app,
> Agent Studio included, already had the full default toolset — Bash, Write,
> Edit, WebFetch, Task — before this branch.**
>
> Consequences to carry forward:
> - This branch granted no new capability. It added the *appearance* of
>   per-agent least privilege while enforcing none, which is worse than the
>   honest prior state.
> - An agent's displayed `tools` list is not a blast-radius bound unless and
>   until enforcement lands.

Today: the `tools` field defined on `AgentFrontmatter` (`app/types/index.ts:12`)
is read nowhere, and the hardcoded `allowedTools` restricts nothing.
Fix: bind the declared set through the SDK option that genuinely restricts
(`tools` / `disallowedTools`, verified empirically against the installed SDK,
not from typings). An agent declaring no `tools` must keep today's effective
behaviour, so existing agents and templates are unaffected; an agent declaring
an empty set must get nothing, which needs explicit handling because the SDK
ignores an empty list.

**E2 — Configurable `maxTurns`.**
Today: hardcoded to `10` for every call. Standing up a compose stack alone
can take more than 10 tool calls.
Fix: add an optional `maxTurns` field to `AgentFrontmatter`; use it when
present, otherwise keep the existing default of `10`.

**E3 — "Auto-run" toggle for a workflow run.**
Today: `useWorkflowExecution.ts` always sets `isPaused = true` after a wave
and waits for a manual click on `continueWorkflow()` — there is no
auto-advance path. This directly contradicts product decision #1: without
it, the run still stops after every one of the six wave boundaries.
Fix: an `autoRun` ref, settable from the run screen. When true, `runWave()`
calls `continueWorkflow()` itself as soon as a wave completes, *unless* the
wave contains a failed step or a monitor returned `ABORT` — both already
halt the run today via `finish()`/`isComplete`, so the failure path is
unchanged. Default `false`; every other workflow's behavior is unaffected.
Runbook A's template turns it on when the user starts a run from it.

### Template-instantiation change

`WorkflowTemplate.steps` (`app/utils/workflowTemplates.ts`) is today a flat
list — `{ agentTemplateId, label }` — and `useWorkflowTemplate()` in
`app/pages/workflows/index.vue` materializes each into a `WorkflowStep`
with no `next`, i.e. strictly linear (per the type's own comment: "Absent
means the next step in array order"). Runbook A needs steps 5 and 6 to run
as one parallel wave after step 4, and step 7 to fan in from both.

Fix: give template steps an optional `next?: string[]`, referencing other
steps' **template-local** ids. `useWorkflowTemplate()` builds a
template-id → generated-step-id map first, then translates each `next`
array through it when constructing the real `WorkflowStep[]`. Templates
that omit `next` behave exactly as before.

## The pipeline

```
1  sdlc-ticket-intake       Read, Grep, Glob
2  sdlc-stack-provisioner   Bash, Read, Glob            (needs 1)
3  sdlc-test-author         Bash, Read, Write, Edit, Glob, Grep   (needs 2)
4  sdlc-fix-implementer     Bash, Read, Write, Edit, Glob, Grep   (needs 3)
      ├─5 sdlc-verifier         Bash, Read, Glob              (needs 4)
      └─6 sdlc-trace-capture    Bash, Read, Glob              (needs 4)
7  sdlc-evidence-and-pr     Bash, Read, Write, Glob     (needs 5 AND 6)
```

Steps 5 and 6 form one wave (both list `4` as their only predecessor);
step 7 lists both `5` and `6` as predecessors, so `computeInput`'s existing
`joinInputs` fan-in gives it both outputs already — no engine change
needed there.

| Step | Agent | Job | Key instructions baked into the prompt |
|---|---|---|---|
| 1 | `sdlc-ticket-intake` | Turn pasted ticket text into a structured context packet | Extract: problem statement, affected product/repo, reported example, constraints, customer (if named). No repo access needed beyond optional `Read`/`Glob` for cross-checking. |
| 2 | `sdlc-stack-provisioner` | Stand up the relevant product's stack, seeded | Reads `alepo-dev-team-infra` conventions from context: per-service compose files behind `--profile`, external `alepo-shared` network (`10.20.23.0/24`), container-internal service names/ports never host ports, `TAG` var, licence mounts where needed. Brings up only the affected product's profile(s); confirms health via each service's own healthcheck endpoint, not `docker ps` alone. |
| 3 | `sdlc-test-author` | Generalize the one reported example into a 5–6-row parameterised test, prove it currently fails | Uses the target repo's existing test framework/conventions (never invents a new one). Runs it against the *unfixed* code and captures the FAIL output verbatim — that capture is part of the evidence bundle, not a formality. |
| 4 | `sdlc-fix-implementer` | Minimal fix for the root cause | Hard instruction: "Do not modify the test file at `<path from step 3>`, or any file under a `test`/`spec` directory, under any circumstance — if you believe the test itself is wrong, stop and say so instead of editing it." (This is the B3 test-file lock, enforced by instruction text in v1 — see *Follow-ons*.) |
| 5 | `sdlc-verifier` | Prove the fix and check for regressions | Re-runs step 3's test (expect full PASS across every row) plus the repo's existing regression/test suite for the touched area; captures both verbatim. |
| 6 | `sdlc-trace-capture` | Browser evidence, if applicable | If the target is UI/portal-class and the repo has Playwright configured, drives it and captures a trace. If not applicable, records "n/a" rather than failing the step — this is a legitimate outcome, not an error. |
| 7 | `sdlc-evidence-and-pr` | Assemble the bundle, open the PR | Bundle = context packet + FAIL run + PASS run + regression results + trace (or "n/a") + fix diff + model/plugin versions + agent identity, as the PR body. Branches as `fix/<JIRA-key>` (per the user's own branch-naming convention), commits, pushes, opens the PR against the repo's normal target branch — never pushes to `main`/`develop` directly. |

## Skills wiring

`AgentFrontmatter.skills` already resolves bare slugs against standalone,
GitHub-imported, and **installed plugin** skills (confirmed by reading
`server/api/agents/[slug]/skills.get.ts`'s plugin-scan branch) — so
referencing an installed superpowers-plugin skill by its bare slug (e.g.
`systematic-debugging`, not `superpowers:systematic-debugging`) resolves
correctly with zero additional engine work.

Per the request to seed these into the pipeline:

- **`systematic-debugging`** → `sdlc-fix-implementer.frontmatter.skills`.
  Direct fit: the skill's own reproduce → hypothesize → isolate → fix →
  verify loop is exactly this step's job.
- **`using-git-worktrees`** → `sdlc-stack-provisioner.frontmatter.skills`
  and `sdlc-fix-implementer.frontmatter.skills`. Runs the pipeline's
  checkout in an isolated worktree so an unattended, fully-autonomous run
  (product decision #1) can never collide with the engineer's own working
  tree in the same repo.
- **`using-superpowers`** → every Bash-capable step
  (`sdlc-stack-provisioner`, `sdlc-test-author`, `sdlc-fix-implementer`,
  `sdlc-verifier`). Lets each step recognize when e.g.
  `test-driven-development` or `verification-before-completion` applies
  mid-run, the same gate any interactive session gets.
- **`agent-browser`** → `sdlc-trace-capture.frontmatter.skills`. **This
  skill does not exist yet** — it was not found under any installed
  plugin or `~/.claude/skills`. Building it as part of this work: a new
  skill teaching an agent to drive Playwright against a running local
  stack and capture a trace, matching the brief's V7 action. If a
  differently-named existing skill was actually meant, say so and this
  step's `skills` entry gets swapped for it instead — the pipeline design
  doesn't otherwise depend on the name.

## Error handling

- Any step failing (non-zero from its own verification, or the SDK call
  itself throwing) already halts the run via the existing `markFailed` /
  `skipPending` path — unchanged by this design. Under `autoRun`, a
  failure stops auto-advance exactly the same way it stops a manual run
  today; nothing auto-continues past a failure.
- Step 6 (`sdlc-trace-capture`) treats "no Playwright config found" as a
  successful "n/a" outcome, not a failure — a backend-only fix must not be
  blocked on a browser step that has nothing to test.
- Step 7 never targets `main`/`develop` directly, regardless of autonomy —
  it always opens a PR against the repo's configured default/target
  branch, so the worst case of an autonomous run is an extra branch and PR
  to close, not a direct write to a protected branch.
- If `gh` isn't authenticated on the host running Agent Manager, step 7
  fails cleanly at the `gh pr create` call with the branch already pushed
  — the evidence bundle (as the commit) is not lost, just not yet a PR.
  This is an operational prerequisite (`gh auth status`), not something
  this design builds.

## Testing

- **E1/E2/E3** are plain unit-testable changes to `chat.post.ts` and
  `useWorkflowExecution.ts` — verify default behavior is unchanged when
  `tools`/`maxTurns` are absent, and that `Bash` shows up in `allowedTools`
  when an agent's frontmatter sets it.
- **Template fan-out/fan-in**: install the template, confirm the generated
  `Workflow.steps` has step 4 with `next: [5, 6]` and steps 5 & 6 both
  feeding step 7 — i.e. exactly the "run every ready node in one wave"
  path `useWorkflowExecution.ts` already has tests/behavior for.
- **End-to-end**: the brief's own first experiment for B1 — run the full
  pipeline on the next real portal-class CSUP-style ticket, with a second
  engineer (not the pipeline's author) running the same runbook on the one
  after. A second-run failure is a gap in the paved road, not a one-off.

## Follow-ons (explicitly not built now)

- A real `PreToolUse` hook per target repo enforcing the step-4 test-file
  lock (B3), instead of relying on instruction text.
- Live Jira fetch for step 1 (wiring an Atlassian MCP server into the
  SDK's `query()` options), replacing "paste the ticket text."
- A structured evidence-bundle UI component instead of a markdown PR body.
- Wiring this template into Jira-triggered dispatch (the brief's B5) —
  v1 is started by a human clicking "Run" in this app.

## Post-implementation status (added after the whole-branch review)

The branch was built and reviewed. The whole-branch review returned
**"merge after fixes"** with two Critical findings. Two of them are design
gaps, not implementation slips, and they bound what this template may
honestly be used for:

**Runbook A is NOT a working unattended pipeline, and must not be described
as one.**

1. **The evidence bundle cannot be assembled** (Critical). Steps receive only
   their *immediate* graph predecessors' output, so the final PR step never
   sees the context packet, the root cause, or the verbatim pre-fix FAIL run.
   The FAIL output is unrecoverable once the fix is applied — it existed only
   in an earlier step's output. The step will report "not captured" or
   fabricate it, and open a PR carrying that. Assembling the bundle belongs in
   CI (action R1 of the implementation plan), not in the chat engine.
2. **No step can stop the run** (Important). `WorkflowStep.monitorSlug` exists
   but Runbook A ships no monitors, and a step only halts the run by throwing.
   An agent that correctly reports "I could not bring the stack up; stopping"
   still completes its step and the run advances — through to the PR step.
   Every "stop and report" instruction in the prompts is therefore advisory.
   Real enforcement is the plan's `PreToolUse` hooks (B2 plan gate, B3 test
   lock), which are plugin work, not a patch to this branch.
3. **`frontmatter.skills` never reaches the model.** `server/utils/resolveSkill.ts`
   has zero importers and nothing in the request path references an agent's
   skills. All four skill references in the presets — including the
   `agent-browser` skill written for the trace step — are inert. This is a
   missing capability in the app, not a defect introduced here.

Until 1 and 2 are addressed: run this template step-by-step with the auto-run
box **unticked**, and treat its final PR step's output as a draft for a human
to complete, not as an evidence bundle.
