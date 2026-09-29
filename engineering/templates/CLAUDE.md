# CLAUDE.md — per-repo scaffold

This file is copied into a repo at onboarding and filled in with that
repo's real values. Every `{placeholder}` below must be replaced — a repo
that ships this file with placeholders still in it has not actually
onboarded to the pipeline.

## What this repo is

`{one paragraph: what the product does, who owns it, and which entry in
engineering/registry/products.yaml this repo maps to}`

Registry entry: `products.{product-id}` in
`engineering/registry/products.yaml`. That entry, not this paragraph, is
the source of truth for build/test commands and stack topology — keep
this file's summary in sync with it, and resolve any conflict in the
registry's favour.

That file is the SEED. Each instance copies it once into its own registry
store and edits that from the Products page, so where a run header carries a
`## Product (from the registry)` block, that resolved entry wins over both
this paragraph and the seed.

## Build

```
{build command — copy products.{product-id}.build, or state "no build
step" if the registry entry declares none}
```

## Test

```
unit:       {products.{product-id}.tests.unit}
atdd:       {products.{product-id}.tests.atdd, or "not yet wired"}
regression: {products.{product-id}.tests.regression, or "not yet named"}
ui_trace:   {products.{product-id}.tests.ui_trace, or "n/a — no UI surface"}
```

Run the repo's lint, format and type gates alongside unit tests — a green
test suite with a red typecheck is the most common way a local pass turns
into a red pipeline.

## Branch policy

```
bug:          {products.{product-id}.branches.bug}
feature:      {products.{product-id}.branches.feature}
infra:        {products.{product-id}.branches.infra, or "not applicable to this repo"}
forward_port: {products.{product-id}.forward_port, or "none configured"}
```

Never push directly to a protected branch. Branch off the branch named
above for the ticket's work type, and PR into it.

## Deployment truths

`{state every fact about how this repo actually runs that a code-only
review would miss — node count, shared vs. per-process state, whether
schema changes need a Liquibase tag, whether the service is
licence-gated. Example shape, drawn from AAA:}`

> Runs at `{stack.topology_default}` nodes by default
> (`engineering/registry/products.yaml` → `stack.topology_default`).
> Per-process in-memory state is **not** a correctness mechanism above
> 1 node — a fix that only works single-node is not a fix. See
> `REVIEW.md`'s two-node AAA worked example for what this catches that
> automated gates do not.

## In-product text (help, tooltips, descriptions, API docs)

Everything a user can read is written for the operator or customer: what
the screen, field or setting does and what to enter. Brief and
presentable, like the rest of the UI. It must never contain internal
information:

- Jira keys (`PCRFV-…`, `SBN-…`, `SA-…`, `URM-…`, `SASKNEPCR-…`,
  `CSUP-…`), Paperclip task ids (`ALE-…`), open-question or test-case ids
  (`OQ-6`, `TC733`, `AC-REST…`)
- Names of people, teams, customers or AI agents
- Confluence / Atlassian links, internal hostnames or IPs
- Design discussion, rationale, history or conclusions ("because a
  mistyped value fails silently", "restored for legacy parity")
- Words that betray unfinished or test content ("placeholder",
  "synthetic", "TODO")

This covers UI strings and templates, i18n and message bundles, help
content, form field help, tooltips, sheet and dialog descriptions, toasts
and error messages, email and SMS templates, System Config / customdata
descriptions and values (including Liquibase and seed data), and API docs
(`@Schema`, `@Operation`, OpenAPI text rendered in-app). Test data the
product can display follows the same rule. Ticket ids and rationale
belong in code comments, commit messages and the PR, never in a string.

Enforced: the plugin's internal-references guard (T1) blocks an edit that
adds such a reference to a user-facing file, and this repo keeps a test
that scans its user-visible strings (`{path of this repo's
no-internal-refs test}`), modelled on pcrf-ems-portal
`tests/no-internal-refs.test.ts` and `ApiDocsAtddTest`.

## Review

Every change to this repo is reviewed against this directory's own
`REVIEW.md` before merge: bugs, security, compliance, spec conformance,
and the deployment truths stated above. Seed that file from
`engineering/templates/REVIEW.md` if this repo does not have one yet.
