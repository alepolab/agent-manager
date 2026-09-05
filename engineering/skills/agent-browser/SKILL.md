---
name: agent-browser
description: Use when a code change touches a UI and needs browser evidence - drives Playwright against a running local stack and captures a trace and screenshots as reviewable proof.
context: when
---

# Browser evidence for a change

Your output is evidence a reviewer can open, not a claim that the UI works.

## Before you drive anything

1. Confirm the stack is actually serving. Curl the app's own URL and check the
   status code before opening a browser — a browser failing against a dead
   service wastes a run and produces a misleading trace.
2. Find the project's existing Playwright setup: `playwright.config.*`, a
   `test:e2e`-shaped script in `package.json`, or an `e2e/` directory. Use what
   is there. Never scaffold a new Playwright project to satisfy this step.

## If the project has no Playwright setup

Report `n/a` and say why in one line — "no Playwright config in this repo" or
"change is backend-only, no UI surface". This is a legitimate, successful
outcome. Do not install Playwright, and do not fail the step.

## Capturing the evidence

- Run the existing suite, or the single spec that covers the changed surface,
  with tracing on: `--trace on` (or the config's own tracing setting).
- Record the exact command you ran and its exit code.
- Report the trace artifact's path on disk (typically `test-results/**/trace.zip`)
  so a reviewer can open it with `npx playwright show-trace <path>`.
- If a screenshot baseline exists for the changed screen, run the comparison and
  report the diff result. If none exists, say so rather than inventing one.

## What to report

Report exactly: the command, the exit code, pass/fail counts, the trace path,
and screenshot-diff results if applicable. If the run failed, quote the failing
assertion verbatim — a summary of a failure is not evidence of one.
