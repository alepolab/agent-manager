---
title: Agent Manager Human Gates - Plan
type: feat
date: 2026-09-10
topic: agent-manager-human-gates
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Agent Manager Human Gates - Plan

## Goal Capsule

- **Objective.** Make the human workflow the visible thing in Agent Manager: configured gates that stop a run for a named person, and one narrow surface per actor to answer them. The engine — restart-from-step, clone, builder, mid-run steering, watches, budgets — stays, but only for the operator.
- **Product authority.** Jonathan's P7 from the 9 Sep review (show the human workflow and gates, not the engine) and P3 (separate configuration from operation by role). Actions A6 and A7 in the readout.
- **Not active scope.** The CRM, Triple EMS and AI-assist surfaces reviewed in the same meeting. This plan owns Agent Manager only.
- **Open blockers.** No role concept exists in the app (`server/utils/users.ts:15`), and gate assignment depends on one. See Outstanding Questions.

---

## Product Contract

### Summary

Configure real approval gates on the shipped runbooks and give each actor a surface that supports one verb: the developer decides on a diff, QA verifies evidence, the manager watches, the operator runs the engine. A bug run stops once; a feature run stops at plan, diff and verification before it ships.

### Problem Frame

The gate machinery is built and unused. `WorkflowStep.approval` and `run.question = { kind: 'approval' | 'question' }` are implemented end to end (`server/utils/workflowRunner.ts:944-953`, `:1255-1268`) behind `POST /api/runs/[id]/continue` and `/respond`, but neither shipped runbook sets `approval: true` on any of its ten or eleven steps (`app/utils/workflowTemplates.ts:152-211`). A run today stops only when an agent emits `PIPELINE-ASK`, a monitor aborts, or the budget runs out. Four real runs exist and none of them ever paused for a person: WPM-1358, DEVOPS-23 and WPM-1318 completed every step unattended, CRM-76 died at Stand Up Stack.

The surface reflects that. A run opened from the queue offers Stop, Restart from any step, Clone, Open in builder, and a free-text note that steers a mid-flight agent (`app/pages/runs/[id].vue:38-41`, `app/components/WorkflowRunPanel.vue:11-27`) — engine controls handed to someone whose job is to say yes or no. The home page already computes a "needs attention" queue over paused, failed and CI-failing runs (`app/pages/index.vue:44-48`), so the developer lens is half-present and unnamed.

A gate that fires today names a step, not a change: "Approve 'Gated Second Check' to run it", beside a raw list of artifact files and a Select-a-file pane. The reviewer is asked to authorise a step in a graph rather than decide on work, and their only alternative to approving is Stop, which ends the run.

The cost is a demo that reads as a system rather than a workflow, which is what the 9 Sep review rejected, and a pipeline nobody can point at and say where a human decides.

### Key Decisions

- **Every gate is answered in Agent Manager, not GitHub.** (session-settled: user-directed — chosen over GitHub-PR-as-the-diff-gate: one audit trail over familiarity.) Governs R3, R6.
- **Gate count follows intake, not uniformity.** (session-settled: user-directed — chosen over one-gate-everywhere: the volume bug case stays fast and the feature case gets redirected before it builds the wrong thing.) Governs R1, R2.
- **The diff gate is a decision surface, not a review tool.** (session-settled: user-directed — chosen over full inline review: matching GitHub's review UI is work we would lose.) Governs R4, R5.
- **A reviewer directs nothing structural.** (session-settled: user-directed — chosen over reviewer-chooses-the-resume-step: the current system offers too much control to people whose job is gating.) Governs R7.
- **QA's verdict holds the run.** (session-settled: user-directed — chosen over an informational QA view: a lens with no consequence is a system-shaped screen.) Governs R2, R9.
- **One verb per actor, one surface per verb.** (session-settled: user-directed.) Governs R10, R11, R12, R13, R14.

### Actors

- A1. **Developer.** Decides on a diff. Owns the diff gate for the ticket they started or were assigned.
- A2. **QA.** Verifies evidence. Owns the verification gate on feature runs.
- A3. **Manager.** Reads progress across runs. Changes nothing.
- A4. **Operator.** Runs the pipeline: runbooks, watches, budgets, restarts, clones. Today this is every signed-in user.
- A5. **The run.** Stops at a gate, delivers a reviewer's note to the step the runbook names, resumes.

### Requirements

**Gate model**

- R1. Bug-intake runs carry exactly one approval gate, at the step that opens the pull request.
- R2. Feature and epic-intake runs carry three approval gates: after planning and before implementation, at the diff, and at verification before ship. The verification gate is answered by A2; the other two by A1.
- R3. A gate is answered inside Agent Manager. No gate is satisfied by a GitHub merge, a Jira transition, or any state change outside the app.
- R4. A gate presents a verdict card: files changed with line counts, the test that failed before and passes after, regression and security verdicts, the agent's own summary of the change, and a link to the pull request.
- R5. The verdict card offers an expandable read-only diff. It carries no commenting, no per-hunk affordance, and no editing.
- R6. Answering a gate is two outcomes: approve, which resumes the run, or send back, which requires a note.
- R7. A send-back carries a note and nothing else. Each gated step declares its own rework target in the runbook, and the note is delivered to that step as a correction.
- R8. A run that has been sent back records the rejection against the gate, so rework count and reason survive on the run record.
- R9. A QA rejection at the verification gate holds the run in the same way a developer rejection at the diff gate does; the run does not ship on an unanswered or negative QA verdict.

**Actor surfaces**

- R10. The developer surface lists gates addressed to that person and opens one verdict card. It exposes no stop, restart, clone, builder entry, or mid-run steering.
- R11. The QA surface lists runs at the verification gate and shows that run's verification evidence: test results, regression outcome, browser trace, security verdict.
- R12. The manager surface is read-only: runs in flight, the gate each is blocked at and for how long, rework count, cycle time, and cost. It offers no action that changes a run.
- R13. The operator surface keeps every engine control that exists today, and is the only place they appear.
- R14. Each surface reads a projection shaped to its verb rather than the whole run record: the manager board carries no step output, the developer queue carries no artifact bodies.
- R15. Which surfaces a person sees follows their role. Role is a new concept in the app.

**Review evidence**

- R16. The gated flows are demonstrated on runs that actually executed: WPM-1358 and DEVOPS-23 as clean paths, CRM-76 as a run that failed at Stand Up Stack.
- R17. One CSUP ticket from the readout set (7435, 7378, 7441, 7438) is attempted through the gated pipeline alongside that work. Its outcome, including a halt, is reportable either way.
- R18. Watches stay in `shadow` for this work. Nothing dispatches automatically and nothing posts to Jira.

### Key Flows

- F1. Bug ticket, one gate
  - **Trigger:** An operator or watch dispatches a bug-intake ticket. QA is not involved.
  - **Actors:** A5, A1
  - **Steps:** The run executes intake through implementation and verification unattended; at the PR step it stops and raises the gate to A1; A1 opens the verdict card, reads the evidence, approves; the run opens the PR, moves the ticket and settles.
  - **Covered by:** R1, R3, R4, R6
- F2. Feature ticket, three gates
  - **Trigger:** A feature or epic-intake ticket enters the pipeline.
  - **Actors:** A5, A1, A2
  - **Steps:** The run plans and stops for A1's approval of the plan; implements and stops for A1 at the diff; runs verification and stops for A2; on A2's verified verdict it ships.
  - **Covered by:** R2, R9
- F3. Send back
  - **Trigger:** A1 or A2 rejects at a gate.
  - **Actors:** A1 or A2, A5
  - **Steps:** The reviewer writes what is wrong; the run resumes at the step that gate declares as its rework target with the note delivered as a correction; the run re-reaches the same gate when the step completes.
  - **Covered by:** R6, R7, R8

### Acceptance Examples

- AE1. **Covers R1, R4, R6.** Given a bug run at the PR step with the gate raised, when A1 opens it, then the verdict card shows the changed files, the before/after test result and the security verdict, and offers approve and send back. Approving resumes the run.
- AE2. **Covers R7, R8.** Given A1 sends back "wrong layer, fix it in the shared helper", when the run resumes, then it re-enters the step the runbook names as that gate's rework target with the note attached, and the run's rework count increments.
- AE3. **Covers R2, R9.** Given a feature run at the verification gate, when A2 rejects it, then the run does not reach its ship step, and the rejection is recorded against the verification gate rather than the diff gate.
- AE4. **Covers R10, R13.** Given A1 opens a run they hold a gate on, then no stop, restart, clone or builder control is present on that surface; the same run opened by A4 shows all of them.
- AE5. **Covers R5.** Given the verdict card's diff is expanded, when A1 attempts to comment on a line, then there is no affordance to do so; corrections go through send back.

### Scope Boundaries

- No inline diff commenting or per-hunk review. Corrections are a note.
- No automatic dispatch and no Jira posting for this work; watches stay in shadow.
- No change to the runbook step graphs beyond marking steps as gated and declaring rework targets. New pipeline stages are out.
- No notification channel (email, Slack) for a raised gate. The surfaces are pull, not push.
- The CRM, EMS and AI-assist work from the same review is not in this plan.

### Dependencies and Assumptions

- The pause-and-release half of the gate is verified end to end, not assumed: a gated run paused with `Waiting for your approval`, held without the budget touching it, resumed on approval from the run page, and completed.
- The reject half does not exist. A gate today offers Approve and run, or Stop, which ends the run. Send back with a note (R6, R7) is net-new, not a relabelling of the existing restart control.
- The evidence a verdict card renders is assumed to be already produced per step under the run's artifacts directory. The card composes existing artifacts rather than asking agents for new output. What the gate shows today is a raw file list — `meta.json`, per-step logs — and a "Select a file" pane, so R4 is composition work over files that exist, not new agent output.
- Demonstrating gated flows requires re-running WPM-1358 and CRM-76 under the new configuration. Existing records carry no gate events and cannot be replayed into one.
- A manager board over four runs shows almost nothing; enough runs to make cycle time and blocked-at meaningful is itself work.

### Outstanding Questions

**Resolve before planning**

- Role assignment. `UserProfile` is a GitHub login plus sealed tokens (`server/utils/users.ts:15-25`) with no role field, and `server/middleware/auth.ts` treats every signed-in user identically. Where roles come from — a config file, the GitHub org, per-user profile — decides how gates are addressed and how surfaces are shaped.
- Gate addressing for the developer gate. A run carries `startedBy`; whether a gate is addressed to that person, to anyone with the developer role, or to a named assignee changes what R10's queue filters on.
- Whether an unanswered gate should ever expire. A paused run waits indefinitely and is not charged for the wait — the budget clock banks execution time only (`shared/utils/runClock.ts:106-111`), confirmed on a run held at a gate. Nothing reminds anyone either.

**Deferred to planning**

- Whether the three surfaces are separate routes or one route resolved by role.
- How the read-only diff is obtained: the run's branch on disk, or the PR.
- Whether `dismiss` on the home queue survives, and what it means once a queue item is a gate rather than a notification.

### Sources

- `server/utils/workflowRunner.ts:944-953`, `:1255-1268` — approval gate and continue paths.
- `app/utils/workflowTemplates.ts:152-211` — Runbook A and Runbook C step graphs; no step sets `approval`.
- `app/pages/runs/[id].vue:38-41`, `app/components/WorkflowRunPanel.vue:11-27` — engine controls on the run surface.
- `app/pages/index.vue:44-48` — the existing attention queue.
- `shared/types/run.ts` — `RunStep`, `WorkflowRun.question`, `reworks`, `usage`, `ci`.
- `engineering/registry/watches.yaml` — csup-bugs and devops-tasks, both `mode: shadow`.
- Run records in the `agents-ui` container at `/root/.claude/workflow-runs` — WPM-1358, DEVOPS-23, WPM-1318 completed; CRM-76 failed at Stand Up Stack.
- `docs/roadmap/research-sdlc-gap-analysis.md` — prior gap analysis, dated 2026-09-05 and stale in places.
