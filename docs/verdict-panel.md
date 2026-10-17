# The verdict panel, and Runbook V

Two additions to how a change is judged: a `panel` step kind that replaces
Runbook A's Code Review + Alepo Review pair, and Runbook V, which verifies a
merged change in staging and stops for QA.

## Why a panel

Code Review and Alepo Review were handed the implementer's own account of the
change: its output, its reviewer's brief, and (for a step that continued the
session) its whole transcript. A reviewer who reads the implementer's reasoning
reviews that reasoning. The panel seats several reviewers who are each given
only facts, never the story, and each must end with a verdict the runner can
parse. A reviewer the runner cannot read has not passed.

## The step

```json
{
  "id": "…", "agentSlug": "sdlc-verdict-panel", "label": "Verdict panel",
  "kind": "panel",
  "panel": {
    "members": [
      { "agentSlug": "sdlc-panel-verifier" },
      { "agentSlug": "sdlc-skeptic" },
      { "agentSlug": "sdlc-specialist-security", "criterion": "optional: one thing this member judges" }
    ],
    "budgetTokens": 300000,
    "maxLoops": 2,
    "reworkTarget": "optional: the step label a fail sends the run back to"
  }
}
```

`kind` defaults to `agent`, so every workflow written before it existed is
unchanged. `agentSlug` is the placeholder `sdlc-verdict-panel`, which ships as
an agent template so team sync seeds the slug; the runner never calls it.

What the runner does with it (`server/utils/panelStep.ts`,
`shared/utils/verdictPanel.ts`):

1. **Seats the members.** The configured list, plus `sdlc-specialist-protocol`
   when the run's blast radius is `protocol` or `money`. When the risk-policy
   module (`shared/utils/riskPolicy.ts`, another branch) is on the instance,
   its tier's `specialist` field decides instead of the radius.
2. **Briefs each member** from the run's own artifacts and the registry, and
   nothing else: ticket key; acceptance criteria / reproduction (`intent.md`,
   the criteria fields of `context-packet.json`, else `plan.md`, else the
   prompt); the diff range `baseCommit..branch`; the registry's test commands;
   the compose project and the URLs `stack-report.md` names; the member's own
   criterion. Never the implementer's output, brief or session.
3. **Runs each member in a fresh SDK session** - no `resume`, no steering -
   against the run's checkout, told it is read-only. Members run in sequence
   so the budget is checked between them.
4. **Parses the last JSON object with a `verdict` key** out of each member's
   output, validates it against `engineering/schemas/verdict.v0.1.schema.json`,
   refuses one about another ticket, and writes
   `panel/<agentSlug>.json` (verdict, problems, the member's output, usage)
   plus `panel/panel.json` under the run's artifacts.
5. **Aggregates.** Any `fail`, or any member with no usable verdict, fails the
   panel. Pass: the step records `CONTINUE` and the run goes on. Fail: the
   step records `RETRY` and sends the run back to `reworkTarget`, else the
   nearest earlier change-making step (`CHANGE_MAKERS`), with every finding
   attributed to its member - through the same hand-over an agent's
   `PIPELINE-REWORK` uses, so the implementer sees the findings as its next
   input. The panel's send-backs count in their own bucket
   (`reworksBy.panel`), bounded by `maxLoops`; the next fail pauses the run
   with `question.reason = 'rework'` for a person, who can grant one more.
6. **Budget.** The members' uncached tokens are summed; over `budgetTokens`
   the panel stops seating members (the unseated count as fails) and the run
   pauses with `question.reason = 'budget'`, exactly as the run budget does.
   Continue accepts the spend and carries out any send-back the panel raised.

A panel step takes no `monitorSlug`: it is its own monitor.

## The members

| Agent | Brief |
|---|---|
| `sdlc-panel-verifier` | Picks one acceptance criterion and tries to falsify it against the running change; command output is the evidence. |
| `sdlc-skeptic` | Hunts what a green suite misses: silent data loss, double charge/grant, state-machine holes, idempotency, API/schema/AVP compatibility, overlay breakage, authorisation, performance cliffs. |
| `sdlc-specialist-protocol` | Seated on protocol and money changes: every wire-level behaviour against its 3GPP/RFC clause, cited by number. |
| `sdlc-specialist-security` | OWASP classes, URM authorisation, secrets, PII, each finding at file:line. |

Each ends with:

```json
{"verdict":"pass|fail","ticket":"KEY","criteria":[{"id":"…","result":"pass|fail|not_applicable","evidence":["…"],"notes":"…"}],"risks":["…"]}
```

`sdlc-ce-review` and `sdlc-alepo-review` still ship: Runbooks B and C use them
and runs in flight name them.

## Runbook A

`Implement Fix → Verdict panel → Jira: Dev Done → …`. The rest of the runbook
is unchanged. A Runbook A run started before this change keeps its recorded
steps (the runner adopts added steps and skips those the run has passed).

## Builder

A panel step renders in the stack with its label and member count, can be
added from the "+" picker (it starts with the three shipped members), and
`canSave` accepts it. The Configure tab shows the members and edits the budget
and loop count; editing the member list is done in the workflow file for now.

## Runbook V - Verify after merge

`runbook-v-verify-after-merge`, started by either:

- the CI poller, when a completed run's pull request reaches `MERGED`
  (`detectMergedOnce` in `server/utils/ciPoller.ts`; the source run records
  `verification: { pr, mergedAt, runId | reason }` so it starts once), or
- `POST /api/v1/runs { "issueKey": "KEY-1", "stage": "verify", "pr"?, "revision"?, "branch"? }`
  with the `startRun` capability - the entry point for a webhook relay or a
  person. One live verification per ticket; a second is refused with 409.

Steps:

1. **Verification brief** (`sdlc-verification-brief`) - `verification-brief.md`:
   what changed, how to verify in staging, exact commands / API calls /
   protocol flows, expected evidence, regression surface, rollback. Written
   from the merged revision, never from the run that made it.
2. **Deploy to staging** - the existing `sdlc-stack-provisioner`, on a worktree
   of the merged branch (the `branch` parameter; the registry's development
   branch when the caller does not say).
3. **Regression suites** (`sdlc-regression-runner`) - the registry's `tests.*`
   and the brief's own checks, into `regression.xml`,
   `verification-checks.xml`, `screenshots/` and `regression-report.md`.
4. **G5 verification sign-off** - a gate addressed to role `qa`. Approving it
   records `verification.pass` (`events/verification.pass.json` under the run,
   one line on the run's notification channel, and `onRunEvent` for any
   in-process listener), then the Jira step sets Agent Stage=VERIFIED: through
   the field Settings maps under `agentManager.jira.fieldMap.agentStage` when
   there is one, else as a comment. Nothing is written to Jira unless posting
   is enabled, as for every other Jira step.

## Tests

- `scripts/test-panel-step.mjs` - parsing and schema; isolation (no `resume`,
  no implementer output or session id reaches a member); RETRY until
  `maxLoops` then a pause; the budget pause.
- `scripts/test-runbook-v.mjs` - the template; the starter's refusals; a run
  stopping at the QA gate; approval recording `verification.pass` and the
  stage; the poller's merge detection; the route's guard.
