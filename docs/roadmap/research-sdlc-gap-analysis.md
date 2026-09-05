# Agent-Manager as an Agentic SDLC System — Gap Analysis

Grounded entirely in the current repo state (2026-09-05), not just the design
docs — several docs describe work as "not yet built" that has since shipped
(git log shows restart/resume, the Runs page, and the watcher are all merged,
ahead of the restart-clone spec's own "being built now" framing).

## 1. The developer's day-to-day loop

**One-page model.** Four personas, one underlying loop: *ticket appears →
someone decides it's this pipeline's job → pipeline runs unattended or
step-by-step → a human reviews an evidence bundle → a PR merges.* What differs
per persona is where they get blocked today.

- **Backend dev fixing a bug (CSUP-style ticket).** Pastes ticket text into a
  Run modal (`app/pages/workflows/[slug].vue`), picks a `projectDir`, hits Run.
  If the product has a known stack recipe (only `selfcarenow` does — hardcoded
  prose in `sdlc-stack-provisioner`'s body, `app/utils/templates.ts:317-321`),
  steps 1-4 run unattended. Step 5/6 (verify + trace) run in parallel. Step 7
  opens a PR under the dev's own `gh` identity. The dev's real job today is
  babysitting: watching for `PIPELINE-HALT`, a monitor `RETRY`/`ABORT`
  (`sdlc-step-monitor`, only wired on steps 2 and 5 — `workflowTemplates.ts:132,137`),
  or a `maxTurns` exhaustion with no auto-retry.
- **Dev doing a hotfix under time pressure.** Same pipeline, no fast path.
  Nothing in the registry (`engineering/registry/products.yaml`) is ever read
  by a step — `branches.bug` per product (e.g. `release/{version}` for `aaa`)
  is defined and validated but the PR step's only branching rule is a
  hardcoded `fix/<TICKET-KEY>` off "the repo's normal target branch"
  (`app/utils/templates.ts:737-739`). A hotfix against a release branch and a
  feature ticket against `develop` are indistinguishable to the pipeline.
- **Dev implementing a feature ticket.** The whole pipeline is bug-shaped:
  intake's `work_type` enum includes `feature`, but every downstream prompt
  ("failing test", "the fix", "regression") assumes a bug-and-repro shape.
  Test-author's job ("prove it currently fails") has no feature-ticket
  analogue — a feature has no pre-existing failing behavior to reproduce.
- **Tech lead reviewing evidence.** Reads a markdown PR body (no structured
  bundle UI — that's explicitly out of scope per the runbook design doc) built
  from `meta.json` + xunit files via `engineering/scripts/assemble-bundle.mjs`.
  Cost, model, and attempt count are captured (`shared/types/run.ts` `RunStep.model`,
  `usage`) but **never surfaced anywhere in the UI** — `app/pages/runs.vue` and
  `WorkflowRunPanel.vue` show status/timing/steps, not tokens or dollars. The
  lead's only lens into run economics is opening the raw artifact JSON.

The loop's structural bottleneck for all four personas: **routing and
environment decisions live in agent prose, not in data the app can act on.**
The registry exists, is schema-validated, and is completely unconsulted at
runtime.

## 2. Capability inventory (by lifecycle stage)

**Intake.** *Exists*: `sdlc-ticket-intake` (`app/utils/templates.ts:236-306`)
turns pasted ticket text into `intent.md` + `context-packet.json` +
`work_type`/`class`/`blast_radius` enums in `meta.json`. *Missing*: no live
Jira fetch — explicitly deferred in the runbook design doc's scope section;
input is "paste the ticket text/URL," identical to every other workflow.

**Classification and routing.** *Exists*: `engineering/registry/products.yaml`
defines `match.components`/`match.projects` → product → `repos`, `branches`,
`stack.compose`, `tests`, `owners`, validated by
`engineering/scripts/validate-registry.mjs`. *Missing entirely*: nothing reads
this file at runtime. `grep -rn "products.yaml\|loadRegistry"` across
`server/` and `app/utils/templates.ts` returns zero hits outside the
registry's own validator scripts. `meta.json.product` is whatever
`sdlc-ticket-intake` free-texts from the ticket, not a registry-resolved
match.

**Environment.** *Exists*: `sdlc-stack-provisioner`
(`app/utils/templates.ts:308-389`) knows `alepo-dev-team-infra` conventions in
prose (profiles, `alepo-shared` network, `TAG` var, container-internal
addressing) and one fully-worked recipe (`selfcarenow`). It also has real
secret discipline: "never copy a developer's `.env`... generate every secret
the compose marks required with `openssl`... pass secrets as shell
environment... never in files." *Partial*: every other product either has no
compose entry in the deployment repo or a stack section in the registry that
is never consulted, so provisioning falls back to "does the product own
checkout have a compose file" — a per-run discovery task, not a lookup.
*Missing*: no per-product secret catalog (which env vars are required, where
they come from) — the agent must discover this from the compose file live,
every run.

**Branching.** *Exists*: PR step branch convention `fix/<TICKET-KEY>`, never
targets `main`/`develop`/`ci-release` directly (`app/utils/templates.ts:735-739`).
*Missing*: registry's per-product `branches.bug`/`branches.feature`/`forward_port`
fields (e.g. `aaa`'s `release/{version}` for bugs) are dead data — no hotfix
vs. feature vs. infra branch policy is applied. Every ticket, regardless of
`work_type`, produces the same `fix/*` branch against "the normal target
branch."

**Plan/approval.** *Exists and enforced*: `engineering/hooks/plan-gate.mjs`, a
real `PreToolUse` hook (not prose) denying `Edit`/`Write` until
`.agent/plan.md` exists with five required headings
(`engineering/README.md`'s table shows it "implemented and registered").
`sdlc-test-author`'s body explicitly names this gate and writes the plan
first. This is one of the most mature pieces in the system — a genuine
control, not an instruction.

**Test-first.** *Exists and enforced*: `engineering/hooks/test-lock.mjs`
matches `Edit|Write|Bash`, specifically closing the `sed -i`/`cp`/`git checkout --`
bypass a naive `Edit`-only lock leaves open. `sdlc-fix-implementer`'s prompt
independently instructs the same thing — belt and suspenders. Test-author
requires 3 runs of the oracle, JUnit xunit format, `tests` count sanity-checked
against expected rows ("Zero is not a pass").

**Implement.** *Exists*: `sdlc-fix-implementer`, minimal-diff discipline,
explicit "no refactor/rename/tidy while in there," root-cause method via the
`systematic-debugging` skill reference. *Partial*: `frontmatter.skills` —
confirmed in the runbook design doc's post-implementation status as
**inert**: `resolveSkill.ts` has zero importers, so `systematic-debugging`,
`using-git-worktrees`, `agent-browser` etc. named on every `sdlc-*` agent
never reach the model. This is a documented, known gap, not a rumor.

**Verify.** *Exists and unusually mature*: `sdlc-verifier` requires exit
codes, verbatim output, distinguishes pre-existing failures from new ones,
does adversarial verification (mutation-adjacent: "disable the fix, confirm
the test goes red") gated on `blast_radius` in {`money`,`protocol`}, and
explicitly bans fabricated adversarial reports ("PIPELINE-HALT" over a fake
number). `sdlc-step-monitor` reviews step 2 and step 5 output for "prose
claiming success with no command behind it" and can vote `RETRY`/`ABORT`.

**Review.** *Partial*: monitor coverage is only 2 of 7 steps (stack
provisioning, verification) — steps 1, 3, 4, 6, 7 have no independent
reviewer. No human-in-the-loop review gate inside the run itself (by product
decision — PR review *is* the gate); no adversarial/security review pass
distinct from the verifier's own self-check.

**Evidence.** *Exists*: `engineering/schemas/evidence-bundle.v0.1.schema.json`
+ `assemble-bundle.mjs`, strict rejection of placeholder values
(`plugin_version: "unknown"` fails; a required-non-null `pr` URL cannot be a
placeholder at assembly time), verdicts derived from actual xunit files rather
than agent self-report. *Partial*: no structured bundle *viewer* in the UI —
the bundle is the markdown PR body, an explicit v1 scope cut.

**PR/CI.** *Exists*: `gh pr create --body-file`, never targets protected
branches, fails cleanly (branch pushed, PR not opened) if `gh` isn't
authenticated. *Missing*: PR pushes under the developer's own `gh` identity —
no service/bot account, no distinct commit author for agent-authored commits.
No CI feedback loop of any kind — nothing polls PR checks, re-runs on a CI
failure, or reports CI status back into the run or bundle.

**Deploy/rollback.** *Missing entirely*. Nothing in the pipeline, registry, or
scripts addresses deployment after merge or rollback of a bad fix. The
registry's `stack.liquibase` flag hints at schema-migration awareness but
nothing consumes it for rollback planning.

**Feedback to Jira/Slack.** *Missing entirely*. `grep -rn "slack\|Slack"`
across `server/` and `app/` (excluding node_modules) returns zero hits. Jira
write-back (comments, transitions) is explicitly out of scope in the watcher
design doc: "The artifact's triage identity is comment-only; that arrives
with the Jira source" — i.e., not yet.

**Run operations.** *Exists, further along than the docs suggest*: server-side
run persistence (`server/utils/workflowRunStore.ts`), SSE live updates
(`server/api/runs/[id]/stream.get.ts`), restart-from-any-settled-step and
rehydrate-on-interrupt (`server/utils/workflowRunner.ts:637-764`, functions
`rehydrate`/`restartRun`), a Runs page (`app/pages/runs.vue`) with
Open/Restart/Clone/Stop, and a ticket watcher/scheduler with per-ticket
failure isolation and 3-strikes escalation (`server/utils/watchScheduler.ts`,
`app/pages/watches.vue`). *Partial*: budget is only `maxTurns` per agent
(`AgentFrontmatter.maxTurns`) — no wall-clock timeout, no dollar-cost cap, no
cross-run daily spend cap (the watcher has a `dailyDispatchCap` on *ticket
count*, not spend). *Missing*: no cost/token display anywhere in the run UI
despite the data being captured per-step (`RunStep.usage`) and reconciled at
finalization (`finalizeRunArtifacts`) — it exists in the JSON file and
nowhere else.

## 3. Missing/partial capabilities — user stories, smallest fix, dependencies, effort

**Registry-driven routing (classification and routing).**
Story: "As a dev, when I paste a ticket naming a component, the pipeline picks
the right repo/branch/stack/test-command from the registry instead of the
ticket-intake agent guessing from prose."
Smallest fix: a `server/utils/registry.ts` that loads and validates
`products.yaml` once at startup (mirrors `readImportsRegistry` pattern
already used for GitHub imports), plus a `match(ticket)` function
(component/project string → product entry). `sdlc-ticket-intake`'s prompt is
extended to call this via a tool the agent can invoke, or — smaller still —
the server resolves the product *before* the agent runs and injects the
matched entry into step 1's input alongside the ticket text, so the agent
never has to reason about matching at all.
Depends on: nothing new — the registry and its schema already exist.
Effort: **S** (data file + one lookup function + one prompt/input change).

**Registry-driven branch policy.**
Story: "As a dev doing a hotfix, the pipeline opens the PR against the
product's actual hotfix branch, not a generic default."
Smallest fix: once product is resolved (above), pass `branches[work_type]`
into step 7's input; `sdlc-evidence-and-pr`'s prompt reads it instead of "the
repo's normal target branch."
Depends on: registry-driven routing.
Effort: **S**.

**Wire `frontmatter.skills` into the actual model call.**
Story: "As a dev, the skill references already written on every `sdlc-*`
agent (`systematic-debugging`, `using-git-worktrees`, `agent-browser`)
actually change what the agent does, instead of being inert metadata."
Smallest fix: this is a known, named bug — `resolveSkill.ts` exists with zero
importers. The fix is wiring it into the request path in `server/api/chat.post.ts`
(or wherever `chat.post.ts`'s successor now lives for workflow steps) so a
resolved skill's content is appended to the system prompt.
Depends on: nothing external; it's a dangling piece of already-written code.
Effort: **S-M** (the resolver exists; the gap is one call site plus tests
that a skill's content actually appears in what's sent to the SDK).

**Stack recipes for products beyond `selfcarenow`.**
Story: "As a dev fixing a PCRF/FFM/PMS/VMS ticket, the stack comes up without
me hand-writing a recipe in the prompt first."
Smallest fix: not more prose in `sdlc-stack-provisioner`'s body — that doesn't
scale past one product per paragraph. Instead, a `recipes/<product>.md` file
per product (image tag quirks, healthcheck overrides, seed data) that the
provisioner reads via the registry-resolved product name, same shape as the
skill-file convention this app already has everywhere else. The prompt keeps
only the estate-wide conventions; product specifics move to data.
Depends on: registry-driven routing (to know which recipe file to read); a
repo champion actually writing each recipe (a per-product effort, not a code
effort).
Effort: **M** (the mechanism is small; populating recipes for 4+ more
products is the real cost, and is not a coding task this app can do alone).

**Monitor coverage on the unwatched steps.**
Story: "As a tech lead, I don't find out three steps in that intake
mis-classified the ticket, because a monitor caught it at step 1, not at
step 7's PR review."
Smallest fix: add `monitorSlug: 'sdlc-step-monitor'` to steps 1, 3, 4, 6, 7 in
`workflowTemplates.ts` — the monitor agent and the wiring mechanism already
exist and are proven on steps 2 and 5. This is a one-line-per-step config
change, not new capability.
Depends on: nothing.
Effort: **S**.

**Feature-ticket-shaped pipeline path.**
Story: "As a dev implementing a feature ticket, the pipeline doesn't force my
work through a 'prove it currently fails' step that doesn't apply."
Smallest fix: branch the template on `work_type` after intake — a feature
path skips the FAIL-capture framing in test-author's prompt (write the test
first, expect it to fail because the feature doesn't exist yet, which is
actually the same TDD shape — the prompt just needs "prove it currently
fails because the feature is unimplemented" as an explicit branch rather than
assuming "unfixed code has a bug"). This is mostly a prompt-branching change,
not a graph change.
Depends on: `work_type` already captured at intake.
Effort: **M** (prompt rewrite across test-author, fix-implementer, evidence
steps to handle both branches without regressing the bug path).

**Bot/service identity for PR pushes.**
Story: "As a dev, PRs the pipeline opens are attributed to the pipeline, not
to my personal GitHub account, so review load and blame are correctly
separated."
Smallest fix: a dedicated machine account's `gh` token, injected as
`GH_TOKEN` env var scoped to the workflow-run process rather than relying on
ambient `gh auth status` on the host. `sdlc-evidence-and-pr`'s prompt already
isolates all push/PR logic to one step, so this is a config/secrets change,
not a prompt change.
Depends on: an actual bot account being provisioned (org decision, not code).
Effort: **S** (code) but blocked on an organizational decision about the bot
account and its permissions — flag this dependency explicitly to the user.

**Cost/budget visibility and caps.**
Story: "As a tech lead, I can see what a run cost before and after it runs,
and a runaway run gets stopped before it burns an unbounded budget."
Smallest fix: surface `RunStep.usage`/`model` already captured per step as a
column in `app/pages/runs.vue` and a running total in `WorkflowRunPanel.vue`
— pure UI, the data already exists. A hard cap needs a second piece: a
wall-clock or token ceiling checked in `driveToSettlement`'s wave loop that
calls `stopRun` if exceeded, since `maxTurns` alone doesn't bound wall-clock
time or spend.
Depends on: nothing for display; the cap needs a small addition to
`workflowRunner.ts`'s loop.
Effort: **S** (display) + **S** (cap) — two small, separable changes.

**CI feedback loop.**
Story: "As a dev, if CI fails on the PR the pipeline opened, I find out
without polling GitHub myself."
Smallest fix: a lightweight poller (same shape as `watchScheduler.ts`, which
already solves "poll something on an interval without wedging on failure")
that checks the PR's check-run status via `gh pr checks` and posts a comment
or flips run status to `needs_attention` on failure. Does not need to
auto-fix — visibility first.
Depends on: server-side run persistence (exists) to attach the poll result
to something.
Effort: **M**.

**Slack/Jira status updates during a run.**
Story: "As a dev, I get pinged when a run halts or completes instead of
polling the Runs page."
Smallest fix: a webhook call from `publish()` in `workflowRunner.ts` on
terminal-status transitions — Slack incoming webhook is the smallest version
(no OAuth, no MCP dependency); Jira comment write-back needs the Atlassian
integration this app doesn't have server-side yet (the watcher design doc
notes the Atlassian MCP is bound to interactive sessions, not this server
process).
Depends on: Slack — a webhook URL, nothing else. Jira — genuinely blocked on
a server-side Jira client, which is a real dependency, not busywork.
Effort: **S** (Slack) / **L** (Jira write-back, because it needs its own
credentialed client this app has never had).

**Live Jira ticket fetch (replacing paste-the-ticket-text).**
Story: "As a dev, I paste a ticket key, not the ticket body."
Smallest fix: implement the `TicketSource` interface (already defined,
already has a working stub in `ticketSource.ts`) with a real Jira-backed
version for the watcher, and a thin `GET`-by-key path for the manual
Run-modal case.
Depends on: same server-side Jira credential gap as above.
Effort: **L** (the interface is ready; the credentialed client and its error
handling are the real work).

## 4. Prioritised roadmap

**Tier 1 — unblocks daily use now** (removes: hand-written recipes,
turn-budget stalls, silent skill no-ops, blind hotfix branching)

1. Wire `frontmatter.skills` into the model call — the skills are already
   written into every prompt; they're being silently discarded today.
2. Registry-driven product/branch resolution before step 1 runs — kills
   "only selfcarenow works" and "no hotfix vs. feature branching."
3. Add `monitorSlug` to the five unwatched steps — near-zero cost, closes a
   real trust gap the design doc itself flagged as unaddressed.
4. Surface cost/tokens/model in the Runs page and run panel — the data
   exists; not showing it is pure UI debt, and it's the first thing a tech
   lead asks about a run.
5. A wall-clock/token cap on `driveToSettlement`'s loop — `maxTurns` alone
   doesn't stop a slow-motion runaway.
6. First recipe file for one more product (dev's choice of next-most-common
   ticket source) using the registry mechanism from #2, proving the pattern
   generalizes past `selfcarenow`.

**Tier 2 — makes it trustworthy**

1. Bot/service `gh` identity for the PR step (needs an org decision, flag
   it, then it's a small code change).
2. CI feedback loop via a `gh pr checks` poller modeled on
   `watchScheduler.ts`'s already-proven failure-isolated poll pattern.
3. Feature-ticket-shaped prompt branch, so `work_type: feature` isn't forced
   through a bug-repro frame it doesn't fit.
4. Structured evidence-bundle viewer in the UI, replacing "read the markdown
   PR body" — the schema and assembler already produce structured data;
   only the viewer is missing.
5. Slack terminal-status webhook on run completion/halt — smallest version
   of "stop babysitting the run."

**Tier 3 — makes it complete**

1. Live Jira fetch, both for the watcher's `TicketSource` and the manual
   Run-modal path — the interface seam already exists; this is the
   credentialed client behind it.
2. Jira write-back (comment/transition) once the same Jira client exists.
3. Deploy step and rollback plan, keyed off the registry's `liquibase`
   flag and each product's actual deploy mechanism (none of which this app
   currently models at all).
4. Per-product secret catalogs, so provisioning doesn't rediscover required
   env vars from the compose file every single run.
5. Recipes for the remaining registry products (`pcrf`, `ffm`, `pms`, `vms`),
   completing what Tier 1 item 6 starts.

## 5. Non-goals and risks

**Non-goals (explicitly out of scope, don't build):**
- A general-purpose SDLC platform for teams other than this one estate —
  the registry, compose conventions, and branch policies are Alepo-specific
  by design; generalizing them is a different, much larger project.
- Replacing human PR review. The system's own product decision is that PR
  review *is* the human gate; adding an approval step inside the run
  contradicts that decision, not extends it.
- Auto-merge. Nothing here should progress to merging a PR without a human
  clicking merge, regardless of how green the evidence bundle is.

**Risks:**
- **Secrets handling.** `sdlc-stack-provisioner` already does the right
  thing (generate with `openssl`, pass as env, never copy a `.env`) — but
  this is enforced only by prompt discipline, not a hook. A future edit to
  that prompt, or a differently-configured agent run, could silently
  regress to copying real secrets into an artifacts directory that's
  `~/.agent-manager/workflow-runs` — outside `~/.claude`, world-readable to
  anything with host access, and long-lived (it's evidence, meant to be
  kept). Worth a `PreToolUse`-style hook analogous to the plan gate/test
  lock, not just prompt text, before this is trusted with more products'
  real credentials.
- **Personal-credential PR pushes.** Until a bot identity exists, every
  agent-authored PR is indistinguishable in git history from the developer's
  own manual commits — this corrupts blame, review-load metrics, and any
  future audit of "which PRs were agent-authored."
- **Cost runaway.** `maxTurns` bounds tool-call count per agent, not
  wall-clock time or token spend, and there is no cross-run daily spend cap
  (only the watcher's `dailyDispatchCap`, which caps ticket *count*, not
  cost — a single expensive stuck ticket dispatched once still burns
  unbounded budget within that one run). An unattended watcher running this
  pipeline overnight has no circuit breaker on spend.
- **Registry drift.** Every field marked `CONFIRM` in `products.yaml` (test
  commands, branch defaults, owner groups) is a first draft per the file's
  own header. Wiring the registry into the runtime path (Tier 1 item 2)
  means a wrong `CONFIRM` value now actively misroutes a ticket instead of
  just failing a schema check — the registry needs its `CONFIRM` entries
  resolved before it's trusted as a routing source, not after.
- **Blast-radius self-classification.** `blast_radius` (which gates whether
  adversarial verification is required) is set by `sdlc-ticket-intake` from
  ticket text, with no independent check. A ticket that under-states its own
  blast radius (a money-path bug described in non-money terms) skips the
  adversarial-verification requirement entirely, and nothing downstream
  catches that omission.
