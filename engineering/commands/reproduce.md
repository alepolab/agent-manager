---
description: Stand the ticket's product stack up at the registry's topology and run the reported scenario.
argument-hint: <product> <ticket text or scenario>
allowed-tools: Bash, Read, Grep, Glob
---

# /reproduce

Bring up the affected product's stack and run the exact scenario the
ticket reports — nothing else, and nothing hardcoded here that
`registry/products.yaml` already states.

## 1. Resolve the product entry

Look up `$1` (or match it via the `intent-template` "affected systems"
field) against `registry/products.yaml`. Read the entry's `stack.compose`
and `stack.topology_default` — this command never assumes a compose
profile or a node count. If the registry does not name the product, stop
and say so rather than guessing a profile.

## 2. Bring up the stack

Bring up `stack.compose` at `stack.topology_default` nodes, following
`alepo-dev-team-infra` conventions:

- One `docker-compose.<product>.yml` per product, behind a `--profile`,
  joined on the external `alepo-shared` network.
- `database` and `sso` stacks provide MongoDB/MariaDB/Keycloak — bring
  those up first if the product needs them; compose cannot express
  `depends_on` across files.
- Address every service by its **container-internal name and port**
  (e.g. `http://urms:3000`), never the host-published port — routing via
  the host IP produces a *timeout*, not a refusal, which is the signature
  that the wrong address was used.
- If `stack.topology_default` is `2node`, bring up **two** nodes, not one.
  A single-node stack cannot fail the class of bug that only shows up once
  more than one process holds state — see `templates/REVIEW.md`'s
  two-node AAA worked example.

## 3. Confirm it's actually up

A running container is not a serving one. Hit each service's real
healthcheck endpoint or an actual request that returns data before
trusting it. A restart-looping container with `exit=0` and empty
`docker logs` is usually writing to a file log, not stdout — copy the log
directory out of the container and read it rather than guessing.

## 4. Run the reported scenario

Read the ticket's "Reported example" (from an `intent-template` pass, or
`$ARGUMENTS` directly). Reproduce those exact steps or that exact input
against the stack just brought up — not a paraphrase of them. If it does
**not** reproduce, say so plainly; that is a real, reportable outcome, not
a step to quietly retry until it does.

## Report

State: the product and topology resolved from the registry, the exact
compose commands run, how health was confirmed (the request and its
response, not "it looked fine"), the scenario run, and whether it
reproduced — with the actual output.
