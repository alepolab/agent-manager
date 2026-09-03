# Evidence Bundle in CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble an evidence bundle for an agent-authored PR, validate it against the schema, and post it as a check so that **missing evidence fails the PR**.

**Architecture:** A CLI assembles a bundle from run artifacts, a validator enforces the v0.1 schema, and a GitHub Actions workflow posts the result via the Checks API with the one-screen summary as the PR body. The schema already exists; this makes it load-bearing.

**Tech Stack:** Node 24 (no dependencies), GitHub Actions, GitHub Checks API. Directory: `engineering/` inside the agent-manager repo.

**Spec:** the implementation-plan artifact's **R1** ("bundle standard, v0.1" and "R1 enforced as a check") and its bundle schema, already implemented at `engineering/schemas/evidence-bundle.v0.1.schema.json`.

## Global Constraints

- **All work is in `engineering/`** inside this repo. Paths in this plan are relative to `engineering/` unless stated otherwise.
- The CI workflow targets this repo (`alepolab/agent-manager`). Verify locally what can be verified; a step needing a live PR should be written and reported as **unverified**, never claimed working.
- No Node dependencies — the schema validator is hand-written for the same reason the registry validator is: this is the trusted root of the pipeline.
- Existing suites must stay green: `node scripts/test-hooks.mjs`, `node scripts/test-validate-registry.mjs`.
- **This is not a gate until the agent identities exist.** A check the authoring identity can approve is not a control. Actions F4 (three agent accounts) and R5 (branch protection, authoring identity blocked from approving) are prerequisites and are **not** in this plan — they need org admin. State this in the README you write.

---

### Task 1: The bundle validator

**Files:**
- Create: `scripts/validate-bundle.mjs`
- Test: `scripts/test-validate-bundle.mjs`

**Interfaces:**
- Consumes: `schemas/evidence-bundle.v0.1.schema.json`.
- Produces: CLI `node scripts/validate-bundle.mjs <bundle.json>` — exit 0 valid, exit 1 with reasons. Also exports `validateBundle(bundle): string[]` returning problems.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-validate-bundle.mjs`. Build one complete, valid bundle fixture in the test, then assert each of these is REJECTED with a message naming the problem:

- a bug bundle with `class: null` — the schema's conditional requires a class for bugs;
- a `blast_radius: "money"` bundle with `adversarial: null` — money paths require adversarial verification;
- `oracle.verdict: "PASS"` on the pre-fix oracle — the oracle that runs before the fix must FAIL, or nothing was reproduced;
- `oracle_after.verdict: "FAIL"` — the post-fix oracle must PASS;
- `oracle.runs: 1` — three-run determinism is the minimum; a verdict from a single run is not evidence;
- `fix.test_dirs_unlocked: true` with no `unlock_reason`;
- a missing `context_packet_hash`;
- `fix.repos` with two entries and no `merge_order`.

And assert the complete fixture is ACCEPTED. Each rejection encodes a rule that exists because its absence let something bad through — the test is where that reasoning lives.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement the validator**

Reuse the JSON-Schema subset approach already proven in `scripts/validate-registry.mjs` — required keys, types, enums, patterns, `additionalProperties: false`, and the `allOf`/`if`/`then` conditionals the bundle schema uses. Add the semantic rules a schema cannot express (the pre-fix oracle must be FAIL, the post-fix must be PASS, `merge_order` required for multi-repo).

- [ ] **Step 4: Run the test until it passes, plus existing suites**

- [ ] **Step 5: Commit**

---

### Task 2: Assemble a bundle from run artifacts

**Files:**
- Create: `scripts/assemble-bundle.mjs`
- Test: `scripts/test-assemble-bundle.mjs`

**Interfaces:**
- Consumes: the validator from Task 1.
- Produces: CLI `node scripts/assemble-bundle.mjs --run-dir <dir> --out <bundle.json>`, and `assembleBundle(runDir): Promise<{ bundle, problems }>`.

- [ ] **Step 1: Decide and document the run-directory contract**

The assembler reads a directory a CI job populated. Define it explicitly in the script's header comment — for example `meta.json`, `oracle-before.xml`, `oracle-after.xml`, `regression.xml`, `trace.zip`, `intent.md`, `plan.md`. **Whatever you choose, write it down**; an undocumented contract between a CI job and an assembler is a silent breakage waiting to happen.

- [ ] **Step 2: Write the failing test**

Build a fixture run directory in a temp dir and assert: a complete one produces a bundle that passes Task 1's validator; a directory **missing the pre-fix oracle** produces a bundle the validator rejects — the assembler must not invent a passing bundle from absent evidence. That second case is the point: the bundle's value is that it cannot be produced without the evidence.

- [ ] **Step 3: Implement**

Parse xunit for pass/fail counts. Compute `context_packet_hash` from the packet file. Read model, plugin version and identity from `meta.json`. **Never fabricate a field**: if the evidence is absent, leave it absent and let validation fail. A bundle that says "not captured" is honest; one that fills a plausible value is worse than no bundle.

- [ ] **Step 4: Run the test until it passes**

- [ ] **Step 5: Commit**

---

### Task 3: The one-screen summary

**Files:**
- Create: `scripts/bundle-summary.mjs`
- Test: `scripts/test-bundle-summary.mjs`

**Interfaces:**
- Produces: `node scripts/bundle-summary.mjs <bundle.json>` → Markdown on stdout, and `renderSummary(bundle): string`.

- [ ] **Step 1: Write the failing test**

Assert the summary contains, from a fixture bundle: what was wrong, what changed, what proves it, the blast-radius label, the deployment truths considered, and the cost. Assert it stays **under 40 lines** — "one screen" is the requirement, and a summary a reviewer scrolls is a summary they skim.

Also assert that when `trace` is `null` the summary says so explicitly rather than omitting the row. A reviewer must be able to tell "no browser evidence" apart from "this section forgot to render".

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement, then run**

- [ ] **Step 4: Commit**

---

### Task 4: The CI workflow

**Files:**
- Create: `.github/workflows/evidence-bundle.yml`
- Create: `docs/evidence-bundle.md`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a check named `evidence-bundle` that fails when evidence is missing, and a diff-size check.

- [ ] **Step 1: The workflow**

On `pull_request`: download the run artifact, assemble, validate, render the summary, and post via the Checks API. **Missing evidence fails the check** — that is the entire mechanism. Pin actions to commit SHAs and give the job the minimal `permissions:` it needs (`checks: write`, `pull-requests: write`, `contents: read`).

- [ ] **Step 2: The diff cap**

A second check failing above 400 changed lines or 10 files, excluding test and generated paths. Its purpose is that reviewer minutes per PR stay flat as the agent-authored share rises — say that in the check's output so a developer who hits it understands why, rather than treating it as an arbitrary obstacle.

- [ ] **Step 3: Verify what can be verified locally**

Run the three scripts end to end against a fixture run directory and show the real output. Validate the workflow YAML parses. **You cannot exercise the Checks API without a remote and a real PR** — say so explicitly rather than implying it was tested.

- [ ] **Step 4: Write `docs/evidence-bundle.md`**

What the bundle is, the run-directory contract from Task 2, how to run the three scripts by hand, and — stated plainly — that **this is not yet a gate**: without the separate agent identities and branch protection, the authoring identity can still approve its own PR. A check that looks like a control but is not is worse than no check, because people trust it.

- [ ] **Step 5: Commit**

---

### Task 5: Verification

**Files:** none.

- [ ] **Step 1: All suites**

```bash
node scripts/test-validate-bundle.mjs
node scripts/test-assemble-bundle.mjs
node scripts/test-bundle-summary.mjs
node scripts/test-hooks.mjs
node scripts/test-validate-registry.mjs
node scripts/test-plugin-manifest.mjs   # if the plugin plan has landed
```

- [ ] **Step 2: Assemble a bundle from the Runbook A pipeline's own shape**

Build a fixture matching what the seven `sdlc-*` agents would actually produce and confirm it validates. If it does not, that is a **real finding about the pipeline**, not about the schema — report which fields the pipeline cannot currently supply. (Known already: the pipeline cannot capture the pre-fix FAIL output, because steps only receive their immediate predecessor's output. Confirm whether that is still true.)

- [ ] **Step 3: Report** what is enforced, what is written but unverified against a real PR, and what remains blocked on the agent identities.
