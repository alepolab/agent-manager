# REVIEW.md — what a reviewer agent checks

This file defines the passes a reviewer makes over a change in this repo
before it is trustworthy to merge. It is seeded from
`engineering/templates/REVIEW.md` at onboarding (see
`engineering/templates/CLAUDE.md`) and then edited to the repo's own
specifics — this copy is the starting shape, not a substitute for a repo's
own version once one exists.

## Passes, in order

1. **Bugs** — does the change do what the evidence bundle claims? Read
   the failing test's FAIL output and the fix's PASS output side by side;
   do not take "tests pass" on faith. Watch for the classic silent
   failure modes: a `null` where an error should have been raised, an
   off-by-one at a boundary the test table did not cover, an exception
   swallowed instead of propagated.
2. **Security** — auth/authz on every new or changed endpoint; input
   validation on anything that reaches a shell, a query, or a template;
   no secret literal introduced (check the diff for anything that looks
   like a key, token, or password, not only files named `.env`).
3. **Compliance** — schema changes go through Liquibase with a rollback
   tag, never a hand-written migration. Structured logs match RFC 5424
   with PEN 36713, not an ad hoc format. Anything touching a `money` or
   `protocol` path (see `registry/products.yaml` → `owners`) is named
   explicitly in the review, even when it looks fine.
4. **Spec conformance** — does the change match what the ticket or
   context packet actually asked for, not a superset of it? A fix that
   also refactors, renames, or adds a flag nobody asked for is scope
   creep, and scope creep is exactly where an unreviewed extra risk
   hides.
5. **Deployment truths** — the pass every automated gate in this
   pipeline misses, because it requires knowing how the product actually
   runs, not only what the code says. Worked example below.

## Deployment truths — the worked example

**The two-node AAA truth.** `registry/products.yaml` sets
`aaa.stack.topology_default: 2node` deliberately: per-process in-memory
state is not a correctness mechanism for AAA, because it runs on more
than one node. A fix that stores a tombstone, a cache entry, or a dedupe
key in a process-local map is invisible to node B, and every automated
gate — unit tests, the ATDD suite, even a correctly generalised
regression matrix — runs single-process and passes cleanly regardless.
**A human reviewer caught this by hand**; nothing upstream of review did.
That is precisely why this pass exists as a named step rather than being
assumed to fall out of "tests pass."

When reviewing a fix, ask explicitly: *if this ran on the second node
right now, would the state this change relies on be there?* For any
product whose registry entry declares `topology_default: 2node` (or
higher), that question is mandatory, not optional-if-you-remember-it.

## What's important vs. what to skip

**Important — always look:**

- Anything on a `money` or `protocol` owner path (per
  `registry/products.yaml`)
- Anything that changes a schema, a migration, or a stored data shape
- Anything that changes auth, session, or permission logic
- Deployment-shape assumptions: single-node vs. multi-node, singleton vs.
  replicated, in-memory vs. shared state

**Skip — do not spend review time here:**

- Formatting-only diffs (the repo's own lint/format gate already owns
  this)
- Generated or vendored paths — see below
- Test-file changes that only *add* rows to an existing table (the test
  lock already prevents a test file being weakened; adding coverage is
  not a risk worth re-litigating)

## Generated and excluded paths

These are never hand-reviewed line by line, because nothing in them is
hand-written or repo-specific. Flag one of these paths only if it appears
in a diff *unexpectedly* — that is a sign something else went wrong, not
something to review on its own terms:

- `node_modules/`, `dist/`, `build/`, `.next/`, `.nuxt/`
- Lockfiles (`package-lock.json`, `bun.lock`, `poetry.lock`) — reviewed
  only for whether they belong at all, never line by line
- Liquibase-generated changelog boilerplate — the changeset's *intent*
  is reviewed, the generated XML/YAML wrapper is not
- Anything under a repo's own declared `generated/` or `.gen/`
  directory — name it explicitly in this repo's own copy of this file

## Pointer

The repo's own build/test commands, branch policy, and deployment truths
specific to it live in this repo's `CLAUDE.md` (seeded from
`engineering/templates/CLAUDE.md`). Read that first — this file is the
*method*, that file is the *facts*.
