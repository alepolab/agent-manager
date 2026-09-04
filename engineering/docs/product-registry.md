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
| `semver_tag` | A `vMAJOR.MINOR.PATCH` tag (optionally `-rc.N`, `-debug`, `-beta.N`) identifies a release. | pcrf (`alepopcrf-14`), vms, pc, cm, rpm, billing, ocs, selfcare, crm, urm, wso2, tacacs-platform |
| `branch_date_sha` | Tags are `<branch>-<yyyymmdd>-<shortsha>`. No release-number tag exists; a ticket's version must be resolved to a date/sha found in the ticket's own evidence, never guessed. | ffm, cgw |
| `versioned_image_name` | The version is baked into the **GHCR package name itself** — one package per release — not into a tag on a shared package. | aaa |
| `none` | No image this product publishes carries anything version-shaped, at any evidence level checked. **The pipeline must halt and escalate, not fall back to a branch.** | pms, ams |

`none` is a deliberate, permanent-until-changed halt condition — not a
placeholder for "not yet researched." If you set `none` for a product, also
set `version.hint` explaining what you checked, so the next person doesn't
redo the same investigation.

Two of the `semver_tag` products above are **customer-scoped**: `crm` and
`wso2` publish `<CUSTOMER>-vMAJOR.MINOR.PATCH` (e.g. `SASKTEL-v14.0.13`,
`sasktel-v14.0.8`), not one release line shared by every customer. The
customer prefix has to come from the ticket (customer profile, deployment
notes) — resolving a bare `v14.0.13` against these two products without a
customer name risks matching the wrong customer's build. `version.hint`
spells this out per product; it isn't a fifth `version.strategy` value
because the underlying tag shape is still `vMAJOR.MINOR.PATCH`, just
namespaced.

### `match.unconfirmed` (optional, boolean)

A product can be added to the registry — with real, measured `images` and
`version` evidence — while its **routing** has no evidence at all. That's the
situation all twelve products added on 2026-09-04 are in: the Jira instance's
50+ projects are overwhelmingly customer-engagement and CR buckets (`AFGMB`,
`ALLO`, `ACTBB`, `AFDRC`, ...), not product routers, so there is no reliable
way to derive `components`/`projects`/`labels` for them the way `images`/
`version` were derived from the GitHub/GHCR APIs.

Setting `match.unconfirmed: true` records that state explicitly and makes it
safe: the registry check (`validate-registry.mjs`) rejects any entry that sets
`unconfirmed: true` alongside `components`/`projects`/`labels` — routing must
be fully confirmed or fully inert, never both — and an unconfirmed product
contributes nothing to the check's own reachability accounting, so it can
never absorb a ticket meant for another product. `/triage`'s product-match
step (`commands/triage.md`) is told the same thing: a `match.unconfirmed: true`
product has nothing to match against by construction, and matching to it on a
name or component that merely seems related is exactly the mistake this flag
exists to prevent. A wrong `match` is worse than a missing product — it
quietly sends a ticket to the wrong repo instead of failing loudly — so
`unconfirmed: true` stays in place until a repo champion supplies real
routing criteria and removes it.

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

- **`upgrade_policy`** for all seventeen products: no evidence source exists
  for this (it is a support/contracts decision, not something GHCR or the
  repo can answer). Set to the fail-safe default `pinned` and marked
  `CONFIRM` rather than invented per product.
- **`match`** for the twelve products added 2026-09-04 (`cgw`, `pc`, `cm`,
  `rpm`, `billing`, `ocs`, `selfcare`, `crm`, `urm`, `wso2`,
  `tacacs-platform`, `ams`): the Jira instance's 50+ projects are
  overwhelmingly customer-engagement and CR buckets, not product routers, so
  `components`/`projects`/`labels` cannot be derived the way `images`/
  `version` were. Set to `match.unconfirmed: true` — see
  [`match.unconfirmed`](#matchunconfirmed-optional-boolean) above — rather
  than guessed, and made inert by the registry check rather than left as a
  silent routing risk.
- **A repo entry for `alepolab/aaa-ems-portal`**: GHCR shows this repo
  publishing its own `aaa-ems-portal` image (tags: `latest`,
  `v1.0.0-beta.1`, plus `develop`/`ci-release`-date-sha builds), and it is a
  real, non-archived repo. It was **not** added to `aaa.repos` or
  `aaa.images` — whether the AAA EMS portal is part of the `aaa` product for
  ticket-routing purposes, or its own product, is a routing decision this
  task's evidence doesn't settle. Needs a repo-champion call.
- **Any product beyond the seventeen now in the registry.** See below for
  the two still outstanding.

## Evidence for the twelve products added 2026-09-04

Method: identical to the section above — `repos:` confirmed live with
`gh api /repos/<owner>/<name>`; every `images:` entry confirmed against
`gh api /orgs/alepolab/packages?package_type=container` and then the
package's own `repository.full_name`; tags sampled with
`gh api /orgs/alepolab/packages/container/<pkg>/versions`, paginated to the
end where the first page returned exactly 100 (several packages here needed
that — `collection-manager`, `alepo-wso2-integration` and `alepo-crm` all had
a second page that changed the picture from a first-page-only sample).
`branches`, `stack`, `tests`, `owners` are first drafts drawn from the
CLAUDE.md repo map, same as the original five, and marked `CONFIRM` in
`products.yaml` itself rather than repeated here.

- **`cgw`** (`alepolab/charging-gateway`) — `charging-gateway` confirmed
  linked. Full 19-tag history: `develop-YYYYMMDD-sha` /
  `ci-release-YYYYMMDD-sha` dominate; a single `v14.0.0-rc.1` was never
  followed by a GA or patch, and two legacy bare tags (`3.0.0`, `3.0.1`, no
  `v` prefix) predate the current scheme. `strategy: branch_date_sha` — the
  one `-rc.1` tag isn't a resolvable convention on its own.

- **`pc`** (`alepolab/pc`) — `pc` confirmed linked. Full 144-tag history:
  `v1.0.0-beta.1` through `.5`, `v14.0.0-rc.1/2/3`, `v14.0.0` GA.
  `strategy: semver_tag`. CI tags are malformed with a double hyphen
  (`ci-release--YYYYMMDD-sha`, `develop--YYYYMMDD-sha`) — worth fixing at the
  source, but harmless here since they don't collide with the `vX.Y.Z` shape.

- **`cm`** (`alepolab/collection-manager`) — `collection-manager` confirmed
  linked; full paginated history (198 version entries) shows a real
  progression: `v1.0.0-beta.1/2`, `v14.0.0-beta.1`, `v14.0.0-rc.1-3`,
  `v14.0.0`, `v14.0.1`, `v14.0.2`. `strategy: semver_tag`. The same repo also
  publishes `collection-manager-ci-release` and `collection-manager-develop`
  (pure CI mirrors — sha/branch tags only), `collection-manager-v1.0.0-beta`
  and `collection-manager-v14.0.0-beta-1` (one-off packages with the version
  in the package name, predating the tag-based scheme now used on the main
  package), and `collection-manager-fix/sbn-2932-out-of-dunning-activity` (a
  stray feature-branch package) — all confirmed linked to the same repo, all
  excluded from `images:`.

- **`rpm`** (`alepolab/recharge-promotion-manager`) — confirmed linked. Full
  59-tag history: `v1.0.0-beta.1`, `v14.0.0-rc.1/2`, `v14.0.0`, `v14.0.1`.
  `strategy: semver_tag`. One `v2.0.0` tag sits outside the `v14.x` line —
  not part of the current release, ignore it.

- **`billing`** (`alepolab/billing_cpp14`) — `alepobilling-14` and
  `billing-builder-oel9` both confirmed linked. `alepobilling-14`: full
  56-tag history, `vMAJOR.MINOR.PATCH(-debug)` plus `DDMMYYYY` nightly tags —
  same family as pcrf's engine. `billing-builder-oel9` carries only `latest`
  (build tooling, no version). `strategy: semver_tag`.

- **`ocs`** (`alepolab/ocs_cpp14`) — `alepoocs-14` and `ocs-builder-oel9`
  both confirmed linked. `alepoocs-14`: full 59-tag history,
  `vMAJOR.MINOR.PATCH(-debug/-rc.N)` plus `YYYYMMDD` nightly tags and one
  stray `devops18-test`. `ocs-builder-oel9` carries only a long-sha tag and
  `latest`. `strategy: semver_tag`. Excluded: `ocs-ems` confirmed linked to
  `alepolab/ocs-ems`, a separate, unlisted repo — not `ocs_cpp14`.

- **`selfcare`** (`alepolab/lum-selfcare-v1`) — `lum-selfcare` (full 325-tag
  history: `v14.0.0-beta.1` through `v14.0.17`) and `lum-selfcare-ci-release`
  (full 108-tag history, no version tag at all — pure CI mirror) both
  confirmed linked. `strategy: semver_tag`. **Excluded, and worth
  emphasising**: `selfcarenow` / `selfcarenow-develop` /
  `selfcarenow-ci-release` confirmed linked to `alepolab/selfcarenow`, and
  `selfcare` confirmed linked to `alepolab/selfcare` — three different,
  unlisted repos, not `lum-selfcare-v1`, despite package names close enough
  to invite exactly the repo-name-vs-image-name mistake this evidence
  standard exists to catch.

- **`crm`** (`alepolab/ase_lbss`) — `alepo-crm` confirmed linked. Full
  104-tag paginated history: a real, ongoing per-customer stream,
  `SASKTEL-v14.0.0` through `SASKTEL-v14.0.13` (14 releases), plus a
  generic/OWNCORE stream (`v14.0.0`, `v14.0.0-ga`, `v14.0.0-ga.rc.1/2`).
  `strategy: semver_tag`, customer-scoped — see the note above the field
  table. `ase_lbss` is documented elsewhere as a multi-repo workspace whose
  `modules/*` are each their own git repo; this entry covers only the
  top-level container repo confirmed to publish `alepo-crm` — the modules
  were not evidenced and are out of scope here.

- **`urm`** (`alepolab/urm`) — `urm/urms` confirmed linked. Full 130-tag
  paginated history: `v1.0.0`/`v1.0.0-beta.1-5` early, `v14.0.0-rc.1-4`,
  `v14.0.0`, `v14.0.1`, `v14.0.2`. `strategy: semver_tag`. Two
  `v3.0.0-mpos-base`/`-r1` tags sit outside the main line — an mpos-specific
  variant, not URM's own release version.

- **`wso2`** (`alepolab/wso2`) — `wso2` (1 tag ever, `SE-Demo-v3.0.0` — a
  one-off demo, not a stream) and `alepo-wso2-integration` (full 272-tag
  paginated history) both confirmed linked. The integration package publishes
  per-customer builds, `<customer>-vMAJOR.MINOR.PATCH`: `sasktel-v14.0.0`
  through `sasktel-v14.0.8`, a clean 9-release sequence. `strategy:
  semver_tag`, customer-scoped. First-page-only sampling would have missed
  this and looked like `none` — paginating fully changed the answer here.

- **`tacacs-platform`** (`alepolab/tacplus-server` +
  `alepolab/tacacs-platform`, `multi_repo: true`) — `tacacs-server` confirmed
  linked to `tacplus-server`; `tacacs-web`, `tacacs-liquibase`,
  `tacacs-keygen` confirmed linked to `tacacs-platform` — the same shape as
  pcrf's `multi_repo`, resolving the repo-naming discrepancy noted below.
  Full histories: 47/37/19/12 tags respectively (all under the per-page cap).
  All four share one `vMAJOR.MINOR[.PATCH]` family, but noisier than the
  org's other `semver_tag` products: missing-patch shorthand (`v2.0`,
  `v2.1`), a Jira-ticket-suffixed tag (`v0.0.1_TAC-149`), a bare Jira key
  with no version (`TAC-102`), and a wide internal/test tag family
  (`v1.0.0-internal.*`, `v1.0.0.testN`, `vtest`, `vdeep.*`) that must be
  discarded rather than loosely matched. `strategy: semver_tag`. Excluded:
  `tacacsplusserver` (near-identical package name) confirmed linked to
  `alepolab/devops-adhoc` — unrelated to this product. GitHub's default
  branches also disagree across the two repos (`master` vs `main`) and both
  disagree with the CLAUDE.md repo map's stated `develop` — flagged as
  `CONFIRM` in `products.yaml`, not resolved here.

- **`ams`** (`alepolab/alepo-mediation-studio`) — repo confirmed live and
  non-archived. **No GHCR container package's `repository.full_name` matches
  it at all**, as of 2026-09-04 — a stronger gap than `pms` (which has real
  images with no version-shaped tags). `images: []`, `strategy: none`. Added
  anyway, per the schema's own allowance for `images: []` "only when
  `version.strategy: none` and no image has been catalogued yet" — this is
  exactly that case, not a placeholder.

One repo-naming discrepancy resolved by this evidence, stated explicitly
because it's the shape of mistake this task exists to catch: `tacacs-server`
(the Go server binary) is linked to `alepolab/tacplus-server`, while
`tacacs-web`/`tacacs-liquibase`/`tacacs-keygen` are linked to
`alepolab/tacacs-platform` — two different repos under one conceptual
product, now represented as `tacacs-platform`'s `multi_repo: true` entry.

Two packages resolved to **no repository link at all** (`alepolicserver`,
`aaa-ems-release-mysql`) — orphaned or hand-pushed images; do not treat them
as any product's canonical image without finding out where they come from.

## Candidate products found in GHCR (not added — out of this task's scope)

These two were noted in the original evidence pass but were never in this
task's candidate list, so they were left exactly as found — a repo champion
would still need to name them, and neither `match` nor any other field was
attempted:

| Candidate repo | Confirmed image(s) | Tag shape observed |
|---|---|---|
| `alepolab/order-management-system` | `order-management-system/joget-oms`, `order-management-system/joget-importer` | not sampled beyond existence |
| `alepolab/mpos-v2`, `alepolab/mpos` | `mpos-agent-portal` (+ versioned variants), `mpos/portal` | `mpos-agent-portal` also has `-v3.2.0-beta-r1`/`-r2` **package-name** variants, same `versioned_image_name` shape seen in aaa |

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
   rest of this file. If `match` has no real evidence source (no reliable
   Jira component/project/label to route on), set `match.unconfirmed: true`
   instead of guessing — see [`match.unconfirmed`](#matchunconfirmed-optional-boolean)
   — and leave `components`/`projects`/`labels` out entirely; the registry
   check rejects an entry that sets both.
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
