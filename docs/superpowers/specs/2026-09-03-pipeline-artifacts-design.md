# Making Runbook A Produce Its Own Deliverable

Design for the three linked defects that together mean the pipeline **cannot
produce the artifact it exists to produce**.

## The problem, stated plainly

Runbook A's stated deliverable is an evidence bundle: the failing test and its
FAIL run, the PASS run, regression results, a trace, provenance hashes and cost
— so a reviewer reads *evidence* rather than re-deriving trust from a raw diff.

The validator, assembler and summary renderer for that bundle are built and
tested. They have **nothing to consume**. Three independent causes, found by
auditing rather than assumed:

**1. Context is lost between steps.**
`computeInput` in `server/utils/workflowRunner.ts` passes a step only its
*immediate* forward predecessors' output. Step 7 (`sdlc-evidence-and-pr`) has
steps 5 and 6 as predecessors — never step 3 (`sdlc-test-author`). The verbatim
**pre-fix FAIL output is structurally unreachable**, and it is unrecoverable
after the fact: it existed only while the code was still broken.

**2. Steps emit prose, not artifacts.**
A grep across `server/`, `app/` and `shared/` finds nothing that writes any
run-directory file — no `meta.json`, no xunit, no `intent.md`, no `plan.md`.
Every `sdlc-*` step returns free text. The assembler's run-directory contract
is satisfied by nothing that exists.

**3. Determinism is never established.**
The bundle requires `oracle.runs >= 3` — three-run determinism, because a
verdict from a single run is not evidence. No `sdlc-*` prompt instructs a
repeat pass, so even a recovered oracle would fail validation at `runs: 1`.

A fourth, related defect bounds how much any of this can be trusted:

**4. No step can stop the run.**
`WorkflowStep.monitorSlug` exists but Runbook A ships no monitors, and a step
only halts a run by *throwing*. An agent that correctly reports "I could not
bring the stack up; stopping" completes its step, and the run advances — to the
PR step. Every "stop and report" instruction in the prompts is advisory.

## Goal

A Runbook A run produces a run directory the assembler accepts and the
validator passes — or fails loudly at the step where the evidence was actually
missing, rather than silently arriving at the PR step with nothing.

## Non-goals

- Changing what the bundle requires. The schema's rules exist because their
  absence lets something through; **if the pipeline cannot meet them, the
  pipeline changes, not the schema.**
- Live Jira, the Checks API path, or agent identities — all outside this.
- Making the pipeline *good* at fixing bugs. This is about whether it can
  honestly report what it did.

## Design

### 1. Ancestry, not just predecessors

Add an opt-in on the step: `contextMode?: 'predecessors' | 'ancestors'`,
defaulting to `'predecessors'` so every existing workflow is untouched.

With `'ancestors'`, `computeInput` walks the full transitive forward-ancestor
set and joins their outputs, each labelled by step. Runbook A's step 7 uses it.

**The risk to design against is unbounded input.** A long chain would hand the
final step every prior output in full. Mitigations, in order of preference:
- steps write artifacts to disk (see §2) and the joined context carries
  *references plus short excerpts* rather than whole outputs;
- a per-step cap on joined context with explicit truncation markers — never
  silent truncation, since the whole point is not losing the FAIL text.

State the chosen limit in the implementation and test what happens at it.

### 2. A run directory per run

Give every run a directory: `~/.claude/workflow-runs/<runId>/artifacts/`.

Two mechanisms, and the second is what makes it real:

**a. The runner writes what it already knows.** After each step it persists
that step's input, output, agent slug, timings and status as
`step-<n>-<slug>.json`, plus a `meta.json` for the run (model, plugin version,
identity, ticket key, working directory). This needs no agent cooperation and
cannot be forgotten — it is the runner's own bookkeeping.

**b. Steps write their own structured artifacts.** The `sdlc-*` prompts gain an
explicit instruction to write named files — `oracle-before.xml`,
`oracle-after.xml`, `regression.xml`, `intent.md`, `plan.md`, `trace` path —
into the directory exposed to them.

Mechanism (a) is the floor: even if an agent ignores (b) entirely, the bundle
can be assembled from the runner's own record, and the *absence* of a specific
artifact is then visible rather than inferred. Relying on (b) alone would
reproduce the current failure in a new place.

The directory path must reach the agent — via the step's input header, since
that is the only channel that exists today.

### 3. Determinism in the prompt and in the check

`sdlc-test-author` and `sdlc-verifier` instruct running the oracle three times
(200× for races, per the source plan) and recording each run's verdict. The
assembler counts recorded runs; a single run yields `runs: 1` and the validator
rejects it — which is correct, and must fail *at assembly*, not silently pass.

### 4. A real stop signal

Two layers, because prompt text alone has already proven insufficient:

**A structured halt marker.** A step may end its output with a line
`PIPELINE-HALT: <reason>`. The runner detects it, marks that step `failed` with
the reason, and halts the run exactly as a thrown error does. The prompts
instruct agents to emit it when they cannot proceed.

**A monitor on the load-bearing steps.** `WorkflowTemplateStep` gains
`monitorSlug`, and Runbook A attaches a monitor to the stack-provisioning and
verification steps — the two whose silent failure is most damaging, since
everything after them is meaningless.

The halt marker is the cheap, general mechanism; the monitor is the check on
steps where "the agent said it was fine" is not good enough.

## Error handling

- A missing artifact is **never** fabricated. The assembler already refuses to
  invent fields; the runner's own record makes the absence explicit.
- A step that halts leaves the run `failed` with the reason in that step's
  record — not a pending step in a dead run.
- `contextMode: 'ancestors'` on a cyclic graph must terminate. The scheduler's
  existing visit caps bound it; test that.

## Testing

- Ancestry: a 4-step chain where step 4 declares `'ancestors'` receives step
  1's output; with the default it does not. This is the regression that would
  otherwise silently return.
- Truncation: at the cap, the marker is present and the test asserts the FAIL
  text is *not* the thing dropped.
- Run directory: after a stubbed run, `meta.json` and per-step records exist
  with real values.
- Halt: a stubbed agent emitting `PIPELINE-HALT:` fails that step, halts the
  run, and marks the remaining steps skipped — the property fix round 2
  established for every other failure path.
- **The acceptance test:** a stubbed full Runbook A run produces a directory
  the real assembler turns into a bundle the real validator accepts. If it
  cannot, the test names the missing field — which is the honest outcome and
  still better than today's silence.

## What this does not fix

Even with all of it, the bundle is only as true as the agents' self-reports.
`fix.files_changed`, `lines_changed` and the repo/commit list come from the
step's own account rather than a computed diff. Deriving those from git is
worth doing and is not in this spec.
