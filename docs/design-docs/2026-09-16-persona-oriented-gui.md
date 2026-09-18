# Persona-oriented GUI: research and design direction

**Status:** research and design direction. Mostly proposal, with one part implemented: the `architect` and `designer` roles now exist in the role model, the navigation and the VIEW-AS switcher. Section 3 records what landed; section 3.4 records what is deliberately not wired yet and why.
**Date:** 2026-09-16, revised the same day after architecture and design review
**Question asked:** rewrite the GUI so each persona in an R&D team gets views suited to their role, with AI output and artifacts rendered in the form that persona needs (e.g. QA gets a real visualisation of the cases that were written).

---

## 1. The headline: this is not a rewrite, and the problem is not visual

Two findings from reading the current app change what the work is.

**First, persona awareness already exists — it is just wired to the wrong axis.** The app ships a four-role model (`shared/types/role.ts`) with a capability matrix, a VIEW-AS switcher (`app/app.vue`, labels `You / Dev / QA / Mgr`), a per-role navigation allowlist (`app/app.vue:110-147`), role-specific dashboard wording (`app/pages/index.vue:269` gives QA "Verification queue" instead of "Your runs"), a manager redirect to a dedicated board (`app/pages/index.vue:22`), and gate ownership per role in workflow templates. A rewrite would throw away a working foundation. The defect is that the axis is **gate authority** — who is permitted to click Approve — and the user's question is about **discipline** — which artifacts my job makes me responsible for reading. Those are different axes, and the app currently has only the first.

**Second, the richest persona signal in the system is already structured, and the UI ignores its structure.** `engineering/schemas/evidence-bundle.v0.1.schema.json` defines exactly the objects each discipline cares about: `oracle` (pre-fix run, verdict must be `FAIL`), `oracle_after` (post-fix, must be `PASS`), `regression` (`suite`, `passed`, `failed`), `trace` (Playwright `trace.zip`), `adversarial` (`mutation_score`, `two_node_rerun`, `pattern_search`), `security` (`verdict`, `high`, `medium`, `low`), `deployment` (`migration_changed`, `rollback`), and `blast_radius` (`docs | ui_parsing | schema | protocol | money | deployment`). The UI renders this as a **file list plus a syntax-highlighted viewer** (`app/components/RunArtifacts.vue`). The one exception proves the point: `RunArtifacts.vue:117` parses JUnit XML into totals and failure blocks, and it is the single most persona-shaped thing in the product.

So the work is: **keep the capability model and extend it where a discipline genuinely owns a decision, add a lens where it only reads differently, and render the evidence contract as typed objects instead of files.** The industry evidence agrees that this is the right framing — the most common dashboard failure is architectural rather than visual, where teams invest in polished components and then find that different roles need fundamentally different data on first load and the single view serves none of them well.

---

## 2. What each persona can be given today, and what is missing

The pipeline already produces far more than the UI shows. Inventory of what exists (from `server/utils/runArtifacts.ts`, `shared/types/run.ts`, the bundle schema, and `.agents/workflows/runbook-a.md`):

| Produced today | Where it lives | Rendered today? |
|---|---|---|
| `oracle-before.xml` / `oracle-after.xml` | run artifacts dir | as raw XML + JUnit totals |
| `regression.xml` | run artifacts dir | as raw XML + JUnit totals |
| `trace.zip` (Playwright) | run artifacts dir | download only |
| `intent.md`, `plan.md`, `spec.md`, `summary.md` | run artifacts dir | as markdown prose |
| `context-packet.json` | run artifacts dir | as JSON |
| per-step `input` / `output` | `steps/step-NN-*.json` + run record | as prose in the step list |
| per-step log, timestamped | `steps/step-NN-*.log` | live tail, 400 lines |
| `monitorVerdict` / `monitorNote` | `RunStep` | small badge |
| per-step + per-run cost | `server/utils/costReport.ts`, `/api/runs/:id/cost` | totals on the board |
| gate decisions with `waitedMs`, `verdict`, `by` | `WorkflowRun.decisions` | board counters |
| `product`, `branch`, `worktree` per step | `WorkflowRun`, `RunStep` | text |
| preflight checks with `level` | `WorkflowRun.preflight` | list |

Three structural gaps block persona views regardless of how the pixels are arranged.

**Gap A — the step result is prose.** The pipeline's best output is trapped in free-text markdown. In a real run this session, the client-change step produced a genuine before/after write-count table (0 writes pre-fix, 1 write post-fix, on two screens) — as *prose inside `RunStep.output`*. No UI can chart that without parsing English. **Persona views need a typed per-step result envelope, not more chart components.** This is the single highest-leverage change in this document.

**Gap B — `blast_radius` is never written.** `readClassification()` (`server/utils/workflowRunner.ts:1279`) reads `work_type`, `origin`, `blast_radius` from `meta.json`, but `initRunArtifacts()` seeds only `identity`, `watch`, `cost`, `workflow` (`server/utils/runArtifacts.ts:351`), and the agent that used to populate the classification keys was deleted with the sdlc estate. Verified on a live run: every gate reads *"This run has no blast radius recorded yet, so it stops for a person."* Any persona view keyed on risk tier inherits a dead field. Closing this needs either an engine-side derivation or an agent-definition change under `.agents/` (owner decision, out of scope here).

**Gap C — navigation is subtraction, not composition.** Roles get an allowlist carved out of one 17-item flat sidebar (`qa: ['/', '/runs']`). QA's entire product is two links into screens designed for operators. Personas need their own home surface, not a smaller menu.

---

## 3. The model: two new roles, then lenses for the rest

**Revised 2026-09-16 after architecture and design review.** The first draft of this section treated architect as a cosmetic lens and omitted designer entirely. That was wrong on both counts, and the reasoning that corrects it is worth keeping: a discipline that *owns a decision* must be a role, because ownership is enforced server-side; a discipline that merely *reads differently* is a lens. Architect and designer own decisions nobody else should make, so they are roles. `implemented` marks what is in the code as of this document.

### 3.1 Capability rows (`implemented`)

| role | answerGate | runEngine | startRun | configure | readAllRuns |
|---|---|---|---|---|---|
| developer | yes | no | yes | no | yes |
| qa | yes | no | no | no | yes |
| **architect** (new) | yes | no | **yes** | no | yes |
| **designer** (new) | yes | no | **no** | no | yes |
| manager | **no — see 3.3** | no | no | no | yes |
| operator | yes | yes | yes | yes | yes |

Architect takes the developer row and designer takes the QA row, and the duplication is correct rather than a smell: what separates a reviewer role from its peer is not which *acts* it may perform but which *gates carry its name*, which lives in `WorkflowStep.gateRole` and is enforced by `requireGateRole`. Architect holds `startRun` because architects begin spikes and contract-first work; designer does not, because a designer accepts what a run produced rather than owning a scope that generates runs — and that friction is deliberate.

Neither new role gets `configure`. It is the tempting grant, and it fails on inspection: `configure` covers workflows, watches, agents, settings **and `roles.json`**, so handing it to an architect is promotion to operator under another name. Two owners of the pipeline is none.

**No sixth capability.** A `decideArchitecture` / `acceptDesign` flag would duplicate gate ownership into the capability table, and the two copies must then be kept in step forever; when they drift, the result is a 403 that names the wrong owner. The only honest name for such a capability is `ownGates`, and it is already spelled `answerGate`.

### 3.2 The rule that stops role proliferation

**A role exists if and only if some workflow declares a gate that is that role's alone.** Equivalently: if removing the role would change no refusal anywhere, it is not a role — it is a navigation entry or a lens preset. Applied, this admits architect and designer (once their gates exist, §3.4), and rejects "tech lead", "SRE" and "product owner" — the last of which *is* the ship gate, so it is the manager role under a different label: rename, never add.

The second trigger is people, not roles: the moment one real person genuinely needs two roles (the architect who also implements, and so meets the developer's diff gate on their own run), stop adding rows and move to a two-axis identity (`{role, disciplines[]}`) instead of inventing `dev-architect`. That is a larger change — two-axis identity in session, view-as, refusals and a `roles.json` migration — and it should wait until multi-discipline people are the norm rather than the exception.

### 3.3 A contradiction this review surfaced, now resolved

The CSUP template declared its ship gate `gateRole: 'manager'` (`app/utils/workflowTemplates.ts:349`, "neither the author nor the verifier owns it"), while `role.ts` gives manager `answerGate: false`, and `continue.post.ts:10` checks the capability *before* gate ownership. **A manager therefore cannot answer the one gate the template says is theirs**; today only an operator can ship a CSUP run, and the 403 does not even name the manager as owner. `scripts/test-roles.mjs` asserts the `false` deliberately ("a manager reads; deciding is not theirs"), so the two files encoded opposite intentions.

**Resolved by fixing the template, not the matrix.** `answerGate: false` is the established and tested intent of the role model; the `gateRole: 'manager'` line was the newcomer, written into the template earlier the same day. The ship gate now names `operator`, which makes the refusal truthful and keeps the separation that actually matters — the author does not ship, and neither does the verifier. Widening `manager` instead would have handed a role the model defines as read-only both gate authority and the queue-clearing that rides on the same capability, which is not a change to make on inference.

**The invariant is now tested**, because both files read correctly in isolation and were wrong only in combination: `scripts/test-roles.mjs` walks every shipped template and asserts each declared `gateRole` is a role that holds `answerGate`. Confirmed non-vacuous by restoring the old value and watching it fail with that diagnosis. §3.4's designer gate has the same shape and must not repeat it.

### 3.4 What is NOT yet wired, and why

The roles exist but **own no gates yet**: adding `gateRole: 'architect'` to a migration-review step and `gateRole: 'designer'` to a client-change step would be the wiring that makes them real by the §3.2 rule. That is still to do; the run that made template edits risky has since completed, so the constraint is gone (and a value-only `gateRole` edit was never the risk \u2014 the resume guard compares step ids, then step count and `agentSlug` per index, never `gateRole`; adding a STEP is what strands a run).

**A defect found while answering "why was there no pull request", now fixed.** The runner performs a step's Jira work *instead of* calling its agent (`workflowRunner.ts`: `if (step.jira) { \u2026 return }`). That is right for a step that is only a transition, and silently wrong for the two shipped steps that carried both duties:

- `Intake & Classification` never ran `pm-planner`, so the classification it exists to record \u2014 work type, origin, blast radius \u2014 was never written. **This is the root cause of Gap B**: not a missing agent definition, a step whose agent was skipped.
- `Evidence, Docs & Pull Request` never ran `docs-curator`, so a run could complete with no evidence bundle, no docs and **no pull request**, its entire step output three sentences about Jira. Verified on run `d73159c0`.

`JiraStepConfig.after` now opts a step into running its agent first and the Jira work once it succeeds, which is also the only order that lets the outcome comment carry a pull request the agent just opened. Both shipped steps set it, and `test-workflow-runner.mjs` pins that a transition-only step calls no agent while an `after` step calls exactly its own and records both halves in order.

Whether `blast_radius` is now actually recorded depends on `pm-planner` writing those keys into `meta.json`; the step at least runs. That is the next thing to confirm on a real run.

One consequence to accept when wiring the designer gate: the runner only raises a gate when `oversightFor(run.blastRadius) !== 'auto'`, and `ui_parsing` is `auto` — so a designer gate on a pure UI change never pauses. That is the same position QA already occupies, and the system's philosophy is that gates fire on risk, not on discipline. Wanting designer sign-off on every UI change is a global change to `POLICY` in `shared/utils/oversight.ts`, which also pulls QA back onto those runs. A per-step "always stop" override to route around it would reintroduce the fire-on-everything gates that module exists to kill.

### 3.5 Lenses, for everything that is not a role

The remaining disciplines — pm, data, infra, docs, support, lead — stay **lenses**: content-only, defaulted from role, granting nothing.

1. **A lens never grants or removes authority.** It reorders and renders. `can()` remains the only gate check. A lens is a `view` concern; authority is a `server` concern.
2. **A lens never hides evidence from the person accountable for a decision.** Whoever answers a gate can reach the full evidence set in one click. Filtering is a default, never a wall — otherwise the lens becomes a way to approve work you were prevented from seeing.
3. **Lens is a user preference, defaulted from role**, and switchable without impersonation. The existing VIEW-AS switcher changes *authority* for testing; the lens picker changes *content*. These must not look alike, or an operator will believe a lens change granted them designer authority — or worse, believe they are themselves while impersonating. Concretely: VIEW-AS is an alarm (sidebar control plus a `--warning` bar across the top of `<main>` while impersonating, the only top bar in the app); a lens is a quiet neutral segmented control in the `PageHeader` right slot that never appears in the sidebar.
4. **No individual-performance surface.** Persona views measure the pipeline, not the person. The research literature is explicit that an individual-level dashboard should be absent by design, because such metrics measure the environment developers work in rather than the developers themselves, with managers accountable for that environment, and privacy treated as a first-order constraint. Our data (`decisions[].by`, per-step cost) would make a ranking screen trivial to build and corrosive to adopt. Aggregate by *run, step, gate and product* — never by person.

---

## 4. The data contract that makes persona views possible

### 4.1 Typed step results

Add a machine-readable result alongside the prose. Prose stays — it is what a human reads; the envelope is what a view renders.

```ts
// shared/types/stepResult.ts (proposed)
type StepResult =
  | { kind: 'plan';      decisions: string[]; risks: string[]; filesPlanned: string[] }
  | { kind: 'repro';     cases: TestCase[]; verdict: 'FAIL'; xunit: string }
  | { kind: 'fix';       commits: Commit[]; filesChanged: FileDelta[]; testsUnlocked?: string[] }
  | { kind: 'verify';    before: JunitRun; after: JunitRun; regression: JunitRun; trace?: string }
  | { kind: 'migration'; migrationChanged: boolean; rollback: string; liquibaseTag?: string }
  | { kind: 'docs';      pagesTouched: string[]; summaryMd: string }
  | { kind: 'ship';      pr: { url: string; number: number }; ci?: CiStatus }
  | { kind: 'research';  findings: Finding[]; citations: Citation[] }

interface TestCase { id: string; name: string; suite: string; status: 'pass'|'fail'|'skip'|'error'; ms?: number; message?: string; file?: string }
```

Sourcing, in order of preference: derive from artifacts the pipeline already writes (XML, git, PR API) rather than asking an agent to self-report; fall back to an agent-authored `result.json` validated against a schema; degrade to prose with a visible "unstructured" marker. **A view must render usefully when the envelope is absent** — every run before this change has no envelope.

### 4.2 Artifact kind registry

Replace extension-sniffing in `RunArtifacts.vue` with a registry mapping artifact identity to a renderer, so a persona view can *request* a renderer instead of hoping the file list contains something legible.

| Kind | Matches | Renderer |
|---|---|---|
| `junit` | `*.xml` with `<testsuite>` | case table + pass/fail matrix |
| `oracle-pair` | `oracle-before.xml` + `oracle-after.xml` | red→green proof panel |
| `trace` | `trace.zip` | embedded Playwright trace viewer |
| `diff` | `*.diff`, `*.patch`, git range | side-by-side diff |
| `screenshot` | image types | before/after image compare |
| `plan` | `plan.md`, `intent.md`, `spec.md` | outline with anchor nav |
| `context` | `context-packet.json` | keyed fact table |
| `bundle` | assembled evidence bundle | schema-driven evidence sheet |

**A registry cannot key on filenames alone, because the filenames are not a contract.** Verified on a live CSUP run: the bundle schema declares `trace: "trace.zip"`, and what the run actually wrote was `csup-7519-browser-trace-prefix.zip`, `csup-7519-browser-trace-postfix.zip`, two more for a second screen, four matching `.webm` videos and paired `csup-7519-browser-result-{pre,post}fix.json`. Every name was invented by the agent. So match on a manifest the run declares (§4.3) or on content sniffing, and treat a filename as a hint rather than an identity.

A related defect found and fixed while writing this: `.webm` was absent from `artifactContentType()`, so the artifact route fell through to its text branch and decoded the videos as UTF-8 — 405 KB of binary arriving as 732 KB of replacement characters. The only artifact that shows the defect *moving* was the one artifact nobody could open. `webm` and `mp4` now serve as video.

### 4.3 `visual/manifest.json` — what a designer gate requires

A designer's decision is "does this look right", which is unanswerable without a **before/after pair per affected route**. Nothing in the pipeline produces that today, so this artifact is the designer gate's precondition:

```
artifacts/visual/
  manifest.json
  before/<captureId>.png
  after/<captureId>.png
```

```ts
interface VisualManifest {
  version: 1
  base: { commit: string }   // from run.baseCommit - runner-owned, never agent-authored
  head: { commit: string }
  captures: {
    id: string               // stable: `${route}@${viewport}@${locale}`
    route: string            // as navigated, never inferred from a file path
    viewport: { w: number; h: number; name: 'mobile' | 'tablet' | 'desktop' }
    locale: string           // BCP47
    persona?: string         // the seeded account used to reach the screen
    theme?: 'light' | 'dark'
    before: string | null
    after: string | null
    reason?: 'route-absent-before' | 'route-absent-after' | 'capture-failed' | 'auth-required' | 'not-attempted'
    fullPage: boolean
  }[]
  routesConsidered: string[]
  skipped: { route: string; reason: string }[]
}
```

Rules that keep it honest, matching the provenance discipline already in `gitFacts.ts` and `costReport.ts`: the commits come from the run record rather than from an agent; the capture step runs the *same* script at base and at head so the pair is comparable by construction; and a missing side is recorded with a `reason` rather than omitted — "route did not exist before this change" is a feature signal, not an error. Add `visual` to the bundle schema as a nullable object beside `trace`.

---

## 5. Persona view specifications

Each persona gets one home surface answering: *what needs me*, *what must I judge*, *why*. Layout follows the attention research — three to five KPIs in the top row at most, since when the same element repeats across a row attention is strongest at the first item and falls away, to the point that with five KPI cards most users barely register the last two.

### 5.1 QA / verification (the worked example)

QA today gets `['/', '/runs']` and a JUnit totals line. What the data can already support:

- **Case-level table, not totals.** Parse `oracle-*.xml` and `regression.xml` into `TestCase[]`: suite, case name, status, duration, failure message, source file. Sortable, filterable, searchable. This is the "nice visualisation on cases written" that was asked for, and the XML to build it already lands in the run directory.
- **The red→green proof panel.** The bundle's core claim is that `oracle` failed before the fix and `oracle_after` passed after it. Render it as one paired strip — same case list, two columns, pre and post — so a reviewer sees *this exact case went FAIL → PASS* rather than two unrelated XML files. Flag any case that is green in both (proved nothing) or red in both (fix did not work). The schema also carries `runs` (minimum 3, up to 200 for races) and a `FLAKY` verdict: show the run count and surface flakiness rather than averaging it away.
- **Coverage against intent.** Map cases to the acceptance criteria in `intent.md` / `plan.md`; show criteria with no case as an explicit hole. This is the traceability QA is usually asked for and currently has to assemble by hand.
- **Trace and screenshots inline.** `trace.zip` embedded, screenshots in a before/after compare — not a download link.
- **Adversarial and security strip.** `adversarial.mutation_score`, `two_node_rerun`, `pattern_search`, and `security.{verdict,high,medium,low}` as a small verdict row, since these are exactly the "was this checked properly" signals a verifier is accountable for.
- **The gate, in context.** The approve/reject control sits *inside* the evidence, with the run's own question text, not on a separate screen.

### 5.2 Developer

Diff-first. Commits on the run branch with lane merge provenance (`RunStep.worktree` already records which lane produced which commit), `filesChanged` deltas, the failing test that started it, CI status, PR link, and the monitor's `RETRY`/`ABORT` notes that concern their step. Their gate is the diff gate; put the diff under it.

### 5.3 Engineering lead / manager

`/board` is already this persona's screen and is close to right: gates waiting with age, human-wait vs agent time, decisions, reworks, at-cap runs, outcome mix, cost. Additions: gate latency by role (where does work actually queue?), rework causes, cost per outcome, and product/suite breakdown. Explicitly aggregate by run and gate, never by person (§3.4).

### 5.4 Product / BA

Ticket → `intent.md` → `plan.md` → outcome → PR, with no code and no logs. Prior-art and customer-impact findings (the research lane already produces these, with citations) belong here as a narrative, plus what the run decided *not* to do.

### 5.5 Architect (now a role; nav wired)

The architect's question is not "what needs me" but **"what did the pipeline change about the shape of the system, and is any of it silently structural?"** Read-only by construction, like the board.

- **Structural-change queue as the hero**, not a KPI row: runs classified `schema | protocol | deployment`, or with `deployment.migration_changed`, or touching more than one repo (`product.multiRepo`, `alsoInScope`). Most dangerous first, with repo and module counts on the row and the rail coloured by blast tier.
- **A spread strip of four numbers**: multi-repo runs, runs that widened scope, migrations changed, and **unclassified runs**. That last one is the honesty counter — while Gap B is open it reads "all of them", which is exactly what an architect should see.
- **Module heat table**: rows of `repo/module` from `product.repos`/`modules` and `fix.repos[]`, columns the last N runs as outcome-coloured dots, sorted by touch count. A module hit six times in two weeks is the cross-run pattern that matters, and a sorted table surfaces it faster than any chart.
- **Migration and rollback fact table** for a selected run: `deployment.migration_changed`, `deployment.rollback`, `stack.liquibase_tag`, and preflight checks at `warn` or `error`.
- **Link to `/graph`, do not embed it.** That graph describes the *pipeline's* topology — agents, skills, commands — not the product's.

**Refuse to build a product dependency graph.** The bundle records which repos were *touched*, never which repo *depends on* which, and drawing edges we do not have is fabrication — the exact failure the runner's git-facts and cost modules exist to prevent. Also refuse a blast-radius donut (six categories, most empty) and any "architecture health" composite.

### 5.6 Data / DBA and Infra

`deployment.migration_changed`, `rollback`, `stack.{profile,topology,liquibase_tag}`, plus preflight checks at `warn`/`error`. Small, high-signal, and currently buried in JSON.

### 5.7 Technical writer and Support

Writer: runs whose blast radius is `docs`, `summary_md`, doc pages touched. Support: customer-facing symptom, the ticket thread, prior art, and the fix's user-visible behaviour change — the CSUP flow already generates all of it.

### 5.8 Designer (now a role; nav wired, evidence not yet produced)

The hardest persona, and the most honest one to under-build, because the pipeline's design-relevant output is thin. What a designer view can show **today**, all derivable from git without agent cooperation:

- **Frontend file delta**, from the run's commits filtered to `*.vue|*.tsx|*.css|*.scss|*.html|i18n/**|locales/**`, grouped by directory, diff one click away.
- **i18n string delta** as a `key · before · after` table, flagging added and removed keys plus any string whose length moves more than about 40% — the truncation risk a designer actually cares about.
- **Whatever images exist**, captioned with the filename and nothing more, because the filename is all we know about them.
- **Trace present or absent** as a chip with a download. Not an embedded Playwright viewer in phase one: that is a multi-megabyte bundle and a build dependency, and a download plus one line on how to open it is honest until traces are genuinely reviewed.

What it must **not** pretend: no "visual regression detected" (there is no baseline and no diffing), no accessibility score (the a11y snapshot lives in an agent session, not in the bundle), no route list inferred from file paths (`pages/foo.vue` → `/foo` breaks on dynamic routes and layouts, so say "files under `pages/`" instead), and no design-token diff unless the product declares a token file.

**The gate itself**, once §4.3 exists: a capture list on the left with state glyphs (pair complete, one side missing, not attempted) each carrying its `reason`, and a compare stage offering **side-by-side as the default**, because it is the only mode where an 8px layout shift is visible without interaction; **toggle** bound to a key, because flicker is the fastest way an eye catches a small change; **slider** included because designers expect it but never defaulted to; and **pixel diff only when the capture step computed it server-side**, never from two PNGs in the browser, where the ratio would be a number nobody can reproduce. Route, viewport, locale, theme, persona, base→head SHAs and capture time sit under the image always, rendering an em dash when absent rather than blank.

Three distinct "no screenshot" states, three renderings: a capture with a `reason` shows the side that exists beside an empty frame labelled with that reason; a manifest with zero captures names how many routes were considered and why each was skipped, and still allows a decision on the file and i18n evidence; and **no manifest at all means the gate should not have fired for a designer** — say so, and offer a send-back to the capture step. Never render a placeholder image or a "screenshot unavailable" graphic.

The Approve control may count `3 of 5 viewed` but must not *block* on it. Forced scroll-through is rubber-stamp theatre; the written reason is the real defence, and the run already enforces one where a gate demands justification.

---

## 6. Migration: strangle the shell, do not rewrite it

A big-bang rewrite of 35 routes and 52 components would stall, and most of those routes (agents, skills, commands, plugins, MCP, CLI) are operator tooling that no persona work needs to touch.

- **Phase 0 — unblock the data.** Close Gap B so risk tier is real; add the `StepResult` envelope and the artifact-kind registry behind a feature flag. No visual change. Nothing downstream is honest before this.
- **Phase 1 — evidence renderers.** Build the case table, the red→green pair panel, and the trace viewer as components used *inside today's run page*. Immediate value to QA with no IA change, and it validates the envelope against real runs.
- **Phase 2 — persona home surfaces.** One route per persona composing those components, defaulted from role at login. Keep the existing pages reachable; measure which persona actually lands where.
- **Phase 3 — lens picker and nav composition.** Replace the route allowlist with per-lens nav composition; keep VIEW-AS visually distinct from the lens.
- **Phase 4 — retire the generic surfaces** that no persona chose, once telemetry shows the replacement is used.

**Sequencing rule:** every phase ships with the unstructured fallback intact, because historical runs have no envelope and a persona view that shows nothing for last month's runs will be judged broken.

---

## 7. Risks and the strongest argument against

**Against:** the current UI's problem may be depth, not persona fit. One excellent run page — case tables, real diffs, embedded traces — might serve all nine personas, because an R&D team of this size shares context constantly and a QA lead frequently *wants* the diff. Nine surfaces is nine things to maintain, and a lens that hides the diff from QA makes them worse at their job, not better. **This is a real risk, and it is why Phase 1 deliberately delivers the renderers before any persona routing**: if the deeper run page alone satisfies people, stop there and keep the four roles. Persona routing earns its place only if Phase 1 leaves people still hunting.

Other risks: lens/authority confusion in the UI; persona drift into a permission system by accretion; parsing that depends on agent prose wording (mitigated by deriving from artifacts, not text); and the surveillance failure mode in §3.4.

---

## 8. Sources

Codebase: `shared/types/role.ts`, `shared/types/run.ts`, `app/app.vue`, `app/pages/index.vue`, `app/pages/board.vue`, `app/components/RunArtifacts.vue`, `server/utils/runArtifacts.ts`, `server/utils/workflowRunner.ts`, `server/utils/costReport.ts`, `engineering/schemas/evidence-bundle.v0.1.schema.json`, `engineering/scripts/assemble-bundle.mjs`, `.agents/workflows/runbook-a.md`.

External: Fuselab Creative on dashboard architecture failure (<https://fuselabcreative.com/intelligent-interface/>); Aufait UX on role-aware information architecture and attention patterns (<https://www.aufaitux.com/blog/dashboard-design-examples-inspiration-best-practices/>); Shift-Left API on persona dashboards (<https://totalshiftleft.ai/features/analytics-monitoring/persona-dashboards>); EngThrive on deliberately omitting individual dashboards (<https://arxiv.org/pdf/2605.04259>); Harness on persona-based metrics (<https://www.harness.io/blog/persona-based-metrics-revolutionize-software-engineering-team-performance>).
