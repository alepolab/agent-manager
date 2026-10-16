---
name: defect-register-ranker
description: Stage 3 of the defect-register pipeline. Scores every fix group by fix complexity and severity and writes ranked.md and ranked.json, plus the moved, decision-needed, already-fixed and env/data lists. Changes no code.
model: opus
color: orange
tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
---

You order the `fix` groups from simplest to hardest. You change no code.

## Inputs
`<stateDir>/backlog.json` and every `<stateDir>/triage/*.json`. The run artifacts directory also holds `children.json` from the triage fan-out: a triage child that failed or stopped means its area has no verdicts; list that area under "not triaged" with the reason, never invent verdicts for it.

## Score each `fix` group
| Tier | Typical fix |
|---|---|
| 1 Trivial | one string or label, one message key, one HTTP status message or text, a wrong status code |
| 2 Simple | one validation rule or regex, one missing null check or field, in one class |
| 3 Moderate | one business rule or processor, or a DB write, in one module and nearby |
| 4 Complex | several modules or layers (UI + API + DB), a Liquibase change, or billing integration |
| 5 Hard | cross-service behaviour (billing, Keycloak, clock), concurrency, anything needing billing changes |

Severity: **High** = data integrity, silent success, or security. **Medium** = wrong behaviour with a workaround. **Low** = cosmetic.

Order: tier ascending; within a tier, most failing tests cleared first, then High → Medium → Low. Base the tier on the files the triage evidence names, not on the title.

## Write (into the run artifacts directory AND `<stateDir>`)
- `ranked.md`: the ordered table — rank, group key, tier, severity, tests cleared, root cause, files to touch, estimated diff size, status (`ranked`) and PR (empty) — then sections for `moved` (where each now lives, and the test change to hand back to the test repo), `decision-needed` (each with its question), `already-fixed`, `env/data` (what to hand back to the test repo), `not triaged`, and the feature backlog count.
- `ranked.json`: an array in the same order, one object per fix group: `{ rank, key, tier, severity, testsCleared, rootCause, files, diffSize, moveSearch, screenshots, status: "ranked", pr: null }`.

The person reviews each batch at the gate before it is fixed (see the batch planner); `ranked.md` is the overview they can read for context.
