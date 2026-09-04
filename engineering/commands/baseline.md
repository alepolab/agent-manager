---
description: Run the product's ATDD/regression subset for a feature or infra ticket, per the registry's test commands.
argument-hint: <product> [suite]
allowed-tools: Bash, Read, Grep, Glob
---

# /baseline

A feature or infra ticket has no single failing example to reproduce — the
oracle is the product's existing ATDD/regression subset. Run it; do not
hand-write a substitute.

## 1. Resolve the product entry

Look up `$1` against `registry/products.yaml`. Read its `tests` block —
`unit`, `atdd`, `regression`, `ui_trace`, `compose_test` — and its `build`
command if one is declared. Never hardcode a test command here; a product
not in the registry is a registry gap, not something to guess `npm test`
for.

## 2. Pick the subset

- Feature ticket with a UI surface → `tests.atdd` (must emit xunit — the
  pipeline parses a verdict, it does not grep logs) plus `tests.ui_trace`
  if the registry names one.
- Infra ticket → `tests.compose_test` if the registry names one for this
  product; otherwise the nearest `tests.atdd` / `tests.regression` entry
  that exercises the changed profile.
- If the registry marks a test command blocked (e.g. a `# blocked on V2`
  comment), say so in the report rather than running it and misreporting
  the result.

## 3. Build, if needed

Run `build`, if the entry declares one, before tests — same as any other
suite.

## 4. Run it against the current, unfixed code

Capture the output verbatim, including exit code and pass/fail counts.
This is the baseline: what already passes and fails *before* any change,
so a later verification step can tell a new failure from a pre-existing
one.

## Report

State: the product and test commands resolved from the registry (quote
the field names, e.g. `tests.atdd`), the exact commands run, their exit
codes, and the verbatim pass/fail output. Flag anything the registry
marks blocked rather than silently skipping it.
