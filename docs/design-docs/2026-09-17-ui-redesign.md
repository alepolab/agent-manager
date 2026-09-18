# UI redesign — reconciled specification

**Date:** 2026-09-17
**Status:** specification + pilot. Tier HEAVY. Inputs: the end user's own words, a UI designer child (visual-engineering), a UI architect child (architect), and baseline screenshots I captured myself against a real-data instance.
**Predecessor:** `docs/design-docs/2026-09-16-persona-oriented-gui.md` (persona research). This document supersedes its §5 surface sketches and keeps its data-contract findings.

---

## 1. What the end user said

Verbatim, and it is the only requirement in this document with that status:

> "bring ui designer and ui archtiect to redesign complete ui by checking with end user what makes there life easy in ui"

> "note in workflow also each role or persona has work, like some steps will be defined by different roles"

A four-question round (which screens they live in, what "easy" means, scope, what they need first when a run finishes) was asked and **timed out unanswered**, so the two statements above are the whole of what the end user actually said. Everything below is therefore marked either **[user]** — traceable to the two statements above — or **[specialist]** — the designer's or architect's judgment. Nothing is marked [user] on inference, and the [specialist] rows stand on their own evidence rather than as confirmed needs \u2014 the backlog order in \u00a76 is the first thing to re-check with the user when they are next available.

---

## 2. What I saw myself (baseline evidence)

Captured on an isolated dev server (127.0.0.1:3041) against a scratch config dir seeded with **real** data: 2 workflows, 12 agents, 4 real run records, 72 real CSUP-7519 artifacts. Screenshots in `/tmp/ulw-baseline/` at 1440×900 and 390×844.

| Observation | Where | Why it matters |
|---|---|---|
| The evidence pane is 25+ middle-ellipsised, agent-named files (`csup-7519-…-evidence.txt`, `csup-7519-…-postfix.z…`) beside an empty pane reading "Select a file" | `run-detail-desktop.png` | Confirms the designer's F2: the decisive artifacts are indistinguishable from scratch files, and nothing ranks them. |
| Step rows show a dot, label, agent slug and duration — **no role anywhere** | `run-detail-desktop.png` | Confirms F3 and the user's requirement directly: a reader cannot tell whose work a step is. |
| Builder nodes show label + "Default" + monitor badge — **no owner**; three gates owned by three different people are invisible | `workflow-builder-desktop.png` | The workflow the template comments describe as "owned by three different people" does not say so on screen. |
| A floating panel overlaps the "Plan Review" node at 1440px | `workflow-builder-desktop.png` | Pre-existing rendering defect, unrelated to this redesign. Registered as a defect, not deferred silently. |
| At 390px the run title wraps to eight lines and the "Open in builder"/"Clone" controls overlap it; the evidence viewer column collapses to ~45px showing vertical fragments ("Pick a file on the left. Marke rende JSON reads") | `run-detail-mobile.png` | **Worse than the designer's arithmetic predicted** (they computed 78px from the CSS without running it). The run page is unusable on a phone today. |
| The home queue at 390px is fine — sidebar collapses to icons, one gate row, start-run form legible | `dashboard-mobile.png` | F5's fold is a real concern but not the acute one; the run page is. |

---

## 3. Requirements, with provenance

| # | Requirement | Provenance |
|---|---|---|
| R1 | A workflow step must carry the persona whose **work** it is, distinct from who answers its gate | **[user]** — "each role or persona has work" |
| R2 | Step ownership must be visible where work is read (run view) and where work is defined (builder) | **[user]** — "some steps will be defined by different roles" |
| R3 | Ownership must never become a permission; enforcement stays `can()` + `requireGateRole` | **[specialist]** architect §6.2 |
| R4 | The FAIL→PASS pair must be rendered as a pair at the gate, not as one sentence | **[specialist]** designer F1 |
| R5 | Evidence must be ranked ("key evidence" from `meta.json` paths only, never guessed from filenames) | **[specialist]** designer F2 + predecessor §4.2 |
| R6 | Navigation must gate on capability, not on a per-role route allowlist | **[specialist]** architect §1 design B |
| R7 | The run page must be usable at 390px | **[specialist]** designer F5 + **my own measurement** (§2) |
| R8 | No fabricated data: no coverage %, no pass-rate trend, no person leaderboard, no six-colour role palette | **[specialist]** both children, independently |

---

## 4. Where the designer and architect disagreed

**D1 — Can a step's owner be derived for phase 0?** The designer proposed deriving a *displayed* owner from `gateRole` so the CSUP template shows three owners on day one with no schema change. The architect rejected derivation outright: "Plan Review" runs `architecture-reviewer` but is gated `developer`, so agent and gate disagree on the first real step, and six of nine steps map to no role at all — "a guess wearing a fact's shape".

**Resolved: the architect wins on the field, the designer wins on the timeline — by relabelling.** A derived value may be shown only under the label it is actually true of. `gateRole` is a fact about a *gate*, so phase 0 renders "gate: qa", never "owner: qa". The owner chip appears only where `ownerRole` is explicitly declared. This keeps the day-one visibility the designer wanted without asserting a guess, and it satisfies R1's distinction rather than blurring it.

**D2 — What ships first?** The designer ranks the FAIL→PASS proof panel first (no schema change, works on every historical run, improves *decision quality* rather than *speed*) and ownership second. The architect's phase order puts the nav manifest before ownership and folds the proof panel into its Phase 1 renderers.

**Resolved in favour of neither: ownership ships as the pilot, because the user asked for it.** The specialists ranked by engineering leverage; the only requirement carrying **[user]** provenance is R1/R2. Specialist ranking does not outrank the person whose life the UI is supposed to make easier. The proof panel is ranked second and is fully specified below so it can ship next without re-deciding anything.

**D3 — Swimlanes in the builder?** No disagreement, but worth recording: the designer refused role swimlanes (node positions are user-placed and persisted, monitor nodes auto-place under their step, loops leave from the bottom handle — lanes fight all three) and refused a six-colour role palette (status already owns five hues and `--accent` owns brand+running). The architect did not propose lanes. Accepted: a monochrome chip plus a single "mine" ring in `--accent-secondary`, the one hue the app uses exactly once.

---

## 5. The pilot: step ownership, visible

**Change:** add `ownerRole?: Role` to the step model, declare it on the shipped CSUP template, and render it as a chip on run step rows and builder nodes, with a "mine" marker for the signed-in role.

**Why this and not the proof panel:** §4 D2.

**Files:**
1. `app/types/index.ts` — `WorkflowStep.ownerRole?: Role`, beside `gateRole`, documented as "whose work this step is; grants nothing".
2. `app/utils/workflowTemplates.ts` — `WorkflowTemplateStep.ownerRole?: Role`; carry it through `materializeTemplateSteps` with the same spread pattern as `gateRole`; declare owners on the CSUP steps.
3. `shared/types/run.ts` — `RunStep.ownerRole?: Role`.
4. `server/utils/workflowRunner.ts` — copy `ownerRole` onto the step record at run creation, where `{stepId, label, agentSlug}` is already snapshotted.
5. `app/components/WorkflowRunPanel.vue` — owner chip + "mine" rail on each step row.
6. `app/components/WorkflowNode.vue` — owner chip on the node.
7. `shared/types/role.ts` — move the `SHORT_ROLE` label map here so sidebar, builder and run view share one set of labels.

**Safety:** adding a value-only field strands no in-flight run — the resume guard compares step ids, then step count and `agentSlug` per index, never `ownerRole` (`server/utils/workflowRunner.ts:1852-1861`, verified by me and independently by the architect). Adding or reordering steps would strand runs; this does not.

**DOM assertion, recorded BEFORE implementation (the pilot's PASS/FAIL observable):**

On `/runs/d73159c0-8709-4827-8ad4-33333925798c` as `operator`:
```
document.querySelectorAll('[data-testid="step-owner"]').length >= 3
document.querySelector('[data-testid="run-step"][data-owner="qa"] [data-testid="step-owner"]').textContent.trim() === 'QA'
document.querySelector('[data-testid="run-step"][data-owner="developer"] [data-testid="step-owner"]').textContent.trim() === 'DEV'
document.querySelectorAll('[data-testid="run-step"]').length === 9   // ownership never removes a row
```
RED expectation before the change: `[data-testid="step-owner"]` count is 0.
Captured at 1440×900 and 390×844.

**Refused in the pilot:** role colours beyond the single "mine" ring; any `v-if` on a control keyed to `ownerRole`; any server-side read of `ownerRole` outside the runner's copy (per R3).

---

## 6. Ranked backlog after the pilot

1. **FAIL→PASS proof panel at the gate** (designer F1, fully specified with its own DOM assertion: `[data-testid="proof-verdict"][data-verdict="fixed"]`, PASS→PASS rows marked `unproven`, absent pair rendered as a `--warning` sentence rather than silence). Needs `junit.ts` extended to walk every `testcase` and a `pairJunit()` pure function.
2. **Evidence projection** `GET /api/runs/:id/evidence` (architect §3): a read-time projection, not a persisted envelope, so historical runs work on day one and `problems[]` names what could not be derived. Supersedes the predecessor's `StepResult` union, which the architect correctly showed duplicates runner-owned facts and cannot be backfilled.
3. **Run view decomposition** (architect §2): one `useRunStream`, one `useRunEvidence`, one shared `isGateOwner`, and delete the duplicate JUnit parser in `RunArtifacts.vue` that re-implements `utils/junit.ts`.
4. **Key-evidence strip + video/zip kinds** (designer F2).
5. **390px run page** (R7) — the acute defect I measured, not the queue fold.
6. **Nav capability manifest** (architect §1): delete `NAV_BY_ROLE`, three capability layers, one HOME map.
7. **Per-step authoring authority** — deliberately NOT built. `configure` is atomic and a per-step editor would let a reviewer change `agentSlug` and strand every in-flight run. A designer who wants their step changed proposes a PR to the agent definition, or steers the single run at its gate.

---

## 7. Defects found while writing this, registered not deferred

- Builder: a floating panel overlaps a node at 1440px (`/tmp/ulw-baseline/workflow-builder-desktop.png`).
- Run page at 390px: header controls overlap the wrapped title; evidence viewer collapses to ~45px of vertical text.
Both are R7 backlog items with evidence attached; neither is caused by this redesign.
