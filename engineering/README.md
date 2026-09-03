# alepo-engineering

A Claude Code plugin that packages the enforcement pieces of Alepo's agentic
SDLC pipeline, so an engineer who clones a repo and does nothing still gets
them — the guardrails arrive with the repo, not with whoever remembered to
configure them by hand.

## Install

```bash
claude plugin marketplace add /home/alepo/agent-manager/engineering
claude plugin install alepo-engineering@alepo-engineering
```

## What's in the box

| Piece | Path | Status |
|---|---|---|
| Plan gate — `PreToolUse` hook that denies `Edit`/`Write` until `.agent/plan.md` exists and passes a structural check | `hooks/plan-gate.mjs`, registered in `hooks/hooks.json` on `PreToolUse` matcher `Edit\|Write` | implemented and registered |
| Test lock — `PreToolUse` hook that freezes the oracle (tests, fixtures, oracle-adjacent config) once source has been edited, closing the `Bash`/`sed -i` bypass an `Edit`-only lock leaves open | `hooks/test-lock.mjs`, registered in `hooks/hooks.json` on `PreToolUse` matcher `Edit\|Write\|Bash` | implemented and registered — the `Bash` matcher is what actually closes the bypass; see below |
| Review template — the passes a reviewer agent makes: bugs, security, compliance, spec conformance, deployment truths | `templates/REVIEW.md` | not yet written; lands in a follow-on task |
| Ticket-to-repo registry — resolves a ticket to repos, branch, stack profile and test commands with no human lookup, plus its validator | `registry/`, `scripts/validate-registry.mjs` | implemented |
| Evidence-bundle schema — what every agent-authored PR must carry, posted through the Checks API | `schemas/evidence-bundle.v0.1.schema.json` | implemented |

A component listed here that is not yet wired into `hooks/hooks.json` is a
file on disk, not an active control — this table is deliberately explicit
about the difference so installing the plugin never silently promises more
than it currently enforces. As of this task, both hooks are wired: installing
the plugin now actually fires the plan gate and the test lock, not just ships
their source.

**Why the test lock's matcher includes `Bash`:** `test-lock.mjs` exists
specifically to stop an agent making a failing test pass by rewriting the
test rather than the source. An agent with a shell does not need `Edit` for
that — `sed -i`, `> file`, `tee`, `cp`, `rm`, `patch`, and `git checkout --`
all mutate a file without going through the `Edit`/`Write` tools. Registering
this hook for `Edit|Write` only would silently reinstate exactly the bypass
it was written to close, while looking like the control was enabled.
`scripts/test-plugin-manifest.mjs` asserts the `Bash` matcher explicitly, not
just as a comment, because that is the detail most likely to be silently
dropped by a future edit to `hooks/hooks.json`.

## Verifying the plugin

```bash
node scripts/test-plugin-manifest.mjs   # both manifests parse; every path they reference exists; hooks.json registers plan-gate + test-lock, and the test-lock matcher includes Bash
node scripts/test-hooks.mjs             # the hooks deny what they claim to deny, and fail open on malformed input
node scripts/test-validate-registry.mjs # the registry validator rejects broken entries
node scripts/test-validate-bundle.mjs   # the evidence-bundle schema rejects broken bundles
```

## Layout

```
.claude-plugin/
  plugin.json        # plugin manifest — name, version, metadata
  marketplace.json    # single-plugin marketplace, source: "./" (this directory)
hooks/                # plan-gate.mjs, test-lock.mjs, hooks.json (PreToolUse registration)
registry/              # products.yaml, watches.yaml + JSON Schemas
schemas/               # evidence-bundle.v0.1.schema.json
scripts/               # validators and their tests
```
