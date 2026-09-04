# Product registry

## What it is

`registry/products.yaml` (schema: `registry/schemas/products.schema.json`) is
how a ticket becomes a repo, a branch, a stack profile, an image to pull, and
a version to reproduce against — with no human looking anything up. This
document covers the version-resolution fields (`images`, `version`,
`upgrade_policy`); the rest of the entry (branches, stack, tests, owners) is
documented by the comments in `products.yaml` itself.

## Why: the pipeline's wrong assumption

The pipeline used to check out a product's branch policy (e.g. `develop`) and
reproduce a bug there. That is wrong for a support ticket: a customer runs
whatever version they installed, which may be months behind `develop`.
DEVOPS-23 referenced a versioned checkout at `/home/alepo/1.23.0/...`; the
pipeline reproduced against `develop` instead. If the bug had already been
fixed after 1.23.0, the entire run would have reproduced nothing and wasted
the run — while telling nobody that the version it ran against was wrong.

Two decisions follow from this:

1. **The version comes from reading the whole ticket** — all fields,
   description and comments — not from one fixed Jira field. `version.hint`
   exists to help the agent recognise the right token once it's reading the
   issue; it does not select a field to look at.
2. **Upgrade-vs-backport is a per-product policy**, not a pipeline default.
   Some customers can take an upgrade; some are pinned to a certified
   version. `upgrade_policy` names which is true for this product.

## The fields

### `images` (array of strings, may be empty only when `version.strategy: none`)

The GHCR container package names (org `alepolab`) this product actually
publishes. **Repo name is not image name** — `lum-selfcare-v1` publishes
`lum-selfcare`, not `lum-selfcare-v1`. **One repo commonly publishes several
images** — `alepolab/pms` is one repo, three GHCR packages
(`pms-billing`, `pms-partner-management`, `pms-ratingengine`).

Every value in this repo's `products.yaml` was confirmed against
`gh api /orgs/alepolab/packages?package_type=container` and then against each
package's own `repository.full_name` — the API's authoritative link back to
the source repo — never assumed from string similarity to the repo name.
Getting this wrong is exactly the failure this task exists to prevent: it
silently points a ticket's reproduction at the wrong image.

### `version.strategy` (required, one of four)

How a customer-reported version maps to a resolvable ref, **for this
product's images specifically** — there is no one convention across GHCR (see
Evidence below).

| Value | Meaning | Products using it here |
|---|---|---|
| `semver_tag` | A `vMAJOR.MINOR.PATCH` tag (optionally `-rc.N`, `-debug`, `-beta.N`) identifies a release. | pcrf (`alepopcrf-14`), vms |
| `branch_date_sha` | Tags are `<branch>-<yyyymmdd>-<shortsha>`. No release-number tag exists; a ticket's version must be resolved to a date/sha found in the ticket's own evidence, never guessed. | ffm |
| `versioned_image_name` | The version is baked into the **GHCR package name itself** — one package per release — not into a tag on a shared package. | aaa |
| `none` | No image this product publishes carries anything version-shaped, at any evidence level checked. **The pipeline must halt and escalate, not fall back to a branch.** | pms |

`none` is a deliberate, permanent-until-changed halt condition — not a
placeholder for "not yet researched." If you set `none` for a product, also
set `version.hint` explaining what you checked, so the next person doesn't
redo the same investigation.

### `version.hint` (optional)

The concrete tag/package shape actually observed, with a real example, and —
just as important — what to *ignore* (nightly or CI tags that look
version-shaped but aren't a release). Every product entry in this repo
carries one; it is the compressed form of the evidence below.

### `upgrade_policy` (required, one of three)

| Value | Behaviour when the bug is already fixed on a later version than the customer runs |
|---|---|
| `can_upgrade` | Halt the run, recommend the upgrade. Don't spend a backport on it. |
| `pinned` | Continue to a backport anyway — this product's customers cannot generally take an upgrade on demand. |
| `both` | Depends on the ticket/customer; the agent reads the issue for a signal rather than assuming either path. |

**Every `upgrade_policy` in this repo is currently `pinned`, marked
`CONFIRM`.** GHCR shows tags, not customer support terms — there is no API to
check this against, so it was not derived from evidence, and guessing
`can_upgrade` risks telling a customer who cannot upgrade to go upgrade,
which is a worse failure than an unnecessary backport. `pinned` is the
fail-safe default until a repo champion confirms the real policy per
product.

## Evidence, per product (measured 2026-09-03/04)

Method: `gh api /orgs/alepolab/packages?package_type=container --jq '.[].name'`
enumerated every container package in the org; each candidate's
`repository.full_name` (via `gh api /orgs/alepolab/packages/container/<pkg>`)
confirmed which repo actually publishes it; each product's `repos:` entries
were confirmed live with `gh api /repos/<owner>/<name>`; tags were sampled
with `gh api /orgs/alepolab/packages/container/<pkg>/versions`.

**There is no single tag convention across the org.** Confirmed shapes:

```
ffm-api              develop-20260902-ce21fb4                     branch-date-sha
pcrf-ems-portal       develop-20260903-07150d9                    branch-date-sha
alepopcrf-14          v14.0.2, v14.0.2-debug, 20260824 (nightly)   semver + separate nightly stream
voucher-management    v14.0.1, develop-20260828-…, latest          semver AND branch-date-sha, same package
aaa-server-14.0.3-oel9-mysql   2026-08-11-11-39-14 (only tag)       version is the PACKAGE NAME; tag is a build timestamp
pms-billing            sha-f8ed24f, latest, main, develop, ci-release   no version shape at all
```

- **aaa** — `aaa-server-oel9-mysql`, `aaa-server-release-mysql`,
  `aaa-builder-oel8`, `aaa-builder-oel9` all confirmed linked to
  `alepolab/aaa_rhel8`. A whole family of packages named
  `aaa-server-<major.minor.patch>-oel{8,9}-mysql` (13.0.8, 13.0.9, 14.0.0
  through 14.0.3, both OEL8 and OEL9) is also linked to the same repo — GHCR
  publishes **one package per release** here, not one package with version
  tags. Their own tags are single build timestamps
  (`2026-03-09-07-53-58`) — not a version. `aaa-server-release-mysql` carries
  `14.0.3-rc` / `14.0.2-rc` release-candidate tags on a package with no
  version in its name. `strategy: versioned_image_name`.

- **pcrf** — `alepopcrf-14` confirmed linked to `alepolab/pcrf_cpp14`.
  `pcrf-ems-portal` and `pcrf-ems-portal-agent` confirmed linked to
  `alepolab/pcrf-ems-portal` (the second repo in this `multi_repo` product).
  The two repos do **not** share a version scheme: the engine
  (`alepopcrf-14`) is `semver_tag`; the EMS portal is `branch_date_sha` with
  no matching semver at all. `version.strategy` here names the
  customer-facing engine version (`semver_tag`); resolving the matching EMS
  portal build is a date-proximity lookup, not a tag match, and is called out
  explicitly in `version.hint` rather than silently assumed to follow the
  same rule.

- **ffm** — `ffm-api` and `ffm-worker` confirmed linked to `alepolab/ffm`.
  Excluded: `pycore/ffm-pycore`, `pycore/ffm-pycore-celery`,
  `pycore/ffm-pycore-gunicorn` are linked to `alepolab/pycore`, a separate
  shared-library repo — not `alepolab/ffm` — even though the package names
  look like they belong to FFM. `strategy: branch_date_sha`; no semver tag
  exists on either image.

- **pms** — `pms-billing`, `pms-partner-management`, `pms-ratingengine` all
  confirmed linked to `alepolab/pms` — one repo, three GHCR packages, exactly
  the split this task called out as a known gap. Roughly 15 recent versions
  were sampled on each package; every tag seen was `sha-<shortsha>`,
  `latest`, `main`, `develop`, or `ci-release`. **None of them is
  version-shaped, on any of the three images.**

  **`strategy: none` is a factual finding, not an unfinished entry: a ticket
  naming a PMS release like "1.23.0" cannot be resolved to an image today.**
  The honest, and required, behaviour for the pipeline is to halt and
  escalate rather than substitute `develop` or guess a `sha`. Fixing this for
  real needs a PMS release-tagging convention that does not exist yet in
  their CI — that is a PMS-side change, not something this registry can work
  around.

- **vms** — `voucher-management` confirmed linked to
  `alepolab/voucher-management`. The same package publishes both `vX.Y.Z`
  release tags and `develop-YYYYMMDD-sha` / `ci-release-YYYYMMDD-sha` /
  `latest` CI tags. `strategy: semver_tag` — a customer-reported VMS release
  is always the `vX.Y.Z` form; the CI tags exist for continuous deploy of
  pre-release code and are explicitly called out to ignore in the hint.

## What was refused rather than guessed

- **`upgrade_policy`** for all five products: no evidence source exists for
  this (it is a support/contracts decision, not something GHCR or the repo
  can answer). Set to the fail-safe default `pinned` and marked `CONFIRM`
  rather than invented per product.
- **A repo entry for `alepolab/aaa-ems-portal`**: GHCR shows this repo
  publishing its own `aaa-ems-portal` image (tags: `latest`,
  `v1.0.0-beta.1`, plus `develop`/`ci-release`-date-sha builds), and it is a
  real, non-archived repo. It was **not** added to `aaa.repos` or
  `aaa.images` — whether the AAA EMS portal is part of the `aaa` product for
  ticket-routing purposes, or its own product, is a routing decision this
  task's evidence doesn't settle. Needs a repo-champion call.
- Any product beyond the five already in the registry. See below.

## Candidate products found in GHCR (not added — need confirmation)

These have a live, non-archived repo and at least one confirmed linked GHCR
package, so they are plausible next entries, but were **not** added
speculatively — each needs a repo champion to supply `match`, `branches`,
`stack`, `tests`, and `owners`, which this task's evidence does not cover:

| Candidate repo | Confirmed image(s) | Tag shape observed |
|---|---|---|
| `alepolab/charging-gateway` | `charging-gateway` | `develop-YYYYMMDD-sha` |
| `alepolab/pc` | `pc` | `ci-release--YYYYMMDD-sha` (double hyphen — malformed, worth fixing at the source before this becomes a `version.strategy`) |
| `alepolab/recharge-promotion-manager` | `recharge-promotion-manager` | not sampled beyond existence |
| `alepolab/collection-manager` | `collection-manager`, `collection-manager-develop`, `collection-manager-ci-release`, plus one-off branch-named packages (`collection-manager-fix/sbn-2932-...`) | mixed; several packages per repo, one of them clearly a stray feature-branch artifact |
| `alepolab/tacplus-server` (not `tacacs-platform`) | `tacacs-server` | `v1.1.0`, `v2.0.0`, `v0.0.1_TAC-149` — semver-ish but inconsistent |
| `alepolab/tacacs-platform` | `tacacs-web`, `tacacs-liquibase`, `tacacs-keygen` | not sampled beyond existence |
| `alepolab/lum-selfcare-v1` | `lum-selfcare`, `lum-selfcare-ci-release` | not sampled beyond existence |
| `alepolab/ase_lbss` | `alepo-crm` | not sampled beyond existence |
| `alepolab/urm` | `urm/urms` | not sampled beyond existence |
| `alepolab/wso2` | `wso2`, `alepo-wso2-integration` | not sampled beyond existence |
| `alepolab/order-management-system` | `order-management-system/joget-oms`, `order-management-system/joget-importer` | not sampled beyond existence |
| `alepolab/mpos-v2`, `alepolab/mpos` | `mpos-agent-portal` (+ versioned variants), `mpos/portal` | `mpos-agent-portal` also has `-v3.2.0-beta-r1`/`-r2` **package-name** variants, same `versioned_image_name` shape seen in aaa |
| `alepolab/billing_cpp14` | `alepobilling-14` | `vX.Y.Z(-debug)` plus `DDMMYYYY`-shaped nightly tags — semver, same family as pcrf's engine |
| `alepolab/ocs_cpp14` | `alepoocs-14` | `vX.Y.Z(-debug)` plus `YYYYMMDD` nightly tags and one stray `devops18-test` |

Two packages resolved to **no repository link at all** (`alepolicserver`,
`aaa-ems-release-mysql`) — orphaned or hand-pushed images; do not treat them
as any product's canonical image without finding out where they come from.

One repo-naming discrepancy worth flagging on its own: `tacacs-server` (the
Go server binary) is linked to `alepolab/tacplus-server`, while
`tacacs-web`/`tacacs-liquibase`/`tacacs-keygen` are linked to
`alepolab/tacacs-platform` — two different repos under one conceptual
product, the same shape as pcrf's `multi_repo`, but with GHCR's own
repository link disagreeing about which repo owns the core server image name
that the product's own `CLAUDE.md` documents (`tacacs-platform`).

## How to add a product

1. Confirm the repo exists and get its real default branch:
   `gh api /repos/<owner>/<name>`.
2. Find every GHCR package it publishes: filter
   `gh api /orgs/alepolab/packages?package_type=container --jq '.[].name'`
   against `gh api /orgs/alepolab/packages/container/<pkg>
   --jq '.repository.full_name'` for each candidate — do not assume from the
   name.
3. Sample tags for each confirmed image:
   `gh api /orgs/alepolab/packages/container/<pkg>/versions --jq
   '.[].metadata.container.tags[]?'`. Decide `version.strategy` from what you
   actually see, not from what the org's convention "should" be — there
   isn't one.
4. Write `match`, `repos`, `images`, `version`, `upgrade_policy`, `branches`,
   `stack`, `tests`, `owners` per the schema. Mark anything not backed by
   evidence with a `# CONFIRM` comment rather than a bare guess, matching the
   rest of this file.
5. Run both validators (below). Fix everything the offline one reports before
   running the live one.

## Running the validators

```bash
# Offline: schema + semantic checks. No network, no `gh`. This is what CI and
# the pre-commit hook run — it must always pass with no credentials.
node engineering/scripts/validate-registry.mjs

# Also clone-check every repos: entry against a local checkout under
# /home/alepo, and confirm AGENTS.md/REVIEW.md are present.
node engineering/scripts/validate-registry.mjs --repos

# Opt-in, network + `gh` auth required: confirms every repos: entry resolves
# on GitHub and every images: entry resolves as a GHCR container package
# under the right org, read-only (GET only — never creates, modifies, or
# deletes anything). Kept as a separate flag on purpose: a validator that
# needs credentials to pass is a validator that gets skipped in CI.
node engineering/scripts/validate-registry.mjs --verify-remote
```

The registry check enforces, among the pre-existing rules:

- `version.strategy` is one of `semver_tag`, `branch_date_sha`,
  `versioned_image_name`, `none` (schema-level enum).
- `images` is non-empty whenever `version.strategy` is anything but `none` —
  a resolvable strategy with nothing to check a tag against is exactly the
  silent-misroute failure this task exists to prevent.
- `images` present with no `version.strategy` at all fails outright, rather
  than being silently treated as "unversioned."
- `upgrade_policy` is one of `can_upgrade`, `pinned`, `both`.

Proof these are real, not decorative: `engineering/scripts/test-validate-registry.mjs`
sets each of the above wrong in an isolated copy of the registry and asserts
the check fails **naming that field** — see cases 9–12 in that file.
