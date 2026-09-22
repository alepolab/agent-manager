# Acceptance-Spec-First SDLC Pipeline

Status: system definition and business requirements, plus a design revised after a
five-lens blind review. Build in progress from section 7.
Date: 2026-09-22

---

## 1. The business

### What the work is

Alepo ships a BSS/OSS suite to telecom operators. The registry
(`engineering/registry/products.yaml`) enumerates roughly twenty products, each
its own repository under `alepolab/`, each with its own owners, branch policy,
stack profile and test commands: CRM, billing, online charging (`ocs`),
charging gateway, PCRF, AAA, provisioning, order management, PMS, FFM,
notifications, self-care, vouchers, mPOS, EMS portals, WSO2, and the shared
infra repo.

Work reaches engineering through three queues, and each is a different
business relationship — which is why one pipeline policy cannot serve all
three:

| Queue | What it is | Who is waiting |
|---|---|---|
| **CSUP** | Customer-support defects, already triaged by GTAC, so they arrive with root cause and evidence | A paying operator, under a support contract |
| **SBN** | SaskTel BSS upgrade stories and change requests | A named project delivery, from product owners |
| **DEVOPS** | Internal infrastructure tasks | Currently escalating to the CTO's queue |

### What the application is

Agent Manager is **Alepo's shared control plane for agentic software
delivery** (`README.md`). One instance serves the team; developers sign in with
GitHub, add a Jira token once, and start runs from a ticket key. It is five
things, not one:

1. **A fleet of twelve role-specialised agents** seeded from `.agents/agents/`
   — planner, architecture reviewer, backend, frontend, mobile, DB, infra,
   debug, refactor, QA, docs, research.
2. **A step-graph runner** (`server/utils/workflowRunner.ts`) that executes
   workflows over them in waves and lanes, with per-run budgets, pause, resume,
   restart-from-any-step-with-a-note, and clone.
3. **An enforcement plugin** (`alepo-engineering`) that ships the guardrails
   *with the repo* rather than with whoever remembered to configure them: plan
   gate, test lock, product registry, evidence-bundle schema, environment
   profiles.
4. **A watch layer** that pulls Jira tickets into runs automatically.
5. **A browser UI** over gates, runs, cost, and drift against the team plugin.

### The goal: Jira to PR, autonomous, end to end

**One autonomous agentic pipeline that carries a Jira ticket through every
phase of the software lifecycle and delivers an opened pull request a human can
approve on sight.** Not a chat assistant, not a code generator invoked by a
developer — a pipeline that takes the ticket and hands back a reviewable,
evidence-backed change without a person driving it between phases.

Replace *"a developer takes a ticket"* with *"a pipeline takes a ticket, and a
human decides whether to ship what came out."*

That trade only pays if the human decision is **cheap and sound**. If the
reviewer has to re-derive trust in the diff, the pipeline has *moved* the work,
not removed it — and it has moved it to the most expensive person in the chain.

**Autonomous is not unsupervised.** The pipeline runs phase to phase without a
person driving it. It still stops, deliberately, where a decision is a
person's to make — and the design's job is to make those stops few, informed,
and correctly owned. A pipeline that stops constantly has not automated
anything; a pipeline that never stops has not been authorised to do anything.

**Where "end" is.** The run's deliverable is an opened pull request. Merge,
release and post-deploy verification are real lifecycle phases and this system
must cover them — but not by holding a run open across them. A run is a
resource-owning, budgeted process; a release is a calendar event spanning many
tickets. They are separate lifecycles that the same platform owns. (This is the
independent conclusion of the operations and architecture reviews below, not a
scoping convenience.)

---

## 2. System definition

"All aspects considered" means the system is defined before it is designed:
who acts, what phases exist, what each produces, who decides, and what is
true today. Everything below is verified against the code; several roadmap
documents describing this system are stale and are not used as sources.

### 2.1 Boundary

| | |
|---|---|
| **In** | A Jira ticket on a watched queue |
| **Out** | An opened pull request carrying an evidence bundle a human can approve on sight, and the ticket transitioned with that evidence attached |
| **Not held open across** | Merge, release, post-deploy. Those are real phases the platform owns as *separate* lifecycles — a run is a budgeted, container-owning process; a release is a calendar event spanning many tickets |
| **Autonomy** | Phase-to-phase unattended. Stops only where a decision is a person's to make |

### 2.2 Actors

Three distinct populations. Conflating them is how the current system ended up
checking *role* where it meant *identity*, and asking *an agent* what a
*person* should have decided.

**Human decision authority** — who may answer a gate. Persisted in
`roles.json`. Six exist today — `developer`, `qa`, `architect`, `designer`,
`manager`, `operator` — and the default for an unlisted login is `operator`,
who may answer anything. That file states the rule for adding one: *"A role
earns a row here only when some workflow declares a gate that is that role's
alone."* The three added below each come with their gate.

| Role | Owns | Exists today |
|---|---|---|
| **Product owner** | Story readiness, acceptance scope, business functionality | **No** — added by this build |
| Developer | Plan and implementation gates | Yes |
| QA | Oracle, verification, test-strategy sufficiency | Yes |
| Architect | Design gates, backend and UI structure | Yes |
| **Security** | Security review verdict, exception grants | **No** — added by this build |
| Manager | Intake, ship | Yes |
| Designer | Accepts user-facing output at the design gate | Yes |
| **CTO** | Threshold escalations only | **No** — added by this build |
| Operator | Backstop for a role nobody on the instance holds | Yes |

**Agent review personas** — the lenses that produce findings. Findings are
input to a human decision and never a verdict on their own.

| Persona | Lens | Exists today |
|---|---|---|
| `pm-planner` | Decomposition, contracts | Yes |
| `architecture-reviewer` | Boundaries, tradeoffs, ADR | Yes |
| **Backend architect** | Data model, API contracts, transaction boundaries, migration safety, sibling callers | Partial — folded into `architecture-reviewer` |
| **UI architect** | Component structure, state ownership, route and information architecture, design-system conformance | **No** |
| `qa-reviewer` | Correctness, coverage | Yes |
| **Security reviewer** | Threat model, authz, injection, secret handling, dependency risk | **No** — zero security pass anywhere |
| **Business-functionality reviewer** | Does this match how the product actually behaves for an operator | **No** |
| **CTO lens** | Cost, precedent, cross-product implication, reversibility | **No** |
| `docs-curator` | Documentation drift | Yes |
| `research-explorer` | Prior art, cited findings | Yes |

**End-user personas** — whose experience is being reviewed. Derived from the
product registry, not invented:

| Persona | Uses | Cares about |
|---|---|---|
| Subscriber | `selfcarenow`, `lum-selfcare` | Can I see my balance, pay, recharge, without help |
| CSR / retail agent | `crm`, `mpos` | Can I resolve this in one call, on one screen |
| Operator admin | EMS portals, `administrator-web` | Can I configure without breaking live service |
| Billing / finance ops | `billing`, `ocs`, `rpm`, `collection-manager` | Is the money right, and provable |
| Network / on-call | `pcrf`, `aaa`, `cgw`, `infra` | Will this page me at 3am |
| GTAC support engineer | All | Can I diagnose this from the logs and the ticket |

A persona review is only meaningful against a real persona login. **Personas
are never self-provisioned or invented** — where the customer has not supplied
one, the gap stays visible and the review is recorded as not performed.

### 2.3 The lifecycle

Ten stages. Status verified against code.

#### Stage 1 — Intake and understanding

| Phase | Produces | Persona | Status |
|---|---|---|---|
| 1.1 Ticket ingestion | The real issue, fetched | — | Covered (`jiraTicketSource.ts:172`) |
| 1.2 Duplicate and prior art | `prior-art.md`, incl. searches unavailable | `research-explorer` | Covered |
| 1.3 Classification and routing | work type, blast radius, product → repos/branch/stack | `pm-planner` | Partial, **defective** — agent-authored, yet it decides whether any human is asked |
| 1.4 **Story enrichment** | The ticket completed from Confluence, past tickets, code and the registry — every unstated assumption made explicit | `research-explorer` | **Absent** |
| 1.5 **Story review and validation** | Ready / not ready, with what is missing named | Product owner | **Absent** |
| 1.6 **Business-functionality review** | Does the request match how the product behaves for this operator | Business-functionality reviewer | **Absent** |
| — | **INTAKE_GATE** — manager | | Exists |
| — | **STORY_GATE** — product owner | | **Absent** |

A ticket that fails STORY_GATE goes back to a person; it does not become an
agent's guess. This is the phase that makes feature work possible at all: the
current pipeline is bug-shaped because it has no way to turn an under-specified
story into something with a definition of done.

#### Stage 2 — Specification

| Phase | Produces | Persona | Status |
|---|---|---|---|
| 2.1 **Scenario creation** | Positive, negative, boundary and error scenarios, enumerated | `qa-reviewer` | **Absent** |
| 2.2 Acceptance criteria | Each scenario as an acceptance row with a stable id | `pm-planner` | **Absent** |
| 2.3 **Test strategy** | Which layer proves which row — unit, integration, UI, visual, security, performance — and what is deliberately not covered | `qa-reviewer` | **Absent** |
| 2.4 Executable binding | Each row mapped to a runnable case in the repo's own framework | `qa-reviewer` | **Absent** |
| — | **SPEC_GATE** — product owner, with QA on test strategy | | **Absent** |

**Negative testing is a first-class output here, not a later afterthought.** A
spec with only positive rows is the most common way a change ships that works
exactly once, on the happy path, with the reported inputs.

#### Stage 3 — Design

| Phase | Produces | Persona | Status |
|---|---|---|---|
| 3.1 **Backend architecture review** | Data model, API contract, transaction boundaries, migration and rollback plan, sibling callers of every changed function | Backend architect | Partial |
| 3.2 **UI architecture review** | Component and state structure, route and IA impact, design-system conformance, responsive and a11y implications | UI architect | **Absent** |
| 3.3 Impact analysis | Every repo, module and consumer the change reaches | `architecture-reviewer` | Partial — `multi_repo` has zero readers |
| 3.4 **CTO review** | Only above threshold: cost, precedent, cross-product implication, reversibility | CTO lens → CTO | **Absent** |
| — | **DESIGN_GATE** — architect; CTO above threshold | | **Absent** |

CTO review must be threshold-routed, not universal. A gate that fires on
everything is a gate nobody reads — the failure this estate has already
recorded once and written down.

#### Stage 4 — Environment

| Phase | Produces | Persona | Status |
|---|---|---|---|
| 4.1 **Stack creation** | The product's profile running and healthy, from a per-product recipe | `tf-infra-engineer` | Partial — six recipes for twenty-three products |
| 4.2 Test data | Personas and fixtures from the customer's real data | — | **Absent** — and must never be invented |
| 4.3 Environment verification | The stack is the right build, not merely up | — | **Absent** |

#### Stage 5 — Baseline and reproduction

| Phase | Produces | Persona | Status |
|---|---|---|---|
| 5.1 Failing oracle (bug) | `oracle-before.xml`, parameterised, genuinely red | `debug-investigator` | Covered — strongest control in the system |
| 5.2 Red acceptance rows (feature) | The spec's rows failing for the right reason | `qa-reviewer` | **Absent** |
| 5.3 Regression baseline | The suite's state before the change | — | Covered |
| 5.4 **Visual baseline** | Screenshots of every affected route, at the personas and breakpoints that matter | `frontend-engineer` | **Absent** |
| — | **ORACLE_GATE** — QA | | Exists |

#### Stage 6 — Build

| Phase | Persona | Status |
|---|---|---|
| 6.1 Backend implementation | `backend-engineer` | Covered |
| 6.2 Frontend implementation | `frontend-engineer` | Covered |
| 6.3 Schema and migration | `db-engineer` | Covered |
| 6.4 Infrastructure change | `tf-infra-engineer` | Covered |
| — | **IMPL_GATE** — developer | Exists |

#### Stage 7 — Test

Each row below is a distinct obligation with its own command, its own report
and its own verdict. Today the registry records **one** test command per
product, named `unit`, and 16 of 23 products record it as `CONFIRM`.

| Phase | Proves | Status |
|---|---|---|
| 7.1 **Unit testing** | The changed unit behaves | Partial — command unknown for 16/23 products |
| 7.2 **Integration testing** | The change works across module and service boundaries | **Absent** — no registry key exists |
| 7.3 **Positive-path testing** | Every positive acceptance row passes | **Absent** |
| 7.4 **Negative-path testing** | Every negative row fails *correctly* — right error, right code, no partial write | **Absent** |
| 7.5 **UI functional testing** | The route does what the story says, as the right persona | **Absent** — Playwright is a dependency, one smoke file exists |
| 7.6 **Visual QA** | No unintended visual change; intended changes reviewed | **Absent** |
| 7.7 Accessibility | WCAG AA on changed surfaces | **Absent** |
| 7.8 **Security testing** | Dependency, secret, and dynamic checks | **Absent** |
| 7.9 Performance / regression | No regression in the touched area | Partial |

**Framework position — take what is already installed.** Playwright `^1.62.1`
is already a dependency of this repo, and it covers 7.5, 7.6 and 7.7 in one
tool: functional E2E, built-in screenshot assertions for visual regression, and
`@axe-core/playwright` for accessibility. Adding a hosted visual-diff service
buys a review UI this system already needs to build for its own gate screen.
The recommendation is Playwright for all three, and no new vendor.

#### Stage 8 — Review, multi-persona

| Phase | Lens | Status |
|---|---|---|
| 8.1 Code review | Correctness, reuse, simplification | Covered |
| 8.2 **Security review** | Threat model, authz, injection, secrets, dependency risk | **Absent** |
| 8.3 **UI review** | Design-system conformance, interaction cost, information hierarchy | **Absent** |
| 8.4 **Persona reviews** | Each affected end-user persona from §2.2 | **Absent** |
| 8.5 Documentation review | Drift | Covered |
| — | **VERIFY_GATE** — QA, never the actor who answered IMPL | Exists, role-only |
| — | **SECURITY_GATE** — security role, above threshold | **Absent** |

Reviews run **blind**: each lens sees the artifact and the diff, not the
authoring rationale, not prior approvals, and not each other's findings. The
value of a panel is independence; a panel given the author's reasoning
rationalises alongside them. This is not theory — it is how the fourteen
defects in §5 of this document were found.

#### Stage 9 — Evidence and ship

| Phase | Status |
|---|---|
| 9.1 Evidence bundle assembly | Covered — strong |
| 9.2 Ship integrity, re-derived from git | Covered |
| 9.3 Branch, commit, pull request | Covered |
| 9.4 **SHIP_GATE** — manager | Exists |
| 9.5 Ticket write-back and closure | Covered |

#### Stage 10 — Post-PR (separate lifecycles)

| Phase | Status |
|---|---|
| 10.1 CI watch | Partial — visibility only |
| 10.2 PR review-comment resolution | Partial |
| 10.3 Merge | Human, out of pipeline |
| 10.4 Trunk verification | **Absent** |
| 10.5 Release / deploy | Capability exists, **unwired to any template** |
| 10.6 Post-deploy verification | **Absent** |
| 10.7 Rollback | **Absent** |
| 10.8 Production feedback into the queue | **Absent** |

### 2.4 Gate inventory

| Gate | Owner | Routing |
|---|---|---|
| INTAKE | Manager | Always stop — it establishes the tier |
| **STORY** | Product owner | Always stop for `feature` / `change_request` |
| **SPEC** | Product owner + QA | Stop; skip only for registry-declared spec-exempt work |
| **DESIGN** | Architect | Threshold on blast radius and repo count |
| ORACLE | QA | Auto for `docs` / `ui_parsing`, stop otherwise |
| IMPL | Developer | Auto / stop / justify by blast radius |
| VERIFY | QA, never the IMPL actor | Stop except `docs` |
| **SECURITY** | Security | Threshold: any authz, crypto, PII, payment or dependency change |
| SHIP | Manager | Stop except `docs` / `ui_parsing` |
| **RELEASE** | Manager, release-scoped | Separate lifecycle |

Five of the ten do not exist. Three of the five that do are defective in the
ways §5 documents.

### 2.5 Cross-cutting

| Concern | Status |
|---|---|
| Human gating and authority | Partial, defective — role not identity; tier from an agent-written string |
| Cost and budget | Covered |
| Secrets | Covered |
| Failure, retry, handoff | Covered |
| Audit trail | Covered |
| Multi-repo as one unit | **Absent** — registry flag has zero readers |
| Queue concurrency | Partial — dispatch capped, in-flight unbounded |
| Test data governance | **Absent** — no rule preventing invented fixtures |

---

## 3. Business requirements

Numbered, testable, each with the decision it constrains. These are
requirements on the *system*, not tasks.

### Trust and evidence

- **BR-01** — Every gate criterion must resolve to a machine-derived fact with
  provenance: source, source hash, commit, worktree hash, run count. A
  criterion that cannot be derived **fails closed**; it is never passed on an
  agent's assertion.
- **BR-02** — A verdict captured against a tree that has since changed is
  `stale` and is never a pass. Uncommitted changes count.
- **BR-03** — No single test run is evidence. The existing three-run
  determinism floor applies to every verdict, not only the oracle.
- **BR-04** — For any completed run, a person who was not present can answer,
  from the record alone: what it was supposed to do and who agreed; what proves
  it; who decided to ship and on what basis; whether it reached production. Any
  unanswerable → the run is not done.

### Authority and gating

- **BR-05** — A gate is answered by the role that owns it. The actor who
  answered IMPL may not answer VERIFY. Where an instance has nobody in a role,
  the operator backstop applies and the record says so — it never silently
  reattributes.
- **BR-06** — Whether a human is asked must never be decided by a value an
  agent wrote. Blast radius is derived from the diff or set by a person.
- **BR-07** — An approval on an owner-gated change carries a written reason.
- **BR-08** — An agent panel produces findings, never verdicts. No model
  blocks or approves a human gate.
- **BR-09** — Review panels run blind: no authoring rationale, no prior
  approvals, no cross-visibility between lenses.

### Specification and scope

- **BR-10** — No implementation step runs before a human has approved a
  definition of done, except for work a **registry-declared** exemption covers.
  The exemption is never elected by the run.
- **BR-11** — An acceptance spec enumerates positive, negative and boundary
  scenarios. Positive-only is rejected at SPEC_GATE.
- **BR-12** — Every acceptance row binds to a runnable case, and the gate
  screen shows the case's source next to the row's sentence.
- **BR-13** — Once approved, the spec and the cases it names are immutable for
  the run. Re-opening is an explicit decision that voids prior verdicts.
- **BR-14** — A story that cannot be made ready is returned to a person. It is
  never completed by agent inference.

### Coverage

- **BR-15** — The registry records a command and a machine-readable report
  location for every test class a product supports: unit, integration, UI,
  visual, security, performance. A product without them is **not pipeline-
  eligible**, declared as a registry fact rather than discovered per run.
- **BR-16** — Any change touching a user-facing surface produces a visual
  baseline before and a visual comparison after, reviewed by a person when the
  diff is non-empty.
- **BR-17** — Any change touching authentication, authorisation, cryptography,
  personal data, payment or a dependency manifest triggers security review and
  security testing. Neither is skippable by tier.
- **BR-18** — A change spanning repositories is one unit of work with one
  decision, or it does not dispatch.

### Data and safety

- **BR-19** — Test data, personas and credentials come from the customer.
  Nothing is invented, including when flagged as fake. An absent persona leaves
  the review recorded as not performed.
- **BR-20** — No subscriber identifier, credential or customer datum is written
  to a file, a log, an artifact or a ticket comment.
- **BR-21** — Protected branches are never written. The pipeline pushes to a
  ticket branch and opens a pull request.

### Operations

- **BR-22** — A run is terminal at pull-request-open. Merge, trunk
  verification and release are separate records the platform owns; no run is
  held open across human calendar time.
- **BR-23** — Waiting on a human decision and waiting on an external system are
  distinguishable states, and only the first pages anyone.
- **BR-24** — Every run has a wall-clock, token and spend ceiling. Exceeding it
  **escalates to the owner as a decision**, never silently extends and never
  simply kills the work. Four real runs ratcheted to 9.9M tokens because the
  cap was soft; three steps died at `error_max_turns` because it was hard. A
  ceiling that ends a run is as much a failure as one that does not exist —
  the person is the ceiling, and the system's job is to ask them in time.
- **BR-25** — A control that is not proven armed is treated as absent.
  Enforcement is verified by execution, not by reading configuration.

### Flow and autonomy

- **BR-26** — The pipeline advances phase to phase without a person. Every stop
  must be attributable to a decision a machine cannot derive; a gate that stops
  for anything else is a defect to be removed, not a control to be kept.
- **BR-27** — Anything that can refuse declares where refused work goes. Ending
  the run is a legitimate destination, but it must be **chosen**, not the
  default that happens when no path was modelled.
- **BR-28** — Routing is declared on the edge and visible in the builder.
  Conditional flow expressed as prose an agent emits, and resolved by matching
  that prose against step names, is not permitted: it is invisible to the
  reader, undrawable on the canvas, and fatal on a miss.
- **BR-29** — Conditional arms are alternatives: exactly one is taken, and a
  step made unreachable by the arm not taken is **settled**, never left pending.
  A join must never wait on a step that will not run.
- **BR-30** — No role may be an unbackstopped bottleneck. Every gate an
  instance can reach has an operator backstop, and the record names who
  actually answered rather than who nominally owned it. **A pipeline that
  cannot proceed because one person is unavailable is a defect**, not a
  control — this is what makes a one-person operator viable, and it is the
  requirement most likely to be quietly violated by adding a role.

### Environment

- **BR-31** — A test verdict counts only against a stack stood up at the
  registry's declared topology, with the deployed build identifier recorded
  alongside the verdict. A green suite against an unknown environment proves
  nothing about the change.
- **BR-32** — Which environment a check ran against is a property of the
  **verdict**, not of the test file. A check whose target is decided by
  whatever the file reads at runtime cannot be gated on.

### Design review

- **BR-33** — Any change to a data model, API contract, transaction boundary or
  migration is reviewed before implementation against two questions: is it
  reversible, and were the sibling callers of every changed function checked.
- **BR-34** — Any user-facing change is reviewed for design-system conformance,
  state coverage (loading, empty, error, partial), behaviour at 375px, and
  WCAG 2.2 AA. A screen designed only for the populated happy path is
  incomplete.
- **BR-35** — Every story is checked against how the product behaves today:
  contradiction with a configured rule, duplication of an existing capability,
  and impact on operators other than the requester.
- **BR-36** — Every end-user persona a change reaches is reviewed, or recorded
  as **not performed** with the credential or fixture the customer must supply.
  A persona review against invented data is worse than none: it produces a
  green nobody can trace to a real user.
- **BR-37** — Executive escalation is threshold-routed and rare. A lens that
  fires on every change is invalid and its threshold must be retuned — a gate
  that always fires teaches its owner to approve without reading, which is
  worse than no gate because it looks like oversight from outside.

### Testing

- **BR-38** — A change crossing a module or service boundary requires an
  integration verdict. A unit suite alone is not sufficient evidence for it,
  and "the unit tests pass" must not be reportable as verification of a
  cross-boundary change.

### Release and feedback

- **BR-39** — No release without a declared rollback path and declared
  post-deploy verification, both agreed **before** the deploy runs. A change we
  cannot detect the failure of is worse than one we can roll back.
- **BR-40** — A defect found after release re-enters the same intake,
  referencing the run that shipped it. A pipeline whose knowledge of its own
  changes ends at "merged" cannot improve, and cannot be trusted with the next
  one.

BR-25 is not defensive drafting. This estate has twice discovered a control
enforcing nothing at the moment it was most trusted.

### Traceability: which of these actually hold today

Written is not built. Status as of this commit, verified against the code
rather than intent.

**Satisfied, with a runnable check**

| BR | By what |
|---|---|
| BR-05 | `checkGateSeparation` refuses the actor who approved the implementation from accepting its own verification, with a recorded backstop where nobody else could (`test-gate-separation.mjs`) |
| BR-06 | Proposal plus path-derived floor plus a light read of the touched files; the floor only raises, and an unavailable read no longer passes as a clean one (`test-risk-read-failure.mjs`) |
| BR-24 | A budget ceiling pauses and asks the owner to grant another allowance — it escalates, it does not kill (`workflowRunner.ts:1935`) |
| BR-30 | Enforced for the control most likely to violate it: separation yields to a backstop rather than stranding a one-person instance |
| BR-07 | `continueRun` refuses an unreasoned approval; now gate-kind aware (`test-gate-kinds.mjs`) |
| BR-27, BR-28, BR-29 | Conditional edges: a refusal routes, routing is declared on the edge, one arm is taken and the other settled (`test-conditional-edges.mjs`) |
| BR-37 | The executive gate tiers rather than floors, asserted so it cannot quietly become a checkpoint (`test-sdlc-template.mjs`) |

**Satisfied by controls that already existed**

| BR | By what |
|---|---|
| BR-20 | `secrets-guard` hook — it blocked this session three times |
| BR-21 | `branchPolicy` refuses `main`, `develop`, `ci-release` |
| BR-22 | A run is already terminal at pull-request-open |
| BR-25 | `verify-enforcement.mjs` proves a control armed by executing it |

**Partial — the mechanism exists, the data or the wiring does not**

| BR | What is missing |
|---|---|
| BR-06 | Mostly built, and better than this document first claimed: `classification.ts` takes an agent's proposal, derives a floor from the paths actually touched, adds a light model read of those files for the risk no path rule can see, and lets the floor only ever RAISE. The residual — an unavailable risk read reading as a clean one — is now closed. What remains is that a low class still rests on a proposal when the read succeeds and finds nothing, which is the honest limit of the evidence |
| BR-11, BR-33, BR-34, BR-35, BR-36 | The review personas are written as definitions but **are not seeded**, so nothing runs them |
| BR-15, BR-38 | The registry can now record per-class commands and report locations, and reports eligibility — but 16 products still read `CONFIRM` and 22 of 23 declare no report location |
| BR-17 | A security gate exists in the template; **no scanner is wired behind it** |
| BR-18 | The flag propagates — registry to `ProductMatch` to the artifact header's merge-order instruction — but nothing enforces **one decision** across the set |
| BR-23 | Not currently live: it only bites if a run is held open across merge, and BR-22 already keeps runs terminal at PR-open. It becomes real if the release lifecycle lands |

**Not built**

| BR | Why it matters |
|---|---|
| BR-01 – BR-04 | The fact-provenance substrate. Without it a gate still shows prose |

| BR-10, BR-12, BR-13, BR-14 | The acceptance-spec pipeline |
| BR-16 | Visual baselines: no capture, no comparison |
| BR-19 | Nothing yet prevents an invented fixture |
| BR-26, BR-30 | Autonomy and the operator backstop as enforced properties |
| BR-31, BR-32 | Environment as a property of a verdict |
| BR-39, BR-40 | Rollback, post-deploy verification, production feedback |

**Count: 12 satisfied with a runnable check, 4 more resting on controls that
predate this work, 10 partial, 14 not built.**

Four of those twelve moved because the code was read properly rather than
because anything was built: BR-06 and BR-24 were already satisfied and this
document said otherwise, and BR-18 and BR-23 were over-claimed as absent. Two
mis-traces in one table is a pattern, not an accident — the first version was
written from this document's own assumptions instead of from the controls it
describes, which is the exact failure mode the pipeline exists to prevent,
committed by the review of it.
The requirements are complete as a specification. They are roughly a quarter
implemented, and the largest single gap — BR-01 to BR-04 — is the substrate
everything in the "not built" column sits on.

---

## 4. Problem statement

**The pipeline can produce a change. It cannot yet produce a change a manager
can sign off on without redoing the work — so it stays in shadow, and a system
that is built and largely working returns nothing.**

The mechanism underneath that: an agent pipeline emits claims faster than
anyone can check them. The verdicts that gate shipping therefore rest on prose,
which means nobody can say, of a completed run, what is actually true about it.
Every hour of review that goes into re-deriving trust in a diff is an hour the
automation was supposed to save, spent by the most expensive person in the
chain.

### The evidence

Not measured here: this machine holds 768 run directories, all of them test
fixtures (`identity: "test-owner"`, `workflow: "Demo"`), and **zero** non-test
runs with an evidence bundle. The empirical base below is the estate's own
recorded postmortems, each written into the control that was added in response,
each citing real tickets.

| Source | What happened |
|---|---|
| `shipIntegrity.ts:18-38` | Three runs finished `completed` while claiming more than their repositories could show. **CSUP-7526**: the fix sat on three unmerged lane branches; the only PR was in a different repo. **CSUP-7524**: a step reported "three build-breaking findings closed and verified" with local HEAD two commits ahead of the branch the PR came from — the review was of code the reviewer could not fetch. **SBN-4091**: six commits, no pull request, recorded as a completed run twice. |
| `evidenceContract.ts:8-13` | A review of 13 completed runs found the bundle contract honoured by **under half**, and no `meta.json` schema anyone could rely on. |
| `ciPoller.ts:24-28` | Of those same 13 runs, **not one** could answer "did this ship?" The record ended at "checks passed", which is a different fact. |
| `testLock.ts:11-18` | "The fix must not edit the test that judges it" had **no implementation**, and the CSUP template told readers the opposite was guaranteed. |
| `verify-enforcement.mjs:16-20` | The test lock "was registered and enforced nothing for weeks because its arming marker was never written outside its own tests." |
| `dockerReap.ts` | 116 images and containers, 150 GB, still running six days after their runs ended. |

### What the pattern actually is

Every one of those controls is sound, and every one was added after a specific
incident. The failure mode is not *missing controls*. It is:

1. **Controls that are believed to be in force and are not.** Twice now a
   control has been found enforcing nothing at the moment it was most trusted.
2. **Verdicts that read as verified and are not.** A step's prose saying it
   checked something is indistinguishable, in the record, from it having been
   checked.
3. **Coverage that stops where the cost rises.** The pipeline runs ticket → PR.
   Requirements, design, release, post-merge and rollback have no gate at all —
   so the phases where a wrong answer is most expensive are the ungoverned ones.
4. **Authority routed off an agent's own output.** Gates check role, never
   identity, and the oversight tier that decides whether a human is asked is
   read from a string the intake agent writes.

### What "solved" means

For any completed run, an engineer who was not present can answer these four
questions from the record alone, without re-deriving trust in the diff:

1. **What was this supposed to do, and who agreed to that?**
2. **What proves it does it — and was that proof produced by a machine, at a
   named commit, over a tree that has not moved since?**
3. **Who decided to ship, on what basis, and were they in a position to have
   decided otherwise?**
4. **Did it actually reach production, and is it still true there?**

If any of the four cannot be answered from the record, the run is not done.
That is the bar the design below is measured against.

### Non-goals

- **Removing humans.** The target is fewer, better-informed decisions — not
  fewer decision-makers.
- **Throughput.** A faster pipeline that ships unverified changes is worse than
  the manual process it replaces.
- **Replacing judgment with rules.** Machines answer what is derivable; people
  answer what is not. The design fails if it asks a person to certify something
  a machine could have derived, or asks a machine to certify something only a
  person can judge.

---

## 5. The design under review

A design for turning the run pipeline from a ticket-to-PR automation into a
whole-lifecycle SDLC fulfillment system, where a single approved, executable
acceptance spec governs every verdict and every human gate is a projection of
it.

The first draft of this design was reviewed by five independent fresh-context
reviewers (architecture, QA, security, operations, product), each given only
the design document and the repository — not the authoring rationale, not each
other's findings. They returned fourteen Tier-1 defects. Every one was verified
against the code before being accepted. This document is the revision.

**The headline finding: spec-first is the right idea and cannot be built
first.** Roughly half of what makes it safe is a generic fact-and-gate
substrate that must exist underneath it, and four prerequisites must land
before any of it. The layering below is the resolution.

---

## 6. Verified defects in the first draft

Each was confirmed by reading the code, not by accepting a reviewer's summary.

### The governing spec was placed where every write control is blind

`engineering/hooks/oracle-paths.mjs:34-38` exempts
`workflow-runs/<id>/artifacts/` from the test lock and the plan gate *by name*,
with the stated reason that "a control must not be able to lock itself, or its
own evidence trail, out". `test-lock-arm.mjs:72` skips arming there too. The
first draft put `spec.md` and `spec-rows.json` in exactly that directory.

It is also not a git repository (`runArtifacts.ts:73`), so `testLock.ts`'s
`changedPathsSince` — which reads `git diff` plus `git status --porcelain` in
the *checkout* — can never see it. A widened pattern list would not help: git
in the worktree will never emit that path, so the lock returns a clean pass,
not `indeterminate`.

And `testLock.ts:81` excludes markdown by construction, so `spec.md` could not
be locked even if it lived in the repo.

Concrete failure with no attacker: an implementation step that cannot get AC-3
green does not touch the test — the hook would deny that — it repoints AC-3's
`oracle.testName` at a sibling test that already passes. No hook fires, no
`git status` shows anything, the recomputed sha is internally consistent, and
VERIFY reports every row green about a different question than the human
approved.

### `mustFailBefore` made a no-op run trivially green

The flag is set by the spec's authoring agent. A spec with zero
`mustFailBefore` rows satisfies every SPEC_GATE criterion vacuously: "every
`mustFailBefore` row fails on unmodified code" is true over the empty set, and
"≥5 rows with resolvable oracles" is satisfied by five already-green tests.
The run then ships a no-op with every gate green and, at `auto` tier, no human
asked.

Today that run dies: `validate-bundle.mjs:137-140` rejects any bundle whose
pre-fix oracle verdict is not `FAIL`, unconditionally, with no author-controlled
predicate. The row model replaced one non-negotiable machine fact with N facts
gated on a flag the agent writes.

Even with the flag set, `mustFailBefore` is satisfiable by any row referencing
a symbol the fix introduces — a `ReferenceError` pre-fix is a failure, and
reproduces nothing.

### Nothing binds a row's statement to what its oracle asserts

`AcRow` pairs a prose `statement` with `oracle: {repo, file, testName}`. No
criterion checks that the named test asserts the statement. `expect(typeof
rateCall).toBe('function')` resolves, fails pre-fix, passes post-fix, and
satisfies every machine check while testing nothing. The human is shown only
the sentence, and their approval then *freezes an unread agent artifact as the
definition of done under their name* — a regression in honesty over today,
where nobody claims the oracle was human-approved.

The blind panel cannot catch it either: the draft denied the panel the test
bodies, while asking it "which row would still pass if the defect were
unfixed", which is unanswerable without them.

### The escape hatch did not exist, and where it would have existed it exempted everything

`server/utils/teamSync.ts:467`: *"engineering/registry/watches.yaml still
ships; nothing reads it here."* Asserted again at
`scripts/test-team-sync.mjs:67`. The runtime `Watch` type
(`shared/types/watch.ts`) has no `requires`, no `max_blast_radius`, no
`work_types`. The file's only consumer is the CI linter
`validate-registry.mjs`. So `requires: [spec]` cannot "become satisfiable" and
`spec_exempt` would be inert YAML.

Had it been wired: `watches.yaml:51` caps `bss-change-requests` — the one watch
carrying `requires: [spec]` — at `max_blast_radius: ui_parsing`. A hatch of
`[docs, ui_parsing]` exempts 100% of the only population it was written for.

### The hatch keyed on a value the run's own agent writes

Blast radius is read from `meta.json` in the agent-written artifacts directory
(`workflowRunner.ts:2060-2076`). It already controls whether any human is asked
at all: `oversightFor` maps `docs` and `ui_parsing` to `auto`
(`oversight.ts:42-43`) and `workflowRunner.ts:1877-1878` skips the gate for
`auto`. One string from the intake agent buys no SPEC_GATE, no spec
requirement, and no human at any approval step.

This is not hypothetical and not introduced by this design — it is live today.
See "Pre-existing defects" below.

### SPEC_GATE's "always stop" is unimplementable and was already rejected here

The gate predicate is `oversightFor(run.blastRadius) !== 'auto'`
(`workflowRunner.ts:1877`) — a pure function of blast radius, with no per-step
override. On a `ui_parsing`-capped watch, SPEC_GATE never fires. The claimed
INTAKE_GATE precedent for a tier bypass does not exist in the runner.

And `docs/design-docs/2026-09-16-persona-oriented-gui.md:98` already recorded
the decision against it: *"A per-step 'always stop' override to route around it
would reintroduce the fire-on-everything gates that module exists to kill."*
The draft proposed that override for two gates without superseding the prior
decision.

### Verdict resolution was placed somewhere unreachable

`runWave`'s gate branch sets `run.question` and `return`s
(`workflowRunner.ts:1877-1899`) *before* `executeNode` is called. "executeNode
resolves verdicts before a gate pauses" cannot happen. Moving it into `runWave`
puts test-runner execution, XML parsing, artifact hashing and per-repo
`git rev-parse` into the scheduling loop, on every wave, in front of a
`publish()` that already serialises per-run writes.

The advertised saving is also absent: for `auto` tiers no gate fires today, so
"VERIFY needs no human at 100%" removes zero humans; for `stop`/`justify`
tiers, VERIFY still stops on partial/stale/flaky/missing. No gate is
eliminated. Net gate count for a `schema` bug goes from 5 stops to 7.

### Post-merge terminality deadlocks and leaks

`ciPoller.pollOnce` skips any run that is not `completed` or `failed`
(`ciPoller.ts:175`), and `merged_sha`/`merged_at` are produced only there. A
run held non-terminal until merge waits on a poller that skips it because it is
waiting.

Worse, `publish()` hangs five operational side effects off `TERMINAL_STATUSES`
(`workflowRunner.ts:561-600`): `takeStackDown`, `reapRun(apply: true)` — the
only production caller of the docker reaper — `withdrawTestUnlocks`,
`finalizeRunArtifacts`, and the Jira outcome comment. Deferring terminality by
days re-creates, on the happy path, the leak `dockerReap.ts`'s own header
records: 116 containers and images, 150 GB, six days after their runs ended.

Then the scheduler: a merge-waiting run holds a `maxConcurrentRuns` slot
(`watchScheduler.ts:225-226`) for days, and with caps of 1-3 two unreviewed PRs
silently stop a watch dispatching anything. And a failing post-merge row marks
the run `failed` → `recordFailure` → re-dispatch from intake up to
`MAX_ATTEMPTS`, opening more PRs for a fix already on trunk, whose
`mustFailBefore` rows now pass on unmodified code.

### Release-as-a-run-gate does not match how releases happen

`UNATTENDED_ENV = 'dev'` is the only environment reachable without approval
(`deployStep.ts:44`), and there is no environment lease anywhere — `planDeploy`
and `runDeploy` are stateless, `stackLifecycle` locks nothing. The row "the
deployed build sha equals the merged sha" therefore detects concurrency, not
correctness, and flaps with queue depth.

BSS releases are batched, scheduled events spanning many tickets. A per-run
RELEASE_GATE with `stop` on every tier means runs park indefinitely, or get
force-completed and the phase is theatre. There is no notion of a release spec
spanning runs.

Separately: because the gate is a *projection*, the release rows must already
have executed to produce verdicts — so agent-authored code has connected to a
real environment, with the run's real `GH_TOKEN`/`JIRA_API_TOKEN`
(`users.ts:187-222`), before the human gate that was supposed to authorise it.
`AcRow` carries no environment binding, so which estate a row reaches is
decided by whatever the test file reads at runtime.

### The row model cannot be derived from what this estate emits

- 16 products in `engineering/registry/products.yaml` carry `unit: 'CONFIRM'`
  — the test command is unknown, never mind a per-case report.
- `assemble-bundle.mjs:193-208` `parseXunit` matches `<testsuite>` tags and
  sums attributes; it never reads `<testcase>`. `app/utils/junit.ts` does, but
  is browser-only (`DOMParser`) and not importable from the validator. There is
  no per-case parser in the trusted root.
- This repo's own 90 tests are plain-node `assert` scripts that emit one
  `console.log` line and abort at the first failure. Rows 2..N produce no
  report line at all and are `missing` even when they would pass.
- `oracle` carries one singular `testName`, which cannot address a
  framework-parameterised 6-case test. Either you split into six named tests —
  violating "uses the repository's existing framework and conventions" — or six
  rows point at one test and every row verdict collapses to one boolean.

### Two machine-enforced controls were silently dropped

- **Three-run determinism.** `evidence-bundle.v0.1.schema.json` puts
  `"minimum": 3` on `oracle_run.runs` with the description *"A verdict from a
  single run is not evidence."* `SpecVerdict` has no run count, so a single
  capture yields exactly `pass` or `fail`.
- **`flaky` has no producer.** `assemble-bundle.mjs:274` computes
  `failed > 0 ? 'FAIL' : 'PASS'` — two values. `validate-bundle.mjs` only
  *rejects* the string `FLAKY`; nothing emits it. The draft cited it as an
  existing capability.

### `stale` was defined over commits, so uncommitted work invalidated nothing

`head` is a commit. `testLock.ts:118-138` deliberately reads both
`git diff since..HEAD` *and* `git status --porcelain`, because "either alone
lies: a step that never committed has still changed the tree". Comparing
`verdict.head` to `HEAD` sees none of the working tree — capture green, edit
source without committing, and VERIFY reads 100% green against a tree that was
never evaluated. `sourceSha` hashes the report, not the tree.

### The bundle contract is unconditional

`BUNDLE_CONTRACT_FILES` (`evidenceContract.ts:30`) applies to every workflow.
Adding the spec files there makes every `csup-bugs`, `devops-tasks` and
`oma-plan-build-review` run report two missing contract files forever. The doc
comment fifty lines below names this exact move as the mistake the list already
makes. A per-workflow conditional contract does not exist.

---

## 7. Revised architecture: four layers, in order

The resolution to almost every defect above is that the spec cannot be the
first thing built. It sits on a substrate.

### Layer 0 — prerequisites (no spec work)

None of these are spec features. All are blockers for one.

| # | Work | Why |
|---|---|---|
| P1 | Make `watches.yaml` a runtime source: add `requires`, `maxBlastRadius`, `workTypes`, `specExempt` to `shared/types/watch.ts` and read them in `watchScheduler.ts` — **or** drop the registry framing and put per-workflow policy on the template, where `materializeTemplateSteps` already whitelists fields | Without it there is no registry-side control of any kind, and today's `max_blast_radius`/`daily_dispatch_cap` caps may not be in force either |
| P2 | Per-repo report contract in `products.yaml`: `report_glob`, `format` (`surefire`/`pytest`/`jest`/`go`), and resolve the 16 `unit: 'CONFIRM'` entries. A repo without it is **not spec-capable**, as a registry fact | Otherwise every row is `missing` per-run and the pressure goes to the hatch |
| P3 | A per-case report parser in the trusted root, with name normalisation across the four frameworks | `parseXunit` cannot see `<testcase>`; `junit.ts` is browser-only |
| P4 | Fix `validate-registry.mjs:254` — its `ORDER` omits `deployment`, disagreeing with `oversight.ts:26` | Pre-existing; a `deployment`-class ticket is ordered differently by the two files |

### Layer 1 — the fact-and-gate substrate

Generic, spec-independent, and useful on its own. This is what makes any gate
criterion machine-derived.

- **Facts carry provenance**: `source`, `sourceSha`, `head`, **`treeHash`**,
  **`runs`**. A fact without provenance is not a fact.
- **Staleness is defined over the worktree, not the commit.** Reuse
  `changedPathsSince` — the estate's one correct answer to this question.
  `stale` when `head` differs *or* `git status --porcelain` is non-empty at
  capture or evaluation.
- **`indeterminate` is a status**, and it blocks. Carried over from
  `testLock.ts`'s third position, which the draft praised and then dropped.
- **Three-run determinism survives**: `runs >= 3`, `pass` only when all agree,
  `flaky` on disagreement, per-run report shas recorded so "3 runs" is
  checkable rather than declared.
- **Resolution happens in a step, not the scheduler.** The runner already
  supports a `verdict: true` step whose stated result it enforces. A resolver
  step runs the checks and writes `spec-verdicts.json`; the gate renders it.
  Gates stay dumb, the runner stays a scheduler, and the expensive failure-prone
  work keeps its retries, `maxVisits`, monitor, watchdog and cost record.
- **Oversight becomes `f(blastRadius, gateKind)`** in `oversight.ts`, a visible
  policy table with a `stop` floor for spec and release gates — not a per-step
  bypass, which this repo already rejected in writing. The cost is stated
  explicitly: a spec-requiring queue stops at least twice per ticket regardless
  of risk.
- **Blast radius stops being agent-authored where it decides whether a human is
  asked.** Either derive it from the diff by path rules, or make it a human
  decision at INTAKE. This fixes a live defect, not just a designed one.

### Layer 2 — the acceptance spec

Only now, and only for repos P2 marked spec-capable.

- **Approved rows and their sha are server state** in `workflowRunStore`,
  written by the server process. The artifact copy is a *rendering*, never the
  authority. `isExemptPath` stops covering spec files.
- **`mustFailBefore` becomes an aggregate requirement and a transition
  assertion**: at least one row must carry it for any `work_type: bug`; the row
  must have a recorded red capture at the pre-fix head and a green one at the
  final head, both retained. A terminal green state never counts on its own.
  A pre-fix failure that is a resolution or compile error reproduces nothing
  and does not satisfy the flag.
- **`validate-bundle.mjs:137`'s unconditional pre-fix-FAIL check stays.** The
  row table is added alongside it, not in place of it. The two check different
  things.
- **The statement-to-oracle binding is shown, not asserted**: SPEC_GATE renders
  the oracle's actual source next to the statement, and the blind panel
  receives the test bodies — without them its central question is unanswerable.
- **Rows address cases, not just tests**: the oracle reference must be able to
  name a parameterised case, or the row count collapses to a boolean.
- **The hatch binds to the watch**, resolved before any agent runs — never to
  the run's own classification.
- **`BUNDLE_CONTRACT_FILES` becomes per-workflow conditional** before any spec
  file joins it.

### Layer 3 — lifecycle, restructured

The draft's §5 and §6 are withdrawn and replaced.

- **The run stays terminal at PR-open.** A run is a resource-owning,
  budgeted, scheduler-slot-consuming, container-owning process lifetime. It
  must not be redefined as a business-outcome lifetime spanning human calendar
  time.
- **The trunk verdict is a separate, cheap, long-lived record** keyed by
  `ticketKey + merged_sha`, owned by the poller. It can go red with no run to
  resurrect, and it is assignable to a human or a fresh run. This touches
  neither `publish()`, nor the scheduler, nor the concurrency budget.
- **`shipIntegrity` stays where it is.** Its `dirty` and `lane-orphan` findings
  are pre-merge detectors; a trunk re-run would catch those cases only after
  someone merged an incomplete PR.
- **Release is release-scoped, not run-scoped**: its own record and gate,
  spanning the many tickets in a batched release, matching how BSS actually
  ships. Release rows are declared read-only, and the assertion target comes
  from the deploy plan or registry — never from the row.
- **Merge-waiting is not a gate.** `sweepWaitingGates` must be able to tell
  "a human must act" from "waiting on GitHub", or a three-day review generates
  36 pages for a gate nobody can answer.

---

## 8. Explicitly out of scope

Named because the draft implied the hatch covered them and it does not. None of
these can express up-front executable rows, and no mitigation is proposed:

- **Infra and ops work** — the whole `devops-tasks` watch. "The cert on host X
  is renewed" has no counterpart in a repo test framework.
- **Non-deterministic work**: races, timing, load, performance. `flaky` is
  structurally not-a-pass, so a fix to an intermittent defect can never produce
  an all-`pass` spec.
- **One-shot data repairs and migrations** — not idempotent, not re-runnable on
  trunk.
- **Security fixes where the reproduction is the exploit** — `mustFailBefore`
  would require committing a working demonstration and circulating it to a
  review panel.
- **Defects observable only against a live peer system** (provisioning against
  a real OSS/CRM/network element) — change-spec rows are checkout-only.
- **Vendored, generated or legacy code with no harness**, and any change whose
  evidence is a screenshot or a customer confirmation.
- **Multi-ticket / epic work** — the spec is per-run; there is no composition.

---

## 9. Pre-existing defects found during this review

Independent of whether this design is built.

1. ~~**An agent-written string decides whether any human is asked.**~~
   **Corrected.** This document asserted it twice and it was wrong.
   `shared/utils/classification.ts` already implements proposal-plus-floor: the
   runner derives a floor from the paths the change actually touched, adds a
   light model read of those files for the danger no path rule can see, and
   `adopt` lets the floor only ever RAISE the class. It ratchets, so no later
   step can lower what evidence established.

   The real residual was narrower and is now fixed: `agentFloorFrom` returned
   `string | null`, so an unavailable model was indistinguishable from a clean
   read — and since a LOW class rests entirely on the proposal (the floor never
   asserts one), a light-agent outage silently switched every gate off for any
   run claiming `docs` or `ui_parsing`. The read now reports whether it
   happened, and an uncorroborated low claim leaves the run unclassified, which
   stops. See `scripts/test-risk-read-failure.mjs`.
2. **`engineering/registry/watches.yaml` is not read at runtime**
   (`teamSync.ts:467`). Whatever safety its `max_blast_radius`,
   `daily_dispatch_cap` and `mode: shadow` entries appear to provide, the
   dispatcher does not get it from that file. Worth confirming where those caps
   actually come from.
3. **Two blast-radius orderings disagree**: `validate-registry.mjs:254` has
   `['docs','ui_parsing','schema','protocol','money']`; `oversight.ts:26` has
   the same plus `deployment`.
4. **Actor separation is partly vacuous**: `authoredBy` is an agent slug and
   approvers are logins (`continue.post.ts:36`), two namespaces that cannot
   collide, so "author ≠ approver" passes for every run and proves nothing in
   the bundle. Meanwhile `roleFor` defaults unlisted logins to `operator` and
   an operator may answer any gate, so an identity-based IMPL≠VERIFY predicate
   would block the only person who can answer either on a small instance.
   Record it honestly as advisory rather than engineering it.

---

## 10. Open decision

Layers 0 and 1 are not the spec. They are the generic fact-provider and
gate-projection substrate — which is the approach this design was chosen over.
The blind panel arrived at it independently from five directions.

So the sequencing question is real: build Layer 0 → 1 first and treat Layer 2
as the payoff, or stop at Layer 1 and judge whether the spec still earns its
cost once gates are already fact-backed.
