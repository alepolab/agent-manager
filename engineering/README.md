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
| Plan gate — `PreToolUse` hook that denies `Edit`/`Write` until `.agent/plan.md` exists and passes a structural check | `hooks/plan-gate.mjs` | implemented; hook registration (`hooks/hooks.json`) lands in a follow-on task |
| Test lock — `PreToolUse` hook that freezes the oracle (tests, fixtures, oracle-adjacent config) once source has been edited, closing the `Bash`/`sed -i` bypass an `Edit`-only lock leaves open | `hooks/test-lock.mjs` | implemented; hook registration lands in a follow-on task |
| Review template — the passes a reviewer agent makes: bugs, security, compliance, spec conformance, deployment truths | `templates/REVIEW.md` | not yet written; lands in a follow-on task |
| Ticket-to-repo registry — resolves a ticket to repos, branch, stack profile and test commands with no human lookup, plus its validator | `registry/`, `scripts/validate-registry.mjs` | implemented |
| Evidence-bundle schema — what every agent-authored PR must carry, posted through the Checks API | `schemas/evidence-bundle.v0.1.schema.json` | implemented |

A component listed here that is not yet wired into `hooks/hooks.json` is a
file on disk, not an active control — this table is deliberately explicit
about the difference so installing the plugin never silently promises more
than it currently enforces.

## Verifying the plugin

```bash
node scripts/test-plugin-manifest.mjs   # both manifests parse; every path they reference exists
node scripts/test-hooks.mjs             # the hooks deny what they claim to deny
node scripts/test-validate-registry.mjs # the registry validator rejects broken entries
```

## Layout

```
.claude-plugin/
  plugin.json        # plugin manifest — name, version, metadata
  marketplace.json    # single-plugin marketplace, source: "./" (this directory)
hooks/                # plan-gate.mjs, test-lock.mjs
registry/              # products.yaml, watches.yaml + JSON Schemas
schemas/               # evidence-bundle.v0.1.schema.json
scripts/               # validators and their tests
```
