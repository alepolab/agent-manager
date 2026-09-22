---
name: runbook-a
description: Take a tracker ticket to an evidence-carrying pull request — reproduce with a parameterised oracle, fix the root cause, prove the fix, and assemble a bundle a reviewer can check without re-deriving trust in the diff
disable-model-invocation: true
---

- **Response language follows `language` setting in `.agents/oma-config.yaml` if configured.**
- Follow `.agents/skills/_shared/core/execution-policy.md` for authorization, clarification, verification, and completion. Execute required steps in dependency order; apply the documented skip conditions below.
- Follow `.agents/skills/_shared/core/code-intelligence.md`: use the configured provider's tools; fall back to native search and scoped reads when unavailable. Do not install a provider or track a repository automatically.
- Gate criteria, owners and failure actions are defined in `.agents/workflows/runbook-a/resources/phase-gates.md` — read it before the first gate. This file owns dispatch and step order; that file owns every verdict. The path is given from the repository root on purpose: a workflow is *copied* into each runtime's own directory (`.claude/skills/<name>/SKILL.md`) without its sibling `resources/`, so a relative path resolves to nothing from there.
- Persist state through `.agents/skills/_shared/runtime/memory-protocol.md`. Write every artifact this workflow produces under `.agents/results/runbook-a-{sessionId}/` — never into the product repository.

---

## What this workflow is for

The deliverable is **the evidence bundle, not the diff**.

This runbook exists because of a measured asymmetry: across four production
support tickets studied, the fix took 1.4 days on average and *verification*
took 8.3. None of the 8.3 was a coding problem. It was a reviewer re-deriving,
by hand, trust in a change they had no independent reason to believe.

So every step below produces a file, and the gates read those files. A step's
closing summary is a convenience for the human reading along; it is never what
a gate scores. This distinction is the whole design — see "Runner-owned facts".

---

## Runner-owned facts (read this before Step 1)

**An agent may not self-report a fact a tool can compute.**

This rule was bought expensively. An earlier version of this pipeline let the
implementing agent state which files it changed, how many lines, and which
commits it made. All three were wrong in ways that validated cleanly: a commit
made *before* the run began was reported as the run's own work, and the bundle
carrying that claim passed every schema check it had.

The fields below are computed, never accepted:

| Fact | Computed from | Never |
|---|---|---|
| commits, files changed, lines changed | `git diff --numstat <baseline>..HEAD` in the run's own checkout | the agent's list |
| oracle verdict (FAIL / PASS) | parsing the test runner's own XML/JSON report | "the test failed" in prose |
| tool and plugin versions | the installed manifest on disk | the agent's recollection |

**Capture a baseline before Step 1 and record it.** Every later measurement is
against *this run's* baseline, not against `main` — measuring against `main`
silently attributes to this run every commit anyone else landed since.

```bash
SESSION=$(date +%Y%m%d-%H%M%S)
RESULTS=".agents/results/runbook-a-${SESSION}"
mkdir -p "$RESULTS"
git -C "$CHECKOUT" rev-parse HEAD > "$RESULTS/baseline.sha"
```

**A placeholder that passes is worse than a failure that is honest.** Where a
value cannot be computed honestly, leave the field out and let validation
reject the bundle. That is the correct outcome, not a failure of nerve. A
`version: "unknown"` that satisfies a string schema is indistinguishable from
verified evidence to the reviewer reading it.

---

## Standing rules

These hold at every step, not just the one you are on.

- **Verify against the artifact, not the description.** A doc, a `FROM` line, a
  config file, the ticket's own words — none of them are the thing itself.
  Check what will actually run.

- **Build and test in the product's own container**, through the project's own
  compose or build target, so the toolchain and dependency versions are the ones
  the product ships with. A toolchain you install on the host proves nothing
  about the product. A host build is allowed only when the product has no
  container build at all, and the report says so in words.

- **Read the checkout's own `CLAUDE.md` / `AGENTS.md` before changing code in
  it.** This workflow runs with a minimal environment and no automatically
  loaded project files, so the product's conventions reach you only if you read
  them. Where they and these standing rules disagree, these win.

- **Never touch a remote, and never rewrite history** — except where Step 7
  says to, in words. Pushing, fetching, pulling, rebasing, force-pushing,
  amending and hard-resetting are all off limits. Committing locally is the
  whole of your git mandate.

  Fetching looks harmless because it only reads. It is not: it imports other
  work into your branch, and rebasing onto what it brings back mixes someone
  else's changes into what this run will claim as its own. A real run did
  exactly this and landed the same capability twice under two different names,
  each with its own passing test file. Every test was green.

- **Check whether it already exists before you add it — including under another
  name.** Match on what a thing *does*, not the name you were about to use. A
  thing named `x-y-z` and a thing named `x-z-y` are the same capability twice,
  and both will pass their own tests.

- **A negative result is a failed search until you have widened it.** "Not
  found" is a claim about the world and deserves the same scepticism as "found".
  Before concluding something is absent, broaden once: a different path, a
  looser pattern, a case-insensitive match. A real run halted the whole pipeline
  on "plugin not installed" when it was installed, four directories deeper than
  it looked.

- **Do only your own step's work.** These instructions describe the whole run,
  so they contain constraints addressed to *other* steps. Those are not yours to
  act on. A real run died here: the intake step read a "write the PR body"
  instruction meant for Step 7, wrote a PR body describing a fix that had not
  been made, and exhausted its budget before finishing its own job.

- **"Nothing to do here" is a real outcome — declare it.** Your job is the
  correct end state, not a diff. If your step's work is already satisfied or
  does not apply, write `skip.md` in the results directory saying **what you
  measured** — the command, the file, the count — and why nothing was needed.
  "Seems fine" is not a finding, and a step that is merely hard, slow or unclear
  is still yours. This exists because its absence killed real runs: a step with
  no way to say "nothing to stand up here" burned its entire budget issuing
  commands until it died with no output at all.

---

## Step 0: Has this already been fixed?

Before anything else, find out whether someone already did this work. A run
that does not look opens a second pull request against a bug that already has
one, after paying for every step.

```bash
KEY="<ticket key>"
git -C "$CHECKOUT" log --all --oneline --grep="$KEY" -i | head -20
git -C "$CHECKOUT" branch --all --list "*$KEY*"
gh pr list --state all --search "$KEY" --limit 10 \
  --json number,state,title,headRefName,url 2>&1 | head -40
```

Two failure modes look identical to "nothing found", and both must be reported
as partial rather than negative: `gh` with no token answers like an empty
result, and the ticket key is not always in the commit subject — when the key
search is empty, widen once with a distinctive phrase from the ticket.

Write `prior-art.md` either way, including "none found; searched commits,
branches, PRs". **Found something? Do not start work and do not halt** — this
is a decision only a person can make. Surface what you found (the sha and
branch, the PR number and its state) so they can answer without repeating your
search, per the execution policy's clarification rule.

---

## Step 1: Ticket intake and classification

Turn the ticket into a structured context packet: problem statement, affected
product and repository, the reported example, constraints.

Then classify the **blast radius**, which decides how much of a person this
change is worth. This is the field every gate below routes on:

| Blast radius | Meaning | Oversight |
|---|---|---|
| `docs` | documentation only | flows through |
| `ui_parsing` | presentation, display, parsing of non-critical input | flows through |
| `schema` | data shape or migration | stops for a person |
| `deployment` | how the thing ships or runs | stops for a person |
| `protocol` | an interface other systems depend on | stops, and the approval must be justified in writing |
| `money` | billing, rating, tax, any arithmetic on currency | stops, and the approval must be justified in writing |

**An unclassified change gets `stop`, never `auto`.** Absence of evidence is not
evidence of safety, and defaulting the other way lets exactly the runs that went
wrong early sail through every gate.

The reason a gate fires on *some* changes rather than all of them: a gate that
fires on everything teaches reviewers to approve without reading, and a reviewer
who reads nothing is worse than no gate, because from the outside it still looks
like oversight. A production money-path change to tax arithmetic was once
approved in a single click by a pipeline that stopped four times regardless,
each time showing a step label and nothing else.

Write `context-packet.json` and `meta.json` (ticket, work type, product,
blast radius). **→ INTAKE_GATE**

---

## Step 2: Stand up the stack

Bring up only the affected product's profile(s). Confirm health via each
service's own healthcheck endpoint, not a process listing — a container that is
running and a service that is ready are different claims.

If the ticket is verifiable without a running stack (an infra change verified by
how config *renders*, say), that is a legitimate skip: write `skip.md` naming
what you checked. Record the topology in `meta.json`.

---

## Step 3: Write the failing oracle

Generalize the one reported example into a **parameterised test of 5–6 rows**,
using the target repo's existing test framework and conventions. Never invent a
new framework.

Run it against the **unfixed** code and capture the runner's own report to
`oracle-before.xml`. That capture is evidence, not a formality: once the fix
lands, the pre-fix failure is unrecoverable. It exists only here.

A single-row test that reproduces the one example proves the example. Five rows
that fail together prove the *class* of defect, which is what the fix has to
address. **→ ORACLE_GATE**

---

## Step 4: Fix the root cause

Minimal fix for the cause, not the symptom. Before you edit, find every caller
routing through the function you are about to change — one guard in the shared
function is a smaller diff than a guard in every caller, and patching only the
path the ticket names leaves every sibling still broken.

**The test-file lock.** Do not modify the oracle from Step 3, or any file under
a `test` / `spec` directory, under any circumstance. If you believe the test
itself is wrong, stop and say so rather than editing it — an agent that can edit
the test it is being judged by is not being judged.

Commit locally, naming the files you stage. Never `git add -A`: the results
directory and scratch files are not part of the change. Write `plan.md`
recording intent. **→ IMPL_GATE**

---

## Step 5: Verify (runs parallel with Step 6)

Re-run Step 3's oracle — expect PASS on **every** row, not a majority — and the
repo's existing regression suite for the touched area. Capture both runners'
own reports as `oracle-after.xml` and `regression.xml`.

For a `protocol` or `money` blast radius, adversarial verification is also
required and is yours, because it is a verification activity: re-run under a
second instance or node where the topology allows it, and **pattern-search for
the same defect shape elsewhere in the affected repositories**. The off-by-one
you just fixed is rarely the only one. Record findings, the search you ran, and
what you did not cover.

---

## Step 6: Capture a trace (runs parallel with Step 5)

If the change is UI-class and the repo has a browser driver configured, drive it
and capture a trace. **If not applicable, record "n/a" — this is a successful
outcome, not a failure.** A backend fix must never be blocked on a browser step
with nothing to test.

Steps 5 and 6 fan in here, and are scored together. **→ VERIFY_GATE**

---

## Step 7: Assemble the bundle and open the pull request

Fan in from Steps 5 and 6. This step must see **every** upstream step's output,
not just its immediate predecessors — the context packet from Step 1 and the
pre-fix failure from Step 3 are three and four hops back, and they are the two
things a reviewer most needs. A bundle assembled from immediate predecessors
alone will report the pre-fix failure as "not captured", or fabricate it.

Assemble from the files on disk, not from recollection:

- context packet and root-cause statement (Steps 1, 4)
- pre-fix oracle report, verbatim (Step 3)
- post-fix oracle and regression reports (Step 5)
- adversarial findings, where the blast radius required them (Step 5)
- trace, or "n/a" (Step 6)
- the diff, with commits/files/lines **computed from git** against the baseline
- tool and plugin versions, read from the installed manifests

Validate the bundle before publishing anything. A `money` or `protocol` bundle
with no adversarial section must be **rejected**, not silently accepted.

Branch as `fix/<ticket-key>`, push, and open the pull request against the
repository's normal target branch with the bundle as the body. **Never push to
`main` or `develop` directly**, regardless of autonomy — the worst case of an
unattended run should be an extra branch and PR to close, not a write to a
protected branch. **→ SHIP_GATE**

---

## When a step cannot proceed

Three distinct outcomes; using the wrong one is itself a failure:

- **Send it back.** When what stops you is an *earlier step's* output and that
  step could fix it — an oracle row that cannot reach the code it tests, a fix
  that leaks a message in an error body, a stack on the wrong branch — name that
  step and exactly what to change, with `file:line`. Re-run it and everything
  after it, **at most twice per run**; a third disagreement fails the run with
  both positions on record.

- **Ask.** When the decision is genuinely a person's — two behaviours the ticket
  could mean, a credential you do not have, an action that cannot be undone.
  Never ask what the ticket, the repository or the results directory can tell
  you.

- **Halt.** When no step of this run can fix what you found. Say what stopped
  you and stop. Reporting a problem and letting the run continue is the failure
  mode this workflow exists to prevent: later steps build on what you assert.

- **Widen.** When the evidence shows the defect lives in a *different*
  repository than the one you were handed — a 500 raised inside a service
  upstream of the portal you were given — name that repository and the evidence
  for it, and re-run from Step 2 with it added. Widen only on evidence that
  names where the fault is; a guess widens the run into the wrong code.
