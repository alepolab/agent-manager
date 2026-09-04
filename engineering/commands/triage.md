---
description: Classify a ticket's work type and, for a bug, its blast-radius class; flag likely duplicates; state what's missing. Read-only.
argument-hint: <pasted ticket text>
allowed-tools: Read, Grep, Glob
---

# /triage

Classify a ticket using `engineering/registry/products.yaml` and
`engineering/registry/watches.yaml` as the only vocabulary — never invent a
category the registry doesn't define.

**This command is read-only.** Its whole value is a classification a human
or the pipeline can trust without re-deriving it; a triage step that can
also change files contradicts that. `allowed-tools` above deliberately
excludes `Write` and `Edit` — do not use `Bash` to work around that either.

## 1. Read the ticket

Input: `$ARGUMENTS` — pasted ticket text. Apply the `intent-template` skill
to it first: problem, outcome, affected systems, constraints, open
questions. "Not stated" is correct wherever the ticket doesn't say.

## 2. Work type

Pick one of the work types `registry/watches.yaml` actually dispatches —
each watch's `work_types` list draws from `bug`, `infra`, `feature`,
`change_request`. State which one, and quote the ticket language that
decided it. If the ticket is genuinely ambiguous between two, say so —
do not force a pick.

## 3. For bugs: blast-radius class

`registry/products.yaml` gives each product `owners` for a subset of:
`money`, `protocol`, `schema`, `ui_parsing`, `docs` — the same vocabulary
`watches.yaml` gates dispatch on via `max_blast_radius`. Pick the
**highest** class the bug actually touches, not the lowest one you can
justify:

- `money` — billing, rating, charging, vouchers: anything that changes
  what gets charged or paid
- `protocol` — Diameter, RADIUS, SIP, or any wire-protocol behaviour
- `schema` — a database schema or migration
- `ui_parsing` — a UI/portal rendering or parsing bug with no money or
  protocol path
- `docs` — no runtime behaviour at all

If none of those genuinely apply, say so rather than forcing a fit.

## 4. Affected product

Match the ticket against each product's `match` block in
`registry/products.yaml` (`components`, `projects`, `labels`). Name the
product you matched and the field that matched it. If nothing matches,
say so — that is a registry gap, not a triage failure, and belongs in your
report as exactly that.

A product whose `match` carries `unconfirmed: true` has no `components`,
`projects`, or `labels` to match against by construction — never match a
ticket to it, even on a name or component that seems obviously related.
Report it as a registry gap needing a repo champion's confirmation, the
same as any other product that matched nothing.

## 5. Dedupe

Compare the ticket's reported example against any other ticket, PR, or
comment text you were actually given in this conversation for the same
root cause. You have no `Bash` here to search Jira or GitHub yourself — if
nothing else was supplied, say plainly that dedupe was not checked, rather
than presenting silence as "no duplicates found."

## 6. What's missing

List every open question from step 1's `intent-template` pass, plus:

- a product that matched nothing in the registry
- a work type you could not decide between two options
- a bug you could not place in a blast-radius class

## Report

```
## Work type
...

## Blast-radius class (bugs only)
...

## Product match
...

## Duplicates
...

## Missing / open questions
...
```
