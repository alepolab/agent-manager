---
name: robot-spec-writer
description: Turn robot-scenario-analyst scenario sheets (docs/scenarios/**/*.scenarios.md) into runnable Playwright page objects, flows and .spec.ts files in the ase-crm-testPlaywright suite, then run them and prove every result matches the sheet (ready = pass, ready-bug = fails at the documented step, not-available = expected failure) before marking the tests ported in coverage.csv. Use it whenever the user asks to write, generate, implement or port the specs/tests for a Robot folder or suite that already has scenario sheets (e.g. "write the Taxes specs", "port Tax_Policy", "implement the sheets", "next step after the analyst"), or to fix/re-run specs generated from sheets, even if they don't say "spec writer". If the folder has no sheets yet, run robot-scenario-analyst first.
---

# Robot spec writer

You are the second of two agents in the Robot → Playwright port of the old Liferay CRM suite to the new ase-crm.
The first agent (`robot-scenario-analyst`) already did the hard thinking: it read the Robot code, explored the
live app and wrote a **scenario sheet** per Robot suite file. Every step, locator, toast, SQL query and expected
value in a sheet was verified and, where it mattered, approved by the user.

Your job is to turn sheets into **reliable, readable tests that check exactly what the sheet says**: no more,
no less. Treat the sheet as the specification. If you weaken an assertion so a test passes, coverage is
silently lost. If you guess a locator the sheet didn't give you, you get a flaky test someone has to debug.
And a "pass" that should have been a `@bug` failure hides a real product defect. So when the sheet and reality
disagree, don't improvise: use the small-fix path below, or stop and report.

## Locations
| What | Where |
|---|---|
| Scenario sheets (your input) | `docs/scenarios/<robot folder path>/<SuiteFile>.scenarios.md` (+ `_probe-report.md` = evidence) |
| Suite (your output) | `~/repos/ase-crm-testPlaywright`: `pages/`, `components/`, `flows/`, `data/`, `tests/`, `utils/api.ts`, `utils/db.ts`, `fixtures/` |
| Reference implementation | `tests/catalog/policies/billing-policy/*` + `pages/catalog/billingPolicy*` + `flows/billingPolicy.ts`: copy their patterns |
| Conventions (read before writing code) | `references/conventions.md` (this skill) |
| Old→new terms | `docs/terminology-map.md` |
| Coverage tracker | `docs/coverage.csv` (one row per Robot test); progress: `node scripts/coverage-summary.mjs` |
| Layout | `tests/` = only `*.spec.ts`; suite setup/teardown logic + fixed names in `data/<area>/suites/<suite>.ts`; thin run-once runners in `setup/<area>/…/<suite>.suite-setup.ts` / `.suite-teardown.ts` (own `testDir`) |
| Analyst tools you may reuse | `.claude/skills/robot-scenario-analyst/scripts/probe.mjs` (+ `references/probe-plan.md`), `scripts/dbq.mjs` (read-only SQL) |

Never use `~/repos/atddtestsuite_bss_playwright` (it targets the old CRM), and don't import from `~/repos/ase-crm/atdd`.
You don't need to read the Robot code. The sheet already carries everything from it. Open a Robot file only to
settle a wording doubt, never to add assertions the sheet doesn't list.

## Workflow

### 1. Read and check the input
- Read every sheet in the folder the user named, start to finish, plus `references/conventions.md` and the
  terminology-map section for the folder.
- Look at the existing `pages/`, `components/`, `flows/`, `utils/api.ts` and `utils/db.ts`, so you extend
  what exists instead of duplicating it. Sheets often point at existing helpers (`utils/api.ts › addTaxType`).
- Check readiness. Count the sections per `Status:`.
  - `blocked`: you don't implement these. Add a `test.skip` stub with the open question as the reason, so the
    ID stays visible in the report.
  - Sections with open questions that aren't `blocked`: ask the user before writing them.
- **Who decides when the sheet and this skill seem to disagree.** The sheet records the user's decisions, so
  an explicit, conditional instruction in it wins. For example, "if the delete is refused, drop `@bug`" means
  you check the condition, follow the instruction and say so in the report. Without such an instruction you
  never change a status or an assertion; you stop and report (step 3).
- **Small gaps you may fill yourself.** A sheet sometimes leaves a plain fact to look up: an enum code, a DTO
  field name, a default value. Read it from the ase-crm source and record it in the test's section as
  `**Corrections (spec writer, <date>):** <fact> — source <file:line>`. Anything that needs judgement (which
  value Robot meant, what the new CRM should do) is an open question: stop and report it.
- Note the sheet's **execution order and data dependencies**, its **suite setup / teardown**, global settings
  that tests change (like TaxSlabs), and any new table that will hold generated names.

Tell the user in a few lines what you're about to build: files, test counts per status, anything unusual.
Then go ahead. The plan was already approved at the analyst stage, so don't re-litigate it unless something
in the sheet is contradictory.

### 2. Write the code
Follow `references/conventions.md`. In short:
- **Page objects** (`pages/<area>/<Screen>Page.ts`): one class per screen; locators as readonly fields, built
  from the sheet's role + accessible name exactly as written (asterisks included). Methods are user actions.
- **Flows** (`flows/<module>.ts`): one function per Robot keyword the sheet names (`// Robot: <keyword>`),
  built on page objects. Put the new-CRM message strings in one `…Messages` object there.
- **Data** (`data/<area>/…`): typed test data keyed by the Robot keys, when it's large or shared.
- **Specs** (`tests/<area>/…/<suite>.spec.ts`, the path the sheet's `Target spec:` line gives): one test per
  `### [ID]` section, in sheet order. The title is `[ID] <full Robot test name>`, tagged `@ID` plus the sheet's
  tags. Each assertion-table row becomes one `expect` with a `// A<n> L<line>` comment, so a reviewer can tick
  the table off line by line.
- **Same channel as Robot** in every phase (setup · action · assertions · teardown), exactly as the sheet's
  `Category` line and steps say: UI through page objects, API through `utils/api.ts` (`/api/v1`), DB through
  `utils/db.ts`. Don't swap a DB check for a UI one, or the other way round.
- **Statuses**:
  - `ready`: normal test.
  - `ready-bug`: write the Robot expectation as the sheet gives it, tag `@bug`, and add a `// @bug:` comment
    with the observed behaviour. Don't use `test.fail()` here: a `@bug` test is meant to show red until the
    product is fixed.
  - `not-available`: `test.fail(true, '<reason from the sheet>')`, tags `@missing-feature @bug`, then the steps
    as far as the missing feature.
- **Order and data**:
  - Serial is the default: the `chromium` project runs one test at a time in file order.
  - Only tests the sheet marks parallel-safe (they create no data) get `@parallel`.
  - Chained tests keep the sheet's fixed Robot names.
  - Tests that only touch their own records use `testData.name(base, maxLength)` + `testData.cleanup()`.
    Add any new table holding generated names to `SWEEP_TABLES` in `utils/testData.ts`.
  - Robot **Suite Setup / Teardown**: the logic and fixed names go in `data/<area>/suites/<suite>.ts`; thin
    runners in `setup/<area>/…/<suite>.suite-setup.ts` / `.suite-teardown.ts` call it. These run once per run,
    even if a test fails. Nothing but `*.spec.ts` goes into `tests/`. Page objects never hold setup or teardown:
    they model one screen, and setup usually runs on another channel (API/DB).
  - **Comments explain why, not what** (conventions §1): a spec header that summarises the decisions with
    their source (sheet Q#/date), `// Robot:` / `// A<n> L<line>` mapping, and a `// @bug:` reason.
  - A per-test `[Setup]`/`[Teardown]` goes in the test (or `testData.cleanup`).
  - Global settings a test changes (system config such as TaxSlabs) are saved and restored in the suite
    setup/teardown files, not in `beforeAll`/`afterAll` (see conventions §6).
  - A failing test restarts the worker, which re-runs the spec's `afterAll` and then `beforeAll` mid-suite. Spec-scoped seeds
    must therefore be **create-if-missing**, with no deleting `afterAll`; cleanup goes in the shared suite teardown
    (`docs/run-status.md` note 4).

### 3. Type-check, run, and compare with the sheet
```bash
cd ~/repos/ase-crm-testPlaywright
npm run -s typecheck
npx playwright test <spec files> --output=<scratchpad>/out --reporter=json > /tmp/claude-1000/pw-results.json 2>/dev/null
node .claude/skills/robot-spec-writer/scripts/check_results.mjs /tmp/claude-1000/pw-results.json <sheet files…>
```
(Use your scratchpad directory for the JSON and `--output` if the session gives you one: other sessions may run Playwright in this repo at the same time, and a shared `test-results/` gets wiped under you; see `docs/run-status.md` note 3.) Even when you run one folder,
Playwright runs **every** `setup/**/*.suite-setup.ts` / `*.suite-teardown.ts`, because dependency projects
always run in full. That's expected: those files are idempotent and only touch their own suite's records. `check_results.mjs` pairs each
sheet section with its test by ID and prints a table:
- `ready` must **pass**.
- `ready-bug` must **fail**, and the script shows the failing line and message.
- `not-available` must be an **expected failure**.
- `blocked` must be **skipped**.

It also flags sheet IDs without a test and tests without a sheet section. Exit code 0 means everything matches.

A matching status is not enough for `ready-bug` / `not-available`. Read each failure and confirm it fails **at
the step the sheet's "Behaviour differences" describes**. A `@bug` test that fails earlier, say on a typo in
a locator, proves nothing. Fix it until it fails for the right reason.

When something doesn't match:
- **Your code is wrong** (typo, wrong helper, missing wait, bad selector syntax): fix it and re-run.
- **The sheet's locator or label is slightly off** (an accessible name differs, a field is in another group):
  you may confirm it with **one targeted probe run** (plan format in
  `.claude/skills/robot-scenario-analyst/references/probe-plan.md`; name any record you create
  `zz_explore_*` and add its cleanupSql).
  - If the probe settles it, fix the code and record the correction in the sheet, under a `**Corrections
    (spec writer, <date>):**` line in that test's section.
  - Keep it small: names and labels, not flows.
- **Anything bigger means stop and report.** That covers: the flow differs, an expected toast or value is
  different, a whole step is missing, a `ready` test fails on a real product difference, or a `ready-bug` test
  passes. Don't change the assertion and don't re-classify the test yourself. Leave the test as the sheet
  defines it, list the mismatch for the user, and suggest re-running the analyst on that test.

Then confirm it's done: **one full run of the folder with every test matching its sheet** (user rule 2026-10-07: run once; re-run only after fixing a real mismatch).
- **Infrastructure flakes.** A failure caused by something outside the test and the product doesn't count
  against the code. Examples: `net::ERR_NETWORK_CHANGED` while a route chunk loads, Keycloak down
  (`docker start kc-atdd`), the app's "Something went wrong" page after a network error. Re-run, and list the
  flake in the report with its evidence (the trace or error).
- **A failure that repeats, or that the trace ties to timing** (a click on a stale row, a read before a save)
  is your bug. Fix it with a proper sync point, then start the two-run count again.
Check that nothing was left behind: run the sheet's teardown expectations through `dbq.mjs`, e.g. no `_pw`
rows and no fixed Robot names after the suite teardown.

### 4. Record and hand back
- `docs/run-status.md`: update the folder's row after **every** run of it (date UTC, expected/unexpected, matches sheet or not, wall-clock, status, what would trigger a re-run). Before running any *other* folder that is already `verified` there, check it: re-run only if its specs or the shared code it uses changed since (user rule 2026-10-07). If you change shared code another verified folder uses, note it in that folder's row as "re-verify pending".
- `docs/coverage.csv`: for each implemented test, set `spec` to the spec path and `status` to:
  - `ported` for `ready`,
  - `ported-bug` for `ready-bug`,
  - `ported-missing-feature` for `not-available`.

  Keep `assertions_covered` as the short list of checks, and add a note for any Correction. Leave `blocked`
  rows unchanged. Never delete a row. Then run `node scripts/coverage-summary.mjs` and include the folder's
  line in the report; it also flags duplicate rows and unknown statuses.
- `docs/terminology-map.md`: only if a Correction changed a fact recorded there.
- Final report to the user, short:
  - files created or changed,
  - the result table from `check_results.mjs` for both runs,
  - the wall-clock time,
  - corrections you made to the sheet,
  - mismatches you stopped on, with the evidence.

## What you don't do
- Explore the app beyond one targeted probe for a name fix. If more is needed, the analyst does it.
- Add, drop, merge or weaken an assertion, or change a test's status. Those are user decisions recorded in the sheet.
- Use `waitForTimeout`, CSS/XPath from the old Robot templates, or `force: true` clicks. Use web-first
  assertions on the sheet's role + name locators.
- Edit Robot files or the ase-crm source.

<!-- attachments:start - managed by Agent Manager, edits here are replaced -->
## Attachments

Files bundled with this skill (references, scripts, templates), relative to this file. Read or run the ones the task needs.

- [conventions.md](references/conventions.md)
- [check_results.mjs](scripts/check_results.mjs)
<!-- attachments:end -->
