# Runbook A — Phase Gate Definitions

This file is the canonical definition of gate criteria, owners, oversight
routing and skip conditions. `runbook-a.md` owns dispatch and step order; this
file owns every verdict.

Apply `.agents/skills/_shared/core/execution-policy.md` for authorization.
Existing authorization satisfies approval requirements; ask only for a material
missing decision. SHIP_GATE checks readiness — publishing itself requires
authorization for that action.

---

## Two independent questions

Every gate below answers two questions that are deliberately kept apart:

**Who is asked** — the gate's **Owner**. A gate is answered by the role that
owns it, not by whoever is nearest. Both the implementer and the reviewer can
technically answer a gate; if the runbook does not say which, the implementer
accepts their own verification, and the single review the runbook puts in
someone else's hands on purpose quietly stops existing.

**Whether anyone is asked at all** — the **oversight tier**, routed from the
blast radius Step 1 recorded:

| Tier | Behaviour |
|---|---|
| `auto` | Do not stop. The run carries on; the decision is reviewable afterwards. The honest trade for work that is cheap to undo. |
| `stop` | Pause and wait for the owner. |
| `justify` | Pause, and **refuse an approval that carries no written reason.** |

`justify` is not ceremony. Writing one sentence is the cheapest known defence
against rubber-stamping, because it forces the reviewer to have read something.

Two escapes, both deliberate:

- **A gate with no owner is anyone's.** A gate nobody can answer is worse than
  one anybody can.
- **An operator may always answer.** They are the backstop for a role nobody on
  this instance holds. Without it, a two-person team with no dedicated reviewer
  has a run stuck forever and no way to move it that is not a lie about who
  decided.

A refusal must **name the owner**, never just refuse. "Forbidden", against a
control you were shown, is indistinguishable from a bug — the person reading it
needs to know who to go and ask.

---

## INTAKE_GATE

**Owner**: Manager
**Trigger**: After Step 1
**Oversight**: always `stop` — this gate is what *establishes* the tier, so it
cannot route on it.

### Criteria
- [ ] Problem statement names observable behaviour, not a proposed solution
- [ ] Affected product and repository identified
- [ ] Blast radius classified, from the fixed vocabulary, with one line of reasoning
- [ ] Prior-art search recorded in `prior-art.md`, including which searches ran and which were unavailable
- [ ] Any prior art found has been put to a person, not decided by the run

### Failure Action
Re-run intake. Do not stand up a stack against an unclassified ticket — every
later gate routes on a field that does not yet exist.

---

## ORACLE_GATE

**Owner**: QA
**Trigger**: After Step 3
**Oversight**: `auto` for `docs` / `ui_parsing`; `stop` otherwise.

### Criteria
- [ ] `oracle-before.xml` exists and is the **test runner's own output**, not prose describing it
- [ ] Parsed verdict is FAIL — something was genuinely reproduced
- [ ] The oracle is parameterised across 5–6 rows, not a single case
- [ ] Rows generalize the class of defect; at least one is not the literal reported example
- [ ] The oracle uses the repository's existing framework and conventions

### Auto-pass Conditions
These let gate bookkeeping proceed once the criteria above hold. They do not
waive a criterion.

- Blast radius is `docs` or `ui_parsing`
- The oracle is an extension of an existing test file rather than a new one

### Failure Action
Rewrite the oracle. **A green oracle before the fix is the most dangerous
outcome in this runbook** — it means the test does not reach the defect, and
every later PASS will be meaningless. Never "fix" it by loosening an assertion.

---

## IMPL_GATE

**Owner**: Developer
**Trigger**: After Step 4
**Oversight**: `auto` for `docs` / `ui_parsing`; `stop` for `schema` /
`deployment`; `justify` for `protocol` / `money`.

### Criteria
- [ ] The oracle from Step 3 and every file under a `test` / `spec` directory are **unmodified** — verified from the diff, not asserted
- [ ] Only files the plan named were changed
- [ ] The fix addresses the cause; sibling callers of the changed function were checked
- [ ] No unrequested features, no speculative abstraction
- [ ] Commits were staged by name — no `git add -A`
- [ ] No remote was touched: no push, fetch, pull, rebase, amend or hard reset
- [ ] For `justify` tiers, the approval carries a written reason

### Auto-pass Conditions
- Diff under 200 lines **and** blast radius is `docs` or `ui_parsing`
- No new dependencies introduced

### Failure Action
Re-run the fix with the specific finding as its note. A modified test file is
never a pass — it invalidates the run's entire evidence chain, and no amount of
subsequent green recovers it.

---

## VERIFY_GATE

**Owner**: QA — and **never the same actor that answered IMPL_GATE.**
**Trigger**: After Steps 5 and 6
**Oversight**: `stop` for every tier except `docs`.

### Criteria
- [ ] `oracle-after.xml` parses to PASS on **every row**, not a majority
- [ ] `regression.xml` parses clean for the touched area
- [ ] Both are the runners' own reports, captured after the final commit
- [ ] Code changed after these captures invalidates them — fresh runs required
- [ ] Trace captured, or "n/a" recorded with the reason
- [ ] For `protocol` / `money`: adversarial verification present, naming the pattern search actually run and what it did not cover

### Failure Action
Send the finding back to the step that can fix it, with `file:line`. At most
twice per run; a third disagreement fails the run with both positions recorded.

---

## SHIP_GATE

**Owner**: Manager
**Trigger**: After Step 7, before the pull request is opened
**Oversight**: `stop` for every tier except `docs` / `ui_parsing`.

### Criteria
- [ ] Bundle contains the **pre-fix** failure verbatim — the one artifact that cannot be regenerated
- [ ] Bundle reaches back to Step 1's context packet, not only immediate predecessors
- [ ] Commits, files changed and lines changed were **computed from git** against this run's recorded baseline — not the agent's self-report, and not measured against `main`
- [ ] Tool and plugin versions read from installed manifests; no placeholder values
- [ ] Adversarial section present where the blast radius requires it, or the bundle is **rejected**
- [ ] Target branch is not `main` or `develop`
- [ ] A reviewer could check every claim without re-deriving trust in the diff

### Failure Action
Do not open the pull request. A bundle that fails validation is the system
working: it means a claim could not be substantiated, and shipping it would
launder an unverified assertion into something that looks reviewed.
