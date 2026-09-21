import type { WorkflowStep } from '~/types'
import type { Role } from '~~/shared/types/role'

export interface WorkflowTemplateStep {
  agentTemplateId: string
  label: string
  /**
   * `agentTemplateId` values of steps in this same template that follow this one.
   * Absent means "the next step in array order", which is how every template
   * behaved before graphs were expressible here.
   */
  next?: string[]
  /** `agentTemplateId` of the agent that reviews this step's output. */
  monitorSlug?: string
  /** How many times this step may run in one execution. */
  maxVisits?: number
  /** See WorkflowStep.approval. */
  approval?: boolean
  /** The runner enforces this step's stated Review Result; see parseReviewVerdict. */
  verdict?: boolean
  /** See WorkflowStep.gateRole. */
  gateRole?: Role
  /** See WorkflowStep.ownerRole. Whose work the step is; grants nothing. */
  ownerRole?: Role
  /** See WorkflowStep.pr. The runner pushes the branch and opens the PR. */
  pr?: boolean
  /** See WorkflowStep.continuesSession. */
  continuesSession?: boolean
  /** See WorkflowStep.contextMode. */
  contextMode?: 'predecessors' | 'ancestors'
  /** See WorkflowStep.jira. */
  jira?: { transition?: string, comment?: boolean, attach?: boolean, after?: boolean }
  /** See WorkflowStep.testsUnlocked. */
  testsUnlocked?: boolean
  /** Hand this step the review its pull request collected. See WorkflowStep.reviewComments. */
  reviewComments?: boolean
  /** Bring the product's stack up before this step. See WorkflowStep.stack. */
  stack?: 'up'
  /** Drive deploy.sh for this step. See WorkflowStep.deploy. */
  deploy?: { env: string, step: string, app?: string, limit?: string, check?: boolean }
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  icon: string
  steps: WorkflowTemplateStep[]
}

/**
 * Turn a template into real workflow steps. Template steps refer to each other by
 * `agentTemplateId`; the workflow they become refers to generated step ids, so every
 * `next` has to be translated through the same map.
 *
 * `agentSlugByTemplateId` must have an entry for every step passed in - the caller
 * filters out steps whose agent template could not be resolved before calling. A
 * `next` naming a template step that got filtered out this way (or that never
 * existed) has its target dropped rather than surviving as `undefined`/`null`.
 */
export function materializeTemplateSteps(
  template: WorkflowTemplate,
  agentSlugByTemplateId: Record<string, string>,
  existingIds?: string[],
): WorkflowStep[] {
  // The global crypto, not node:crypto - this module is bundled for the browser too.
  //
  // One id per STEP (by index), not per `agentTemplateId`: a template that uses the
  // same agent template in two steps must not collapse them onto the same generated
  // id, or the repeated step becomes unreachable (stepById()/indexOf() only ever
  // resolve the first match).
  // Keep ids by position when a saved workflow of the same shape exists: a
  // re-sync that renamed every step would orphan every run recorded against it.
  const reuse = existingIds && existingIds.length === template.steps.length
  const stepIds = template.steps.map((_, i) => (reuse ? existingIds![i] : crypto.randomUUID()))

  // Still keyed by `agentTemplateId`, because that's what a `next` entry names.
  // If an `agentTemplateId` repeats, the last step wins as the translation target -
  // an inherent ambiguity of naming a step by its agent rather than by index, not
  // something this function can resolve on the template author's behalf.
  const stepIdByTemplateId: Record<string, string> = {}
  // stepIds is generated with exactly one id per step just above, so indexing
  // always hits - but indexing is `T | undefined` to the checker, and a
  // silently-undefined step id would produce a workflow whose edges reference
  // nothing. Assert the invariant rather than paper over it.
  template.steps.forEach((step, i) => {
    const id = stepIds[i]
    if (!id) throw new Error(`materializeTemplateSteps: no id generated for step ${i}`)
    stepIdByTemplateId[step.agentTemplateId] = id
  })

  return template.steps.map((step, i) => {
    const materialized: WorkflowStep = {
      id: stepIds[i]!,
      agentSlug: agentSlugByTemplateId[step.agentTemplateId]!,
      label: step.label,
      ...(step.approval ? { approval: true } : {}),
      // A review step's stated verdict is enforced by the runner. Carried like
      // the flags below: dropping it here would disarm the gate silently, which
      // is how a `FAIL` came to ship five runs in a row.
      ...(step.verdict ? { verdict: true } : {}),
      // Only meaningful alongside `approval`, but carried whenever the template
      // sets it: a step that declares whose gate it is should not silently lose
      // that when someone later toggles `approval` back on.
      ...(step.gateRole ? { gateRole: step.gateRole } : {}),
      // Carried for the same reason gateRole is: a step that declares whose
      // work it is must not lose that on the way to the workflow the runner
      // reads. A field missing from this whitelist is dropped in silence -
      // which is how `jira.after` once worked in the template and was absent
      // from the seeded JSON.
      ...(step.ownerRole ? { ownerRole: step.ownerRole } : {}),
    }
    if (step.next) {
      const resolved = step.next
        .map(target => stepIdByTemplateId[target])
        .filter((id): id is string => id !== undefined)

      // If every declared target was filtered out, this step's `next` becoming `[]`
      // would silently truncate the workflow here (buildGraph treats an explicit
      // empty `next` as terminal - it does NOT fall back to array order the way an
      // absent `next` does). That's not what "all my targets disappeared" means, so
      // leave `next` unset instead and let it fall back to array order. An
      // originally-empty `next` (an explicit terminal step) is left as `[]` as-is.
      if (resolved.length > 0 || step.next.length === 0) {
        materialized.next = resolved
      }
    }
    // monitorSlug names an AGENT, not a step, so it resolves through the same
    // agentSlug map the step's own agentSlug does — not through
    // stepIdByTemplateId. Dropped when unresolvable, for the same reason a
    // dangling `next` target is dropped: a monitorSlug naming an agent that
    // does not exist makes every review silently CONTINUE.
    if (step.monitorSlug) {
      const resolved = agentSlugByTemplateId[step.monitorSlug]
      if (resolved) materialized.monitorSlug = resolved
    }
    if (step.maxVisits !== undefined) materialized.maxVisits = step.maxVisits
    if (step.contextMode !== undefined) materialized.contextMode = step.contextMode
    if (step.jira !== undefined) materialized.jira = step.jira
    if (step.pr) materialized.pr = true
    // A field missing from this whitelist is dropped in silence - which is how
    // jira.after once lived in the template and was absent from the seeded JSON.
    if (step.reviewComments) materialized.reviewComments = true
    if (step.stack) materialized.stack = step.stack
    if (step.deploy) materialized.deploy = step.deploy
    if (step.testsUnlocked) materialized.testsUnlocked = true
    if (step.continuesSession) materialized.continuesSession = true
    return materialized
  })
}

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: 'oma-plan-build-review',
    name: 'Work: Parallel Plan, Build, Verify',
    description: 'Investigate and reproduce in parallel, plan from both, implement backend and frontend in parallel, then verify, refine and document.',
    icon: 'i-lucide-git-branch',
    // `agentTemplateId` IS the agent slug here: runbookSteps() builds an
    // identity map (teamSync.ts:207-211), so these resolve directly against the
    // oh-my-agent agents this instance seeds from .agents/agents — no entry in
    // `agentTemplates` is needed, which is why an empty catalogue does not stop
    // this materialising.
    //
    // The shape is oh-my-agent's /work phases with /orchestrate's fan-out:
    // COLLECT (2 lanes) -> PLAN -> IMPL (2 lanes) -> VERIFY -> REFINE -> SHIP.
    // Two waves run in parallel and two steps are joins; `markCompleted` arms a
    // forward target only once EVERY forward predecessor completed
    // (shared/utils/workflowGraph.ts), so each join really waits for its lanes.
    //
    // One agent per step, deliberately: `next` names a step by its
    // `agentTemplateId`, so the same agent twice makes every edge pointing at it
    // ambiguous (materializeTemplateSteps: "the last step wins").
    steps: [
      // COLLECT. Both are entry nodes - no forward predecessors - so the engine
      // starts them together rather than in array order.
      {
        agentTemplateId: 'research-explorer',
        label: 'Research & Prior Art',
        next: ['pm-planner'],
      },
      {
        agentTemplateId: 'debug-investigator',
        label: 'Reproduce & Failing Test',
        next: ['pm-planner'],
        // This step owns the tests, and only this step: it writes the failing
        // regression test that proves the defect, and the test-lock guardrail
        // then freezes tests for every step after it. Unlocking the implementer
        // lanes instead would let the agent that writes the fix also relax the
        // test that judges it.
        testsUnlocked: true,
      },
      // PLAN. A join over both collect lanes, and it needs their evidence, not
      // just the immediately preceding output.
      {
        agentTemplateId: 'pm-planner',
        label: 'Plan',
        next: ['architecture-reviewer'],
        contextMode: 'ancestors',
      },
      // Reviews the plan before any code is written, and fans out to the
      // implementation lanes. No approval: the run is meant to reach QA without
      // a babysitter, and a plan nobody implemented yet is cheap to redo.
      {
        agentTemplateId: 'architecture-reviewer',
        label: 'Plan Review',
        next: ['backend-engineer', 'frontend-engineer'],
        contextMode: 'ancestors',
      },
      // IMPL, in parallel, and genuinely concurrent: each step works in its own
      // lane worktree on its own branch, both merged into the run branch when
      // the wave settles. Split by layer so the lanes do not merge-conflict either.
      {
        agentTemplateId: 'backend-engineer',
        label: 'Implement Backend',
        next: ['qa-reviewer'],
      },
      {
        agentTemplateId: 'frontend-engineer',
        label: 'Implement Frontend',
        next: ['qa-reviewer'],
      },
      // VERIFY. The join over both lanes, and the one human gate: QA owns it, so
      // a developer cannot accept their own verification. `ancestors` because a
      // review that cannot see the plan and the failing test cannot tell whether
      // the change met either.
      {
        agentTemplateId: 'qa-reviewer',
        label: 'Verify',
        // Its stated Review Result is enforced by the runner, like the csup
        // Verify step: SBN-4091's verification found "the branch the PR step
        // would push contains only failing tests and zero production code" and
        // the run carried on to Refine and Docs regardless.
        verdict: true,
        next: ['refactor-engineer'],
        contextMode: 'ancestors',
        approval: true,
        gateRole: 'qa',
      },
      // REFINE, then SHIP. Both run after verification passes, never before: a
      // refactor judged by nothing is how a green suite turns red.
      {
        agentTemplateId: 'refactor-engineer',
        label: 'Refine',
        next: ['docs-curator'],
      },
      {
        agentTemplateId: 'docs-curator',
        label: 'Docs & Handoff',
        // Explicitly terminal: an absent `next` would fall back to array order,
        // and this step being last today is an accident of ordering, not intent.
        next: [],
        contextMode: 'ancestors',
      },
    ],
  },
  {
    id: 'oma-csup-to-pr',
    name: 'CSUP: support ticket to pull request',
    description: 'A customer-support ticket taken to an opened pull request, with the plan, verification and ship decisions owned by three different people.',
    icon: 'i-lucide-life-buoy',
    // Every gate this engine has, used for what it is for:
    //
    //   approval + gateRole  three HUMAN gates, one per persona (below).
    //   monitorSlug          an automated reviewer on each writing step, voting
    //                        CONTINUE / RETRY / ABORT on that step's output.
    //   maxVisits            how many times a step may be re-entered by a RETRY
    //                        vote or a rework before the run gives up.
    //   contextMode          'ancestors' for the steps that judge, so a reviewer
    //                        sees the plan and the failing test, not just the
    //                        step before it.
    //   testsUnlocked        exactly one step owns the tests.
    //   jira                 runner-executed transitions and the outcome comment.
    //
    // The three gates are deliberately THREE ROLES, not one: a developer
    // authorises the plan they are about to implement, QA alone accepts the
    // verification, and the release itself belongs to neither of them.
    // `gateRole` is enforced server-side (requireGateRole), so this is a rule
    // rather than a convention - one person cannot answer all three.
    //
    // The ship gate names `operator`, not `manager`, and the reason is worth
    // recording: this template first said `manager`, which reads correctly and
    // cannot work. A manager holds `answerGate: false` by design ("reads
    // progress across runs, changes nothing"), and `continue.post.ts` checks
    // that capability BEFORE gate ownership - so the one gate the template
    // called theirs returned a 403 that did not even name them as its owner.
    // Naming the operator makes the refusal truthful and keeps the separation
    // that matters: the author does not ship, and neither does the verifier.
    // Giving `manager` the capability instead would widen a role the role
    // model and its tests define as read-only, and would also hand it the
    // queue-clearing that rides on the same capability.
    //
    // Whether a gate actually stops is NOT decided here. `approval` marks a
    // point where a gate MAY fire; shared/utils/oversight.ts decides from the
    // blast radius intake records - docs/ui_parsing flow through, schema and
    // deployment stop, protocol and money refuse an approval with no written
    // reason. That is why step 1 exists: with no radius on the record every
    // gate stops blindly, which is how CSUP-7516 - a money-path change to tax
    // arithmetic - was approved in a single click.
    //
    // CSUP is a cross-product support queue: its tickets land in Billing,
    // Selfcare, CRM, OCS and WSO2 alike, and engineering/registry/products.yaml
    // has no `projects: [CSUP]` entry for that reason. The product therefore
    // comes from the run (a productKey chosen at start, or resolution from the
    // ticket text), never from this template.
    //
    // Every concurrent step gets its OWN git worktree, cut from the run branch
    // and merged back when the wave settles (openLanes/closeLanes in
    // workflowRunner.ts), so a fan-out of writers no longer races on one index.
    // The two implementation steps below are still serial, for a different and
    // unchanged reason: the client change is written against the contract the
    // backend step just settled, so running them together would leave the
    // frontend guessing at it.
    steps: [
      // 1. Runner moves the ticket to In Progress, and the agent records the
      // classification everything downstream reads: work_type and origin pick
      // the base branch (baseBranchFor), blast_radius sets how hard each gate
      // below bites.
      {
        agentTemplateId: 'pm-planner',
        label: 'Intake & Classification',
        next: ['research-explorer', 'debug-investigator'],
        // No Jira config at all any more, and both halves of that are
        // deliberate.
        //
        // The transition is gone because Jira refused it on every run: moving
        // the ticket needs the 'Administer Projects' permission this instance's
        // account does not hold, and a step that reports a 400 every time
        // teaches people to ignore its output.
        //
        // Losing the config entirely is also what makes this step DO its job.
        // The runner performs a step's Jira work INSTEAD of calling its agent
        // unless told `after`, so while a bare `jira` sat here pm-planner never
        // ran, and the classification this step exists to record - work type,
        // origin, blast radius - was never written. Every gate downstream then
        // read "no blast radius recorded yet" and stopped for a person, which
        // is safe and entirely unearned.
      },
      // 2-3. COLLECT, in parallel. One writer in the wave: research reads, and
      // only the reproduction step writes - and what it writes is the test.
      {
        agentTemplateId: 'research-explorer',
        label: 'Prior Art & Customer Impact',
        next: ['architecture-reviewer'],
      },
      {
        agentTemplateId: 'debug-investigator',
        label: 'Reproduce & Failing Test',
        next: ['architecture-reviewer'],
        // The only step that may write tests - and the only step whose output
        // the whole run is later judged against, which is why it is monitored.
        //
        // The comment here used to say every step after this one is "under the
        // plugin's test lock, so the agent that writes the fix cannot relax the
        // test that judges it". That was not true: the runner writes the unlock
        // file into the run worktree and never removes it, and nothing read the
        // diff, so the fix agent could edit the oracle freely. The control now
        // exists (server/utils/testLock.ts) and the honest statement is that
        // the lock is enforced by reading the diff, not by the unlock file.
        testsUnlocked: true,
        monitorSlug: 'qa-reviewer',
        // A defect is reproduced against a running product, and this is the step
        // that reproduces it. The runner brings the stack up from the infra
        // repo's own compose file and takes it down when the run settles, so the
        // agent never has to work out which profile to start or remember to
        // clean up - see server/utils/stackRecipe.ts.
        stack: 'up',
      },
      // 4. GATE 1 of 3 - the plan. Joins both collect lanes and reads their
      // evidence. The DEVELOPER answers: it is their scope and their next step.
      {
        agentTemplateId: 'architecture-reviewer',
        label: 'Plan Review',
        next: ['backend-engineer'],
        contextMode: 'ancestors',
        approval: true,
        gateRole: 'developer',
        // Owner and gate differ here on purpose, and this step is the reason
        // ownership cannot be derived: the work is the architect's review, the
        // decision is the developer's because it is their plan and their next
        // step. Deriving an owner from either field would contradict the other.
        ownerRole: 'architect',
      },
      // 5-6. IMPL, serialized on a real dependency rather than on git: the
      // client change follows the contract the fix settles. Each carries an
      // automated reviewer that can vote it back for another visit.
      {
        agentTemplateId: 'backend-engineer',
        label: 'Implement Fix',
        ownerRole: 'developer',
        // The migration review reads what THIS step did to schema and data, so
        // it is ready the moment this step lands. It used to sit behind the
        // client change and therefore behind the QA gate - a whole agent turn of
        // latency bought for nothing, since the two share no data dependency and
        // write different files. They now run as one wave, each in its own lane.
        next: ['frontend-engineer', 'db-engineer'],
        // Judged by the agent that never writes source. `refactor-engineer` was
        // reviewing this step, and its own contract is behaviour-preserving
        // refactoring - briefed on metrics, not on whether the diff touched the
        // test that judges the fix.
        monitorSlug: 'qa-reviewer',
        maxVisits: 3,
      },
      {
        agentTemplateId: 'frontend-engineer',
        label: 'Implement Client Change',
        // The user-facing half of the fix. Owned by design, gated by nobody:
        // owning a step is not deciding at one.
        ownerRole: 'designer',
        next: ['qa-reviewer'],
        monitorSlug: 'refactor-engineer',
        maxVisits: 3,
      },
      // 7-8. VERIFY, in parallel, each in its own lane worktree. Gate 2 of 3
      // sits on the QA lane: QA alone accepts the verification of someone
      // else's change.
      {
        agentTemplateId: 'qa-reviewer',
        label: 'Verify, Security & Regression',
        ownerRole: 'qa',
        // Its FAIL is the gate. Five runs opened a pull request over exactly
        // this step's "Review Result: FAIL"; the approval flag below only ever
        // asked a PERSON, and a run classified `auto` asks nobody.
        verdict: true,
        next: ['docs-curator'],
        contextMode: 'ancestors',
        approval: true,
        gateRole: 'qa',
      },
      {
        agentTemplateId: 'db-engineer',
        label: 'Data & Migration Review',
        // CSUP-7514's data review reported "Two hard blockers I could not
        // clear" and the run shipped regardless. Enforced now that
        // `db-engineer` carries the same `## Review Result:` output contract
        // `qa-reviewer` does — a step must not be held to a format its agent
        // never declares, which is why the two landed together.
        verdict: true,
        // Schema and migration cost lands on other teams and on future runs,
        // which is the architect's business even though no gate fires here yet.
        ownerRole: 'architect',
        next: ['docs-curator'],
        contextMode: 'ancestors',
      },
      // 9. GATE 3 of 3 - shipping. Joins both review lanes. Opening the pull
      // request is the release decision, and neither the author nor the
      // verifier owns it. The runner then opens that PR and posts the outcome
      // comment with the evidence attached.
      {
        agentTemplateId: 'docs-curator',
        label: 'Evidence, Docs & Pull Request',
        ownerRole: 'operator',
        next: ['refactor-engineer'],
        contextMode: 'ancestors',
        approval: true,
        gateRole: 'operator',
        // The RUNNER opens the pull request (`pr`), then posts the comment and
        // attaches the evidence (`jira.after`) - in that order, so the comment
        // carries the URL. The agent was expected to open the PR and never did:
        // it is a documentation curator, and no agent in the estate opens one.
        //
        // No `transition`: moving the ticket to Dev Done needs the 'Administer
        // Projects' permission this instance's account does not hold, so it
        // failed with a 400 on every run. The comment and the attachments work,
        // and they are the parts a reporter actually reads.
        pr: true,
        jira: { comment: true, attach: true, after: true },
      },
      // 10. AFTER THE PULL REQUEST. The workflow used to end at step 9, which
      // meant it treated review as somebody else's problem: two pull requests
      // from one run collected review comments - a duplicated constant that
      // could drift, and untested security-sensitive escaping - and nothing in
      // the pipeline ever read them. They sat until a person noticed.
      //
      // GATED, and that is the whole design. A review lands minutes after the
      // push, so a step that ran straight after step 9 would open an empty pull
      // request, find nothing and report success - the same hollow success as a
      // ship step that opened no PR at all. The developer releases this gate
      // when the comments are actually in, which is also the person who has to
      // live with the answer.
      //
      // `refactor-engineer` because revising code under review is what it is
      // for, and because `next` resolves by agentTemplateId: an agent already
      // used in this template would make routing ambiguous.
      {
        agentTemplateId: 'refactor-engineer',
        label: 'Address Review Comments',
        ownerRole: 'developer',
        // The runner hands this step the review its pull request collected, as
        // review-comments.json in the run's artifacts, before the agent starts.
        reviewComments: true,
        next: [],
        contextMode: 'ancestors',
        approval: true,
        gateRole: 'developer',
        maxVisits: 3,
      },
    ],
  },
]
