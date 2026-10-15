---
name: ui-api-optimizer
description: Split the browser-driven tests of one ase-crm Playwright test folder into API/DB setup and data checks plus a minimal UI test, without losing any assertion; leave a test as it is when it cannot be split. Use for the optimization branch, in the ui-to-api-optimization workflow or by hand.
---

# UI → API + minimal UI, one test folder at a time

The rules are in `docs/optimization/README.md`: read it first, all of it. This skill is the method. It has two
halves: **Analyse** (read the code only, no stack) and **Convert** (rewrite, run, prove). In the workflow each
half is its own step. By hand, do both in order.

## Analyse (no stack, no Playwright run, no clock)
Cost is the lesson here. The migration's explore step was its most expensive (54 minutes, 615k context), so:
- Read in batches: one Bash call with `sed -n`, `grep -n` and `cat` over several files. Don't open files one at a time.
- Read each spec once.
- Read a page object or flow only for the methods the in-scope tests call.
- Don't read the Robot suite. The spec's `// A<n> L<line>` markers and header already carry its intent.

1. `node scripts/ui-remaining.mjs tests/<folder> --json`: the specs to do, limited to `include` when it is set.
   For each, `node scripts/assertion-ledger.mjs --base HEAD <spec>` writes a ledger listing every in-scope test
   and assertion with its line and a first UI/data guess. Start from that table rather than reading for it.
2. For each in-scope test, list:
   - **setup steps**, each with its channel today (form, API, DB) and the helper that would do it: an existing
     function, `utils/opt/<folder-slug>.ts` (new, name the endpoint you found), or `none`. To find an endpoint, run
     one batched grep over `crmSourceDir` (the controllers' `@RequestMapping` / `@PostMapping` paths) and over
     `docs/porting/sessions/crm-module-status-reference.md` and `docs/reference/crm-module-status-digest.md`;
   - **each assertion**: its line, its marker, a class (UI, DATA or SYNC, from README §2) and its target (`ui`,
     `api`, `both` or `drop`), with a one-line reason for every DATA, SYNC and `both`;
   - **chain facts**: fixed Robot names the test reads, which test created them, and whether an API seed per test
     can replace the chain;
   - **clock**: does any step move or depend on the server date (`stack.sh clock`, `serverClock`, `test.slow` with
     dates)?
   - **decision**: `convert`, or `skip:<reason>` using README §3's reason words.
3. **Business rules worth an API test:** for each toast-asserted rule, note the endpoint and the expected
   status or error code, if the backend source shows it.
4. Write `plan.md`: a table per spec (test, decision, setup → helper, assertion counts by class and target, new
   API tests), plus the list of helpers to add, each with its endpoint and source file. Also write `analysis.json`:
   `{ specs: [{ spec, tests: [{ key, decision, reason, setup: [...], asserts: [{ line, marker, cls, target, why }], newApiTests: [...] }] }], helpers: [...] }`.
5. Expected gain: per spec, UI steps before and after, and a rough runtime gain (the form setups removed).

## Convert (stack `crmStack`, every app/DB command under `flock "$CRM_LOCK"`)
1. **Baseline, once.** Run the in-scope tests marked `convert` as they are, one spec per command (`--grep` of
   their TC ids), with the JSON reporter. A red test becomes `skip:red-before`; don't try to fix it.
2. **Helpers first.** Write the planned helpers in `utils/opt/<folder-slug>.ts` (folder path, `/` as `~`). Prove each one with a single
   throwaway call (create, then read back by id and delete). Never delete rows you did not create.
3. **Rewrite**, spec by spec, as README §4 says:
   - setup through helpers;
   - UI assertions unchanged, in the UI test;
   - DATA assertions in `<name>.api.spec.ts`, each with `// orig:<line>` and its `// A<n> L<line>`;
   - SYNC drops in `drops.csv`;
   - new business-rule API tests;
   - the `// Optimization` header paragraph.

   Keep every out-of-scope test byte for byte, including the ones between in-scope tests.
4. `npm run typecheck`.
5. **Run what changed**, one spec file (UI, then API) per command. Fix, then re-run only the failures
   (`--last-failed` or `--grep`). After 3 rounds, a test still red goes back to its original text and becomes
   `skip:red-after`.
6. **Prove**: `node scripts/assertion-ledger.mjs --base <run base> <the specs>` exits 0. If it reports a lost
   assertion, put it back. Never record a lost assertion as a drop unless it is truly SYNC.
7. **Final run**: every changed spec once, file by file, all green.
8. **Bookkeeping** (README §6): `status.csv`, `skipped.csv`, `drops.csv` and the ledger files for this folder.
   Commit specific paths:
   ```
   opt(<folder>): <n> UI tests slimmed, <m> API tests added, <k> left as is
   ```

## Never
- Weaken an assertion, turn a value check into an existence check, or drop a negative case.
- Move a UI assertion out of the UI test.
- Touch a test that does not drive the browser.
- Move the clock, reset the environment, or delete or update data this run did not create.
- Change anything outside `tests/<folder>/` and `utils/opt/<folder-slug>.ts` (README §7): not the rest of `utils/`, `pages/`, `flows/`, `components/`, `fixtures/`, `data/`, `setup/`, `docs/`, or another test folder.
- Add helpers to `utils/api.ts`.
