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

## Review

Every change to this repo is reviewed against this directory's own
`REVIEW.md` before merge: bugs, security, compliance, spec conformance,
and the deployment truths stated above. Seed that file from
`engineering/templates/REVIEW.md` if this repo does not have one yet.
